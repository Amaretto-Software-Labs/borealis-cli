import http from "node:http";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOAuthSession } from "./oauth-session.js";
import {
  oauthCallbackResponseHeaders,
  renderOAuthCallbackPage,
} from "./auth.js";

const sessions: Array<{ abort: AbortController; pending: Promise<unknown> }> =
  [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.abort.abort();
  await Promise.all(pendingSessions.splice(0).map((p) => p.catch(() => {})));
  vi.restoreAllMocks();
});
const pendingSessions: Promise<unknown>[] = [];

async function start(
  complete = vi.fn<(code: string, signal: AbortSignal) => Promise<string>>(
    async () => "saved",
  ),
  extra: Partial<Parameters<typeof runOAuthSession<string>>[0]> = {},
) {
  const output: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const abort = new AbortController();
  const attempts: Array<{ state: string; url: URL; switchAccount: boolean }> =
    [];
  const openBrowser = vi.fn<(url: string) => Promise<void>>(async () => {});
  const pending = runOAuthSession({
    headers: oauthCallbackResponseHeaders,
    renderPage: renderOAuthCallbackPage,
    openBrowser,
    signal: abort.signal,
    createAttempt(redirectUri, _retry, switchAccount) {
      const state = randomBytes(32).toString("base64url");
      const url = new URL("https://identity.example/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri);
      attempts.push({ state, url, switchAccount });
      return { state, authorizationUrl: url.toString(), complete };
    },
    ...extra,
  });
  void pending.catch(() => {});
  sessions.push({ abort, pending });
  pendingSessions.push(pending);
  await vi.waitFor(() => expect(attempts).toHaveLength(1));
  const first = attempts[0]!;
  const callback = new URL(first.url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", first.state);
  const recovery = new URL(
    output.join("").match(/http:\/\/127\.0\.0\.1:\d+\/auth\/[\w-]+/)![0],
  );
  return {
    pending,
    abort,
    attempts,
    callback,
    recovery,
    complete,
    output,
    openBrowser,
  };
}

function request(
  url: URL,
  method = "GET",
  headers: http.OutgoingHttpHeaders = {},
) {
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function retryUrl(body: string, origin: URL): URL {
  return new URL(
    body.match(/<form action="([^"]+)"/)![1]!.replaceAll("&amp;", "&"),
    origin,
  );
}

describe("recoverable loopback OAuth session", () => {
  it.each(["access_denied", "server_error", "missing-code"])(
    "keeps %s retryable, ignores stale responses, and completes a fresh attempt",
    async (failure) => {
      const session = await start();
      if (failure !== "missing-code")
        session.callback.searchParams.set("error", failure);
      const failed = await request(session.callback);
      expect(failed.status).toBe(400);
      expect(failed.body).toContain(
        failure === "access_denied"
          ? "Sign-in cancelled"
          : "No new credentials were saved",
      );
      expect(failed.body).toContain("Try again");
      expect(failed.body).toContain("Use another account");
      expect(session.complete).not.toHaveBeenCalled();
      const retry = retryUrl(failed.body, session.recovery);
      const restarted = await request(retry, "POST", {
        origin: session.recovery.origin,
      });
      expect(restarted.status).toBe(303);
      expect(session.attempts).toHaveLength(2);
      expect(session.attempts[1]!.state).not.toBe(session.attempts[0]!.state);
      // Refresh/back cannot restart an attempt using an old retry form.
      expect((await request(retry, "POST")).status).toBe(404);
      session.callback.searchParams.delete("error");
      session.callback.searchParams.set("code", "old-code");
      expect((await request(session.callback)).status).toBe(400);
      expect(session.complete).not.toHaveBeenCalled();
      session.callback.searchParams.set("state", session.attempts[1]!.state);
      session.callback.searchParams.set("code", "fresh-code");
      const success = await request(session.callback);
      expect(success.status).toBe(200);
      expect(success.body).toContain("Authorization complete");
      expect(success.body).not.toContain("Try again");
      await expect(session.pending).resolves.toBe("saved");
      expect(session.complete).toHaveBeenCalledTimes(1);
      await expect(request(session.recovery)).rejects.toThrow();
    },
  );

  it("requires a local POST with a secret retry path and preserves the account-change choice", async () => {
    const session = await start();
    const page = await request(session.recovery);
    const retry = retryUrl(page.body, session.recovery);
    expect((await request(retry)).status).toBe(404);
    expect(
      (await request(retry, "POST", { origin: "https://attacker.example" }))
        .status,
    ).toBe(403);
    expect(
      (await request(retry, "POST", { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (
        await request(retry, "POST", {
          origin: "null",
          "sec-fetch-site": "cross-site",
        })
      ).status,
    ).toBe(403);
    expect(page.headers["content-security-policy"]).toContain(
      "form-action 'self' https://identity.example",
    );
    expect(
      (await request(session.recovery, "GET", { host: "attacker.example" }))
        .status,
    ).toBe(403);
    expect(session.attempts).toHaveLength(1);
    retry.searchParams.set("account", "change");
    expect(
      (
        await request(retry, "POST", {
          origin: "null",
          "sec-fetch-site": "same-origin",
        })
      ).status,
    ).toBe(303);
    expect(session.attempts[1]!.switchAccount).toBe(true);
  });

  it("ignores favicon, wrong paths, duplicate state, and multibyte invalid state", async () => {
    const session = await start();
    expect(
      (await request(new URL("/favicon.ico", session.recovery))).status,
    ).toBe(404);
    session.callback.searchParams.set(
      "state",
      "é".repeat(session.attempts[0]!.state.length),
    );
    expect((await request(session.callback)).status).toBe(400);
    session.callback.searchParams.set("state", session.attempts[0]!.state);
    session.callback.searchParams.append("state", session.attempts[0]!.state);
    expect((await request(session.callback)).status).toBe(400);
    expect(session.complete).not.toHaveBeenCalled();
    expect((await request(session.recovery)).status).toBe(200);
  });

  it("does not report success before token validation and credential storage finish", async () => {
    let finish!: (value: string) => void;
    const complete = vi.fn<
      (code: string, signal: AbortSignal) => Promise<string>
    >(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const session = await start(complete);
    session.callback.searchParams.set("code", "code");
    const response = request(session.callback);
    let responded = false;
    void response.then(() => {
      responded = true;
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(responded).toBe(false);
    expect((await request(session.callback)).status).toBe(409);
    expect((await request(session.recovery)).body).not.toContain("Try again");
    finish("saved");
    expect((await response).body).toContain("Authorization complete");
    await expect(session.pending).resolves.toBe("saved");
  });

  it("shows a safe retryable failure after token/context/storage errors instead of false success", async () => {
    const complete = vi.fn<
      (code: string, signal: AbortSignal) => Promise<string>
    >(async () => "saved");
    complete.mockRejectedValueOnce(
      new Error("SECRET token and provider diagnostic"),
    );
    const session = await start(complete);
    session.callback.searchParams.set("code", "bad-code");
    const failure = await request(session.callback);
    expect(failure.status).toBe(400);
    expect(failure.body).toContain("Try again");
    expect(failure.body).not.toContain("Authorization complete");
    expect(failure.body).not.toContain("SECRET");
    expect(session.output.join("")).not.toContain("SECRET");
    await request(retryUrl(failure.body, session.recovery), "POST");
    session.callback.searchParams.set("state", session.attempts[1]!.state);
    session.callback.searchParams.set("code", "good-code");
    expect((await request(session.callback)).status).toBe(200);
    await expect(session.pending).resolves.toBe("saved");
  });

  it("makes timeouts recoverable but bounds the idle retry window", async () => {
    const session = await start(undefined, {
      attemptTimeoutMs: 20,
      retryTimeoutMs: 100,
    });
    await vi.waitFor(() =>
      expect(session.output.join("")).toContain("Sign-in timed out"),
    );
    expect((await request(session.recovery)).body).toContain(
      "Sign-in timed out",
    );
    await expect(session.pending).rejects.toThrow(
      "expired while waiting for a retry",
    );
    await expect(request(session.recovery)).rejects.toThrow();
  });

  it("allows terminal Enter to retry even when the provider never sends a callback", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const session = await start(undefined, { input });
    input.write("\n");
    await vi.waitFor(() => expect(session.attempts).toHaveLength(2));
    expect(session.openBrowser).toHaveBeenCalledTimes(2);
    session.abort.abort();
    await expect(session.pending).rejects.toThrow("interrupted");
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  });

  it("aborts outstanding exchanges and releases the listener on foreground cancellation", async () => {
    let exchangeSignal!: AbortSignal;
    const complete = vi.fn((_code: string, signal: AbortSignal) => {
      exchangeSignal = signal;
      return new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    });
    const session = await start(complete);
    session.callback.searchParams.set("code", "code");
    const response = request(session.callback);
    void response.catch(() => {});
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    session.abort.abort();
    await expect(session.pending).rejects.toThrow("interrupted");
    expect(exchangeSignal.aborted).toBe(true);
    await expect(response).rejects.toThrow();
    await expect(request(session.recovery)).rejects.toThrow();
  });

  it.each([false, true])(
    "restores terminal input after success (previously flowing: %s)",
    async (wasFlowing) => {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      if (wasFlowing) input.resume();
      else expect(input.readableFlowing).toBeNull();
      const session = await start(undefined, { input });
      session.callback.searchParams.set("code", "code");
      expect((await request(session.callback)).status).toBe(200);
      await expect(session.pending).resolves.toBe("saved");
      expect(input.readableFlowing).toBe(wasFlowing);
      expect(input.listenerCount("data")).toBe(0);
      input.destroy();
    },
  );

  it("keeps manual sign-in available if the browser cannot be launched", async () => {
    const session = await start(undefined, {
      openBrowser: async () => {
        throw new Error("no browser");
      },
    });
    await vi.waitFor(() =>
      expect(session.output.join("")).toContain(
        "Open the sign-in URL above manually",
      ),
    );
    expect((await request(session.recovery)).body).toContain("Try again");
  });
});
