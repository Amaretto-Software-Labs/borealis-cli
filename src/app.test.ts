import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BorealisApiClient } from "./api-client.js";
import { parseAuthLoginOptions, resolveApiBase, run } from "./app.js";

afterEach(() => {
  delete process.env.BOREALIS_ACCESS_TOKEN;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("credential dispatch safety", () => {
  it("parses and validates inline auth-login options", () => {
    expect(
      parseAuthLoginOptions([
        "auth",
        "login",
        "--login-hint=user@example.com",
        "--scope=borealis.user=extended",
        "--client-id=borealis-saas-cli",
        "--redirect-port=17890",
      ]),
    ).toEqual({
      loginHint: "user@example.com",
      scope: "borealis.user=extended",
    });
    expect(() =>
      parseAuthLoginOptions(["auth", "login", "--client-id=attacker-client"]),
    ).toThrow("OAuth client ID is fixed");
    expect(() =>
      parseAuthLoginOptions(["auth", "login", "--redirect-port=9999"]),
    ).toThrow("must be 17890");
  });

  it("rejects an inline OAuth client override before starting login", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await run(["auth", "login", "--client-id=attacker-client"])).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects reusing a saved session with a different explicit API origin", () => {
    expect(() =>
      resolveApiBase(
        "https://override.borealishq.io",
        "https://saved.borealishq.io",
        true,
      ),
    ).toThrow("cannot reuse credentials");
    expect(
      resolveApiBase(
        "https://saved.borealishq.io",
        "https://saved.borealishq.io",
        true,
      ),
    ).toBe("https://saved.borealishq.io");
    expect(
      resolveApiBase(
        "https://api.borealishq.io",
        "https://saved.borealishq.io",
        false,
      ),
    ).toBe("https://saved.borealishq.io");
  });

  it("dispatches to an API origin supplied with inline option syntax", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(
      await run(["--api=https://override.borealishq.io", "context", "show"]),
    ).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://override.borealishq.io/api/v1/context",
    );
  });

  it("reports asynchronously accepted sandbox deletion", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const sandboxId = "1a2ddb9b-71dc-5256-8382-0b0119b49586";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"preflightToken":"proof"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    expect(await run(["--yes", "--json", "sandbox", "delete", sandboxId])).toBe(
      0,
    );
    expect(stdout).toHaveBeenCalledWith('{"accepted":true}\n');
  });

  it("rejects credential-bearing enrollment reads without a delivery target", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await run(["host", "enrollment", "get", "pool-id", "session-id"]),
    ).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "service-principal creation",
      args: (destination: string) => [
        "service-principal",
        "create",
        "--name",
        "automation",
        "--scope",
        "borealis.user",
        `--output=${destination}`,
      ],
      result: { clientId: "client-1", clientSecret: "principal-secret" },
      path: "/api/v1/service-principals",
      secret: "principal-secret",
    },
    {
      name: "host-enrollment creation",
      args: (destination: string) => [
        "host",
        "enrollment",
        "create",
        "pool-id",
        "--host-id",
        "host-id",
        "--name",
        "agent",
        "--slots",
        "1",
        `--output=${destination}`,
      ],
      result: { sessionId: "session-1", command: "create-command" },
      path: "/api/v1/host-pools/pool-id/enrollment-sessions",
      secret: "create-command",
    },
    {
      name: "host-enrollment retrieval",
      args: (destination: string) => [
        "host",
        "enrollment",
        "get",
        "pool-id",
        "session-id",
        `--output=${destination}`,
      ],
      result: { sessionId: "session-id", code: "retrieved-code" },
      path: "/api/v1/host-pools/pool-id/enrollment-sessions/session-id",
      secret: "retrieved-code",
    },
  ])(
    "honors inline --output for $name",
    async ({ args, result, path, secret }) => {
      process.env.BOREALIS_ACCESS_TOKEN = "token";
      const temporary = await mkdtemp(join(tmpdir(), "borealis-app-test-"));
      const destination = join(temporary, "credential");
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      try {
        expect(await run(args(destination))).toBe(0);
        expect(await readFile(destination, "utf8")).toBe(secret);
        expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
          path,
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );

  it("requires confirmation before enabling automatic billing top-ups", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await run([
        "billing",
        "auto-top-up",
        "--enable",
        "--threshold",
        "100",
        "--target",
        "1000",
      ]),
    ).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires confirmation when a body enables automatic billing top-ups", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await run([
        "billing",
        "auto-top-up",
        "--body",
        '{"enabled":true,"thresholdMicrocredits":100,"targetMicrocredits":1000}',
      ]),
    ).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the conventional cancellation exit code without dispatch", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    expect(await run(["context", "show"], controller.signal)).toBe(130);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors an inline timeout when waiting for an operation", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    vi.spyOn(BorealisApiClient.prototype, "invoke").mockResolvedValue({
      statusUri: "/api/v1/snapshot-operations/request",
    });
    const waitFor = vi
      .spyOn(BorealisApiClient.prototype, "waitFor")
      .mockResolvedValue({ status: "completed" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(
      await run([
        "--yes",
        "snapshot",
        "create",
        "sandbox-id",
        "--wait",
        "--timeout=123",
      ]),
    ).toBe(0);
    expect(waitFor).toHaveBeenCalledWith(expect.anything(), 123);
  });

  it("surfaces the generated idempotency key when dispatch is cancelled", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      }),
    );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    expect(
      await run(["sandbox", "create", "--name", "one"], controller.signal),
    ).toBe(130);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(
        /Retry with --idempotency-key [0-9a-f]{8}-[0-9a-f-]{27}\./,
      ),
    );
  });

  it("revokes an undelivered credential after caller cancellation", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const temporary = await mkdtemp(join(tmpdir(), "borealis-app-test-"));
    const destination = join(temporary, "existing-secret");
    await writeFile(destination, "do not replace");
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        setTimeout(() => controller.abort(), 0);
        return new Response(
          JSON.stringify({
            clientId: "client-1",
            clientSecret: "one-time-secret",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      })
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        expect(init.signal).not.toBe(controller.signal);
        expect(init.signal?.aborted).toBe(false);
        return new Response('{"preflightToken":"proof"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        expect(init.signal).not.toBe(controller.signal);
        expect(init.signal?.aborted).toBe(false);
        return new Response(null, { status: 204 });
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(
        await run(
          [
            "service-principal",
            "create",
            "--name",
            "automation",
            "--scope",
            "borealis.user",
            "--output",
            destination,
          ],
          controller.signal,
        ),
      ).toBe(130);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "service principal",
      command: (destination: string) => [
        "service-principal",
        "create",
        "--name",
        "automation",
        "--scope",
        "borealis.user",
        "--output",
        destination,
      ],
      result: { clientId: "client-1", clientSecret: "one-time-secret" },
      warning: "could not be confirmed revoked",
    },
    {
      name: "host enrollment",
      command: (destination: string) => [
        "host",
        "enrollment",
        "create",
        "pool-id",
        "--host-id",
        "host-id",
        "--output",
        destination,
      ],
      result: { sessionId: "session-1", command: "enroll-secret" },
      warning: "could not be confirmed cancelled",
    },
  ])(
    "surfaces $name cleanup failure even after caller cancellation",
    async ({ command, result, warning }) => {
      process.env.BOREALIS_ACCESS_TOKEN = "token";
      const temporary = await mkdtemp(join(tmpdir(), "borealis-app-test-"));
      const destination = join(temporary, "existing-secret");
      await writeFile(destination, "do not replace");
      const controller = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify(result), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )
          .mockImplementationOnce(async () => {
            controller.abort(new DOMException("cancelled", "AbortError"));
            throw new Error("cleanup unavailable");
          }),
      );
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      try {
        expect(await run(command(destination), controller.signal)).toBe(130);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining(warning));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
});
