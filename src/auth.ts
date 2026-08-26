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

const callbackPageStyles = `
:root {
  color-scheme: dark;
  --color-bg: #06131f;
  --color-panel: #0b1b2b;
  --color-border: #1d3b4d;
  --color-text: #c9dce3;
  --color-text-muted: #91aab5;
  --color-text-bright: #eaf7fa;
  --color-accent: #38f5c8;
  --color-success: #4ade80;
  --color-error: #fb7185;
  --color-input: #102638;
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.4);
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  --font-mono: Consolas, Monaco, "Courier New", monospace;
}

* { box-sizing: border-box; }

html, body { min-height: 100%; }

body {
  margin: 0;
  min-width: 320px;
  color: var(--color-text);
  background:
    radial-gradient(circle at 50% -15%, rgba(78, 223, 245, 0.13), transparent 38rem),
    radial-gradient(circle at 90% 100%, rgba(56, 245, 200, 0.08), transparent 30rem),
    var(--color-bg);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
}

.card {
  width: min(100%, 480px);
  padding: 32px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-panel);
  background: color-mix(in srgb, var(--color-panel) 96%, transparent);
  box-shadow: var(--shadow-lg);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 32px;
  color: var(--color-text-bright);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.brand-mark { width: 32px; height: 32px; flex: none; }

.status-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  margin-bottom: 20px;
  border: 1px solid var(--color-border);
  border-color: color-mix(in srgb, var(--status-color) 55%, var(--color-border));
  border-radius: 999px;
  color: var(--status-color);
  background: var(--color-panel);
  background: color-mix(in srgb, var(--status-color) 10%, transparent);
}

.status-icon svg { width: 22px; height: 22px; }
.success { --status-color: var(--color-success); }
.error { --status-color: var(--color-error); }

.eyebrow {
  margin: 0 0 4px;
  color: var(--color-accent);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  color: var(--color-text-bright);
  font-size: clamp(24px, 7vw, 30px);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.description {
  margin: 12px 0 24px;
  color: var(--color-text-muted);
  font-size: 15px;
  line-height: 1.65;
}

.cli-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text);
  background: var(--color-input);
  font-family: var(--font-mono);
  font-size: 13px;
}

.status-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 999px;
  background: var(--status-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-color) 14%, transparent);
}

.hint {
  margin: 16px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --color-bg: #f4f9fb;
    --color-panel: #ffffff;
    --color-border: #d8e5ea;
    --color-text: #294653;
    --color-text-muted: #5e7580;
    --color-text-bright: #102a38;
    --color-accent: #0f766e;
    --color-success: #15803d;
    --color-error: #be123c;
    --color-input: #eaf3f6;
    --shadow-lg: 0 8px 24px rgba(16, 42, 56, 0.12);
  }
}

@media (max-width: 480px) {
  .shell { padding: 0; place-items: stretch; }
  .card {
    min-height: 100vh;
    padding: 28px 24px;
    border: 0;
    border-radius: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}`;

const callbackPageStyleHash = createHash("sha256")
  .update(callbackPageStyles, "utf8")
  .digest("base64");

export const oauthCallbackResponseHeaders = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": `default-src 'none'; style-src 'sha256-${callbackPageStyleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
});

type OAuthCallbackPageKind = "success" | "invalid" | "failed";

export function renderOAuthCallbackPage(kind: OAuthCallbackPageKind): string {
  const success = kind === "success";
  const content = success
    ? {
        title: "Authorization complete",
        description:
          "Borealis CLI is connected. You can close this window and return to your terminal.",
        status: "CLI session authorized",
        hint: "This page does not need to remain open.",
      }
    : kind === "invalid"
      ? {
          title: "Invalid authorization response",
          description:
            "Borealis could not verify this callback. Return to your terminal and start the sign-in flow again.",
          status: "CLI session not authorized",
          hint: "Run borealis auth login to retry.",
        }
      : {
          title: "Authorization incomplete",
          description:
            "Borealis did not receive an authorization code. Return to your terminal and start the sign-in flow again.",
          status: "CLI session not authorized",
          hint: "Run borealis auth login to retry.",
        };
  const icon = success
    ? '<path d="m5 12 4 4L19 6" />'
    : '<path d="M6 6l12 12M18 6 6 18" />';
  const statusClass = success ? "success" : "error";
  const liveRole = success ? "status" : "alert";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${content.title} · Borealis CLI</title>
  <style>${callbackPageStyles}</style>
</head>
<body>
  <main class="shell">
    <section class="card ${statusClass}" aria-labelledby="callback-title" role="${liveRole}">
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 49 48" fill="none" aria-hidden="true">
          <path d="M1.984 29.29a17.21 17.21 0 0 1 17.21-17.21v17.21H1.984Z" fill="#0b1b3d" />
          <path d="M1.984 29.29A17.21 17.21 0 0 0 19.194 46.5V29.29H1.984Z" fill="#38f5c8" />
          <path d="M36.404 29.29A17.21 17.21 0 0 1 19.194 46.5V29.29h17.21Z" fill="#4edff5" />
          <path d="M47.016 14.422a12.922 12.922 0 0 1-12.922 12.922H21.172V14.422a12.922 12.922 0 1 1 25.844 0Z" fill="#6a5cff" />
        </svg>
        <span>Borealis</span>
      </div>
      <div class="status-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
      </div>
      <p class="eyebrow">CLI authorization</p>
      <h1 id="callback-title">${content.title}</h1>
      <p class="description">${content.description}</p>
      <div class="cli-status">
        <span class="status-dot" aria-hidden="true"></span>
        <span>${content.status}</span>
      </div>
      <p class="hint">${content.hint}</p>
    </section>
  </main>
</body>
</html>`;
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
          .writeHead(400, oauthCallbackResponseHeaders)
          .end(renderOAuthCallbackPage("invalid"));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response
          .writeHead(400, oauthCallbackResponseHeaders)
          .end(renderOAuthCallbackPage("failed"));
        reject(new Error("Authorization callback did not contain a code."));
      } else {
        response
          .writeHead(200, oauthCallbackResponseHeaders)
          .end(renderOAuthCallbackPage("success"));
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
