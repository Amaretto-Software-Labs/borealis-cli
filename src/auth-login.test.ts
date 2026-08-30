import http from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { login } from "./auth.js";
import { defaults } from "./config.js";
import { saveSession } from "./session-store.js";
import type { GlobalOptions } from "./types.js";

const browser = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: null, stdout: string) => void,
  ) => {
    browser.urls.push(args.at(-1)!);
    callback(null, "");
  },
}));
vi.mock("./session-store.js", () => ({
  saveSession: vi.fn(async () => {}),
  loadSession: vi.fn(),
}));

const options = {
  profile: "test",
  api: "https://api.borealishq.io",
  identity: "https://identity.borealishq.io",
  app: "https://app.borealishq.io",
} as GlobalOptions;
const active: Array<{
  controller: AbortController;
  pending: Promise<unknown>;
}> = [];
afterEach(async () => {
  for (const session of active) session.controller.abort();
  await Promise.all(
    active.splice(0).map(({ pending }) => pending.catch(() => {})),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(saveSession).mockReset();
  browser.urls.length = 0;
});

function request(url: URL, method = "GET") {
  return new Promise<{ status: number; body: string; location?: string }>(
    (resolve, reject) => {
      const req = http.request(url, { method, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString(),
            ...(response.headers.location
              ? { location: response.headers.location }
              : {}),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    },
  );
}

async function start() {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const controller = new AbortController();
  const pending = login(
    options,
    "wrong-account@example.test",
    defaults.scope,
    controller.signal,
  );
  void pending.catch(() => {});
  active.push({ controller, pending });
  await vi.waitFor(() => expect(browser.urls).toHaveLength(1));
  return { controller, pending, authorize: new URL(browser.urls[0]!) };
}

describe("Borealis auth recovery integration", () => {
  it("cancels, switches account with fresh PKCE, validates context and saves before showing success", async () => {
    let tokenRequest: URLSearchParams | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        if (input.endsWith("/connect/token")) {
          tokenRequest = init.body as URLSearchParams;
          return Response.json({
            access_token: "access",
            refresh_token: "refresh",
            token_type: "Bearer",
            expires_in: 300,
            scope: defaults.scope,
          });
        }
        expect(input).toBe(options.api + "/api/v1/context");
        expect(vi.mocked(saveSession)).not.toHaveBeenCalled();
        return Response.json({
          selectedOrganizationId: "org",
          organizations: [{ organizationId: "org" }],
        });
      }),
    );
    const session = await start();
    const callback = new URL(
      session.authorize.searchParams.get("redirect_uri")!,
    );
    callback.searchParams.set(
      "state",
      session.authorize.searchParams.get("state")!,
    );
    callback.searchParams.set("error", "access_denied");
    const cancelled = await request(callback);
    expect(cancelled.body).toContain("Sign-in cancelled");
    expect(saveSession).not.toHaveBeenCalled();
    const retry = new URL(
      cancelled.body.match(/<form action="([^"]+)"/)![1]!,
      callback,
    );
    retry.searchParams.set("account", "change");
    const restarted = await request(retry, "POST");
    const logout = new URL(restarted.location!);
    expect(logout.origin).toBe(options.app);
    expect(logout.pathname).toBe("/auth/logout");
    const authorize = new URL(
      logout.searchParams.get("returnUrl")!,
      options.app,
    );
    expect(authorize.pathname).toBe("/auth/client/start");
    expect(authorize.searchParams.has("login_hint")).toBe(false);
    for (const key of ["state", "code_challenge"])
      expect(authorize.searchParams.get(key)).not.toBe(
        session.authorize.searchParams.get(key),
      );
    callback.searchParams.delete("error");
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", "fresh-code");
    const success = await request(callback);
    expect(success.status).toBe(200);
    expect(success.body).toContain("Borealis CLI is connected");
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(
      createHash("sha256")
        .update(tokenRequest!.get("code_verifier")!, "ascii")
        .digest("base64url"),
    ).toBe(authorize.searchParams.get("code_challenge"));
    await expect(session.pending).resolves.toMatchObject({
      organization: "org",
      refreshToken: "refresh",
    });
  });

  it.each(["token", "context", "storage"])(
    "keeps %s failures retryable and never displays success",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          if (input.endsWith("/connect/token")) {
            if (failure === "token")
              return new Response("sensitive upstream error", { status: 400 });
            return Response.json({
              access_token: "access",
              refresh_token: "refresh",
              token_type: "Bearer",
              expires_in: 300,
              scope: defaults.scope,
            });
          }
          if (failure === "context")
            return new Response("forbidden", { status: 403 });
          return Response.json({ organizations: [] });
        }),
      );
      if (failure === "storage")
        vi.mocked(saveSession).mockRejectedValue(
          new Error("keychain unavailable"),
        );
      const session = await start();
      const callback = new URL(
        session.authorize.searchParams.get("redirect_uri")!,
      );
      callback.searchParams.set(
        "state",
        session.authorize.searchParams.get("state")!,
      );
      callback.searchParams.set("code", "code");
      const response = await request(callback);
      expect(response.status).toBe(400);
      expect(response.body).toContain("Try again");
      expect(response.body).not.toContain("Authorization complete");
      expect(response.body).not.toContain("sensitive");
      if (failure !== "storage") expect(saveSession).not.toHaveBeenCalled();
    },
  );
});
