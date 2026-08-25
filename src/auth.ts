import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defaults, validateLoginScope, validateOrigin } from "./config.js";
import { loadSession, saveSession } from "./session-store.js";
import { readOwnerOnlySecretFile } from "./secret-file.js";
import type { GlobalOptions, Session } from "./types.js";
import { createRequestDeadline } from "./http-timeout.js";

const execFileAsync = promisify(execFile);
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(""),
});

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

async function openBrowser(url: string): Promise<void> {
  const [executable, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await execFileAsync(executable, args, { windowsHide: true });
}

async function requestToken(
  identity: string,
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<z.infer<typeof tokenSchema>> {
  const deadline = createRequestDeadline(signal, 30_000);
  try {
    const response = await fetch(`${identity}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: deadline.signal,
    });
    const text = await readBoundedResponse(response, 65_536, deadline.signal);
    if (!response.ok)
      throw new Error(`Token endpoint failed (${response.status}).`);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0];
    if (
      !mediaType ||
      (mediaType !== "application/json" && !mediaType.endsWith("+json"))
    )
      throw new Error(
        `Token endpoint returned an unexpected media type '${mediaType ?? "(missing)"}'.`,
      );
    return tokenSchema.parse(JSON.parse(text));
  } finally {
    deadline.dispose();
  }
}

export async function login(
  options: GlobalOptions,
  loginHint?: string,
  scope: string = defaults.scope,
  signal?: AbortSignal,
): Promise<Session> {
  signal?.throwIfAborted();
  const identity = validateOrigin(options.identity, "Identity URL");
  const app = validateOrigin(options.app, "Application URL");
  const api = validateOrigin(options.api, "API URL");
  scope = validateLoginScope(scope);
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(
    createHash("sha256").update(verifier, "ascii").digest(),
  );
  const state = base64Url(randomBytes(24));
  const port = 17_890;
  const redirectUri = defaults.redirectUri;
  const server = createServer();
  const callback = new Promise<string>((resolve, reject) => {
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (
        url.pathname !== "/callback/" ||
        url.searchParams.get("state") !== state
      ) {
        response
          .writeHead(400, {
            "content-type": "text/plain",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          })
          .end("Invalid OAuth callback.");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response
          .writeHead(400, {
            "content-type": "text/plain",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          })
          .end("Authorization failed.");
        reject(new Error("Authorization callback did not contain a code."));
      } else {
        response
          .writeHead(200, {
            "content-type": "text/plain",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          })
          .end(
            "Borealis CLI authorization complete. You may close this window.",
          );
        resolve(code);
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
  const authorize = new URL("/auth/client/start", app);
  for (const [key, value] of Object.entries({
    client_type: "cli",
    client_id: defaults.clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    authorize.searchParams.set(key, value);
  if (loginHint) authorize.searchParams.set("login_hint", loginHint);
  process.stderr.write(`Opening ${authorize.origin} for authentication…\n`);
  let code: string;
  let callbackTimeout: NodeJS.Timeout | undefined;
  let rejectForAbort: (() => void) | undefined;
  try {
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    await openBrowser(authorize.toString());
    code = await Promise.race([
      callback,
      new Promise<never>((_, reject) => {
        rejectForAbort = () =>
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", rejectForAbort, { once: true });
      }),
      new Promise<never>((_, reject) => {
        callbackTimeout = setTimeout(
          () =>
            reject(new Error("OAuth callback timed out after five minutes.")),
          5 * 60 * 1000,
        );
        callbackTimeout.unref();
      }),
    ]);
  } finally {
    if (callbackTimeout) clearTimeout(callbackTimeout);
    if (rejectForAbort) signal?.removeEventListener("abort", rejectForAbort);
    server.close();
  }
  const token = await requestToken(
    identity,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: defaults.clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal,
  );
  if (!token.refresh_token)
    throw new Error("The authorization server did not return a refresh token.");
  const contextDeadline = createRequestDeadline(signal, 30_000);
  let contextResponse: Response;
  let contextText: string;
  try {
    contextResponse = await fetch(`${api}/api/v1/context`, {
      headers: {
        authorization: `Bearer ${token.access_token}`,
        accept: "application/json",
        ...(options.organization
          ? { "x-organization-id": options.organization }
          : {}),
      },
      redirect: "error",
      signal: contextDeadline.signal,
    });
    contextText = await readBoundedResponse(
      contextResponse,
      1024 * 1024,
      contextDeadline.signal,
    );
  } finally {
    contextDeadline.dispose();
  }
  if (!contextResponse.ok)
    throw new Error(
      `Borealis context validation failed (${contextResponse.status}).`,
    );
  const context = z
    .object({
      selectedOrganizationId: z.string().min(1).nullable().optional(),
      organizations: z.array(z.object({ organizationId: z.string().min(1) })),
    })
    .parse(JSON.parse(contextText));
  if (
    options.organization &&
    !context.organizations.some(
      (membership) => membership.organizationId === options.organization,
    )
  )
    throw new Error(
      `The authenticated user is not a member of organization '${options.organization}'.`,
    );
  const organization =
    options.organization ?? context.selectedOrganizationId ?? undefined;
  const session: Session = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: token.scope,
    clientId: defaults.clientId,
    api,
    identity,
    app,
    ...(organization ? { organization } : {}),
  };
  await saveSession(options.profile, session, signal);
  return session;
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("HTTP response did not contain a body.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = signal
      ? await readWithSignal(reader, signal)
      : await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`HTTP response exceeded ${limit} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const rejectForAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", rejectForAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", rejectForAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", rejectForAbort);
        reject(error);
      },
    );
  });
}

export async function resolveAccessToken(
  options: GlobalOptions,
  signal?: AbortSignal,
): Promise<{ token: string; session?: Session }> {
  signal?.throwIfAborted();
  const environment = process.env.BOREALIS_ACCESS_TOKEN;
  const supplied = [environment, options.token, options.tokenFile].filter(
    Boolean,
  );
  if (supplied.length > 1)
    throw new Error(
      "Specify only one of BOREALIS_ACCESS_TOKEN, --token, or --token-file.",
    );
  if (options.token)
    process.stderr.write(
      "Warning: --token may expose credentials in shell history and process listings; prefer BOREALIS_ACCESS_TOKEN or --token-file.\n",
    );
  if (options.tokenFile) {
    return { token: await readOwnerOnlySecretFile(options.tokenFile) };
  }
  if (environment || options.token)
    return { token: (environment ?? options.token)! };
  const session = await loadSession(options.profile, signal);
  if (!session)
    throw new Error(
      `No authentication found for profile '${options.profile}'. Run 'borealis auth login'.`,
    );
  if (Date.parse(session.expiresAt) > Date.now() + 60_000)
    return { token: session.accessToken, session };
  if (!session.refreshToken)
    throw new Error("The saved session expired and has no refresh token.");
  const refreshed = await requestToken(
    session.identity,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    }),
    signal,
  );
  const updated: Session = {
    ...session,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? session.refreshToken,
    expiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    scope: refreshed.scope,
  };
  await saveSession(options.profile, updated, signal);
  return { token: updated.accessToken, session: updated };
}
