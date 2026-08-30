import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export type OAuthPageKind =
  "waiting" | "success" | "cancelled" | "failed" | "invalid" | "timeout";

type Attempt<T> = {
  state: string;
  authorizationUrl: string;
  complete(code: string, signal: AbortSignal): Promise<T>;
};

type Options<T> = {
  input?: Readable & { isTTY?: boolean };
  port?: number;
  signal?: AbortSignal | undefined;
  createAttempt(
    redirectUri: string,
    retry: boolean,
    switchAccount: boolean,
  ): Attempt<T>;
  renderPage(kind: OAuthPageKind, retryPath?: string): string;
  headers: Readonly<Record<string, string>>;
  openBrowser?: ((url: string) => Promise<void>) | undefined;
  attemptTimeoutMs?: number;
  retryTimeoutMs?: number;
};

/** A bounded login session, not a single callback: failed attempts remain retryable.
 * Each retry replaces the entire state/PKCE attempt. No credentials enter the page.
 */
export async function runOAuthSession<T>(options: Options<T>): Promise<T> {
  options.signal?.throwIfAborted();
  const server = createServer();
  const input = options.input ?? process.stdin;
  const controller = new AbortController();
  const recoveryPath = `/auth/${randomBytes(32).toString("base64url")}`;
  let timer: NodeJS.Timeout | undefined;
  let terminal: ReturnType<typeof createInterface> | undefined;
  const wasFlowing = input.readableFlowing === true;
  let ended = false;
  let succeeded = false;
  let removeAbort: (() => void) | undefined;
  let phase: "waiting" | "exchanging" | "failed" = "waiting";
  let kind: OAuthPageKind = "waiting";
  let attempt: Attempt<T>;
  let retryPath: string;
  let pageHeaders = options.headers;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Could not reserve an OAuth callback port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const redirectUri = `${origin}/callback/`;

    return await new Promise<T>((resolve, reject) => {
      const stop = (error: Error) => {
        if (ended) return;
        ended = true;
        controller.abort(error);
        reject(error);
      };
      const onAbort = () => stop(new Error("OAuth login was interrupted."));
      const writePage = (
        response: ServerResponse,
        page: OAuthPageKind,
        status = 200,
      ) => {
        response.writeHead(status, pageHeaders);
        response.end(
          options.renderPage(
            page,
            phase === "exchanging" ? undefined : retryPath,
          ),
        );
      };
      const failed = (page: OAuthPageKind) => {
        phase = "failed";
        kind = page;
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            stop(new Error("OAuth login expired while waiting for a retry.")),
          options.retryTimeoutMs ?? 600_000,
        );
        process.stderr.write(
          `Sign-in ${page === "cancelled" ? "was cancelled" : page === "timeout" ? "timed out" : "failed"}. No new credentials were saved.\nRetry in your browser: ${origin}${recoveryPath}\n`,
        );
        if (terminal)
          process.stderr.write(
            "Press Enter to try again, or Ctrl+C to stop.\n",
          );
      };
      const begin = (retry: boolean, switchAccount = false) => {
        attempt = options.createAttempt(redirectUri, retry, switchAccount);
        // Browsers enforce form-action across redirects as well as the local POST.
        // Only allow the configured application origin, never a callback parameter.
        pageHeaders = {
          ...options.headers,
          "content-security-policy": options.headers[
            "content-security-policy"
          ]!.replace(
            "form-action 'self'",
            `form-action 'self' ${new URL(attempt.authorizationUrl).origin}`,
          ),
        };
        retryPath = `/retry/${randomBytes(32).toString("base64url")}`;
        phase = "waiting";
        kind = "waiting";
        clearTimeout(timer);
        timer = setTimeout(
          () => failed("timeout"),
          options.attemptTimeoutMs ?? 300_000,
        );
        return attempt.authorizationUrl;
      };
      const launch = (url: string) => {
        // Always provide a copyable URL, including when the browser launcher fails.
        process.stderr.write(`${url}\n`);
        if (options.openBrowser) {
          void options.openBrowser(url).catch(() => {
            if (!ended)
              process.stderr.write(
                "Could not open the browser. Open the sign-in URL above manually.\n",
              );
          });
        }
      };
      server.on("error", stop);
      server.on("request", (request, response) => {
        request.resume();
        if (request.headers.host !== new URL(origin).host) {
          response
            .writeHead(403, pageHeaders)
            .end(options.renderPage("invalid"));
          return;
        }
        const url = new URL(request.url ?? "/", origin);
        if (ended) {
          response
            .writeHead(410, pageHeaders)
            .end(options.renderPage("timeout"));
          return;
        }
        if (url.pathname === recoveryPath && request.method === "GET") {
          writePage(response, kind);
          return;
        }
        if (url.pathname === retryPath && request.method === "POST") {
          if (
            (request.headers.origin &&
              request.headers.origin !== origin &&
              // Referrer-Policy: no-referrer gives navigational POSTs an opaque Origin.
              !(
                request.headers.origin === "null" &&
                request.headers["sec-fetch-site"] === "same-origin"
              )) ||
            request.headers["sec-fetch-site"] === "cross-site"
          ) {
            response
              .writeHead(403, pageHeaders)
              .end(options.renderPage("invalid"));
            return;
          }
          if (phase === "exchanging") {
            writePage(response, "waiting", 409);
            return;
          }
          const next = begin(
            true,
            url.searchParams.get("account") === "change",
          );
          // Redirect only to a URL constructed by the CLI, never a request parameter.
          response.writeHead(303, { ...pageHeaders, location: next }).end();
          process.stderr.write(
            "Starting a fresh sign-in attempt in your browser.\n",
          );
          return;
        }
        if (url.pathname !== "/callback/" || request.method !== "GET") {
          response
            .writeHead(404, pageHeaders)
            .end(options.renderPage("invalid"));
          return;
        }
        const state = Buffer.from(url.searchParams.get("state") ?? "");
        const expectedState = Buffer.from(attempt.state);
        if (
          url.searchParams.getAll("state").length !== 1 ||
          state.length !== expectedState.length ||
          !timingSafeEqual(state, expectedState)
        ) {
          // Unrelated and stale callbacks cannot kill or consume the active attempt.
          writePage(response, "invalid", 400);
          return;
        }
        if (phase !== "waiting") {
          writePage(response, kind, 409);
          return;
        }
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error || !code || url.searchParams.getAll("code").length !== 1) {
          failed(error === "access_denied" ? "cancelled" : "failed");
          writePage(response, kind, 400);
          return;
        }
        phase = "exchanging";
        clearTimeout(timer);
        // Keep the browser request open until tokens, identity/context, and storage
        // are all verified. Never show a success page for a failed token exchange.
        void attempt.complete(code, controller.signal).then(
          (value) => {
            if (ended) return;
            ended = true;
            succeeded = true;
            response.writeHead(200, pageHeaders);
            response.end(options.renderPage("success"));
            resolve(value);
          },
          () => {
            if (ended) return;
            failed("failed");
            writePage(response, kind, 400);
          },
        );
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // The foreground listener must be removed on every terminal outcome.
      removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      if (input.isTTY) {
        terminal = createInterface({ input });
        terminal.on("line", () => {
          if (ended) return;
          if (phase === "exchanging") {
            process.stderr.write(
              "Finishing sign-in. Please wait, or press Ctrl+C to stop.\n",
            );
            return;
          }
          launch(begin(true));
        });
        terminal.on("SIGINT", onAbort);
        process.stderr.write(
          "Press Enter to restart sign-in, or Ctrl+C to stop.\n",
        );
      }
      const initial = begin(false);
      process.stderr.write(
        `If sign-in is cancelled or the browser gets stuck, retry here: ${origin}${recoveryPath}\n`,
      );
      if (options.signal?.aborted) onAbort();
      else launch(initial);
    });
  } finally {
    ended = true;
    clearTimeout(timer);
    removeAbort?.();
    controller.abort();
    terminal?.close();
    if (terminal && wasFlowing) input.resume();
    server.close();
    server.closeIdleConnections();
    if (!succeeded) server.closeAllConnections();
  }
}
