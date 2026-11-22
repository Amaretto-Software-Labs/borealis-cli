import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentialFiles from "./credential-file.js";
import { BorealisApiClient } from "./api-client.js";
import { parseAuthLoginOptions, resolveApiBase, run } from "./app.js";

afterEach(() => {
  delete process.env.BOREALIS_ACCESS_TOKEN;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cloud image build observation", () => {
  const buildId = "c7f3dfee-c32a-4391-a57d-7a9ecfb389ce";
  const api = "https://builds.borealishq.io";
  const args = [
    "--api",
    api,
    "--json",
    "image",
    "build",
    "--body",
    JSON.stringify({
      sourceKind: "oci_image",
      imageReference: "debian:trixie-slim",
      architecture: "x86_64",
    }),
    "--wait",
  ];
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  function capture() {
    process.env.BOREALIS_ACCESS_TOKEN = "test-build-token";
    return {
      stdout: vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      stderr: vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    };
  }

  it.each(["e8181f06-1c6b-44ad-bc56-775295cd1a57", [buildId]])(
    "rejects an initial status receipt with an unexpected build identity %j",
    async (returnedId) => {
      const { stdout } = capture();
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          response({ buildId: returnedId, status: "ready" }),
        );
      vi.stubGlobal("fetch", fetcher);
      expect(
        await run([
          "--api",
          api,
          "--json",
          "image",
          "build",
          "status",
          buildId,
          "--wait",
        ]),
      ).not.toBe(0);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(
        stdout.mock.calls.map(([line]) => String(line)).join(""),
      ).not.toContain('"status":"ready"');
    },
  );

  it("watches an admitted build without statusUri until ready even when a running phase says completed", async () => {
    const { stdout, stderr } = capture();
    const ready = {
      buildId,
      status: "ready",
      phase: "completed",
      templateRevision: 1,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ buildId, status: "queued", phase: "queued" }, 202),
      )
      .mockResolvedValueOnce(
        response({ buildId, status: "building", phase: "completed" }),
      )
      .mockResolvedValueOnce(response(ready));
    vi.stubGlobal("fetch", fetcher);
    expect(await run(args)).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.map(([url, init]) => [String(url), init.method]),
    ).toEqual([
      [`${api}/api/v1/runtime-image-builds`, "POST"],
      [`${api}/api/v1/runtime-image-builds/${buildId}`, "GET"],
      [`${api}/api/v1/runtime-image-builds/${buildId}`, "GET"],
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer test-build-token",
      );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(ready) + "\n",
    );
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain(
      "Image is ready",
    );
  });

  it("returns awaiting approval as an unpublished candidate and shows the next command", async () => {
    const { stdout, stderr } = capture();
    const candidate = {
      buildId,
      status: "awaiting_approval",
      phase: "completed",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ buildId, status: "validating", phase: "cloud_validation" }),
      )
      .mockResolvedValueOnce(response(candidate));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await run([
        "--api",
        api,
        "--json",
        "image",
        "build",
        "status",
        buildId,
        "--wait",
      ]),
    ).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(candidate) + "\n",
    );
    const progress = stderr.mock.calls.map(([line]) => String(line)).join("");
    expect(progress).toContain("Approval is required before publication");
    expect(progress).toContain(`image build approve ${buildId}`);
    expect(progress).not.toContain("Image is ready");
  });

  it("reports an observation interruption without marking the accepted build failed or canceling it", async () => {
    const { stdout, stderr } = capture();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ buildId, status: "queued", phase: "queued" }, 202),
      )
      .mockResolvedValueOnce(
        response({ detail: "Temporarily unavailable" }, 503),
      );
    vi.stubGlobal("fetch", fetcher);
    expect(await run(args)).toBe(4);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const receipt = JSON.parse(String(stdout.mock.calls[0]![0]));
    expect(receipt).toMatchObject({
      error: "observation_interrupted",
      target: { type: "cloud" },
      resource: { kind: "build", id: buildId },
    });
    expect(receipt.message).toContain("final state is unknown");
    expect(receipt.message).toContain(`image build status ${buildId} --wait`);
    expect(
      stderr.mock.calls.map(([line]) => String(line)).join(""),
    ).not.toContain(": Failed");
  });

  it("rejects a different build identity returned while observing", async () => {
    const { stdout } = capture();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ buildId, status: "queued" }, 202))
      .mockResolvedValueOnce(
        response({
          buildId: "e8181f06-1c6b-44ad-bc56-775295cd1a57",
          status: "ready",
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    expect(await run(args)).toBe(4);
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({
      error: "observation_interrupted",
      resource: { id: buildId },
    });
  });
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
      await run(["--api=https://override.borealishq.io", "auth", "whoami"]),
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
        new Response(JSON.stringify({ sandboxId, runtimeKind: "container" }), {
          headers: { "content-type": "application/json" },
        }),
      )
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

    expect(await run(["--yes", "--json", "vm", "delete", sandboxId])).toBe(0);
    expect(stdout).toHaveBeenCalledWith('{"accepted":true}\n');
  });

  it.each([
    { status: "failed", imported: false, exit: 3 },
    { status: "completed", imported: true, exit: 0 },
    { status: "queued", imported: false, exit: 0 },
  ])(
    "returns $exit for a $status workspace import and preserves JSON output",
    async ({ status, imported, exit }) => {
      process.env.BOREALIS_ACCESS_TOKEN = "token";
      const result = {
        status,
        imported,
        importErrorCode:
          status === "failed" ? "workspace_import_insufficient_storage" : null,
      };
      vi.spyOn(BorealisApiClient.prototype, "invoke").mockResolvedValue({
        status: "queued",
      });
      vi.spyOn(BorealisApiClient.prototype, "waitFor").mockResolvedValue(
        result,
      );
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      expect(
        await run([
          "--yes",
          "--json",
          "vm",
          "workspace",
          "import",
          "sandbox-id",
          "archive.tar",
          "--wait",
        ]),
      ).toBe(exit);
      expect(stdout).toHaveBeenCalledWith(JSON.stringify(result) + "\n");
      if (exit)
        expect(stderr).toHaveBeenCalledWith(
          "Workspace import failed: workspace_import_insufficient_storage\n",
        );
      else {
        expect(stderr).toHaveBeenCalledOnce();
        expect(stderr).toHaveBeenCalledWith(
          expect.stringMatching(
            /^Request key [0-9a-f-]+ on profile 'default'\n$/,
          ),
        );
      }
    },
  );

  it("rejects credential-bearing enrollment reads without a delivery target", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await run([
        "cloud",
        "host",
        "enrollment",
        "inspect",
        "pool-id",
        "session-id",
      ]),
    ).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "service-principal creation",
      args: (destination: string) => [
        "cloud",
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
        "cloud",
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
        "cloud",
        "host",
        "enrollment",
        "inspect",
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
        "cloud",
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
        "cloud",
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
    expect(await run(["auth", "whoami"], controller.signal)).toBe(130);
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
        "vm",
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
      await run(
        [
          "vm",
          "create",
          "--name",
          "one",
          "--prepared-image",
          "prepared",
          "--revision",
          "1",
          "--architecture",
          "x86_64",
        ],
        controller.signal,
      ),
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
    const writeCredentialFile = credentialFiles.writeCredentialFile;
    vi.spyOn(credentialFiles, "writeCredentialFile").mockImplementation(
      async (...args) => {
        controller.abort();
        return writeCredentialFile(...args);
      },
    );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
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
            "cloud",
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
        "cloud",
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
        "cloud",
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

describe("VM lifecycle cancellation output", () => {
  it("prints a cancelled wake receipt and exits 130 through the public VM command", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const requestId = "e8a5c14c-57d4-4bf0-8307-aea8bd50272c";
    const sandboxId = "a535812b-3c64-4888-824c-928530ad9e21";
    const receipt = { requestId, sandboxId, state: "Cancelled" };
    const invoke = vi
      .spyOn(BorealisApiClient.prototype, "invoke")
      .mockResolvedValue({ requestId, sandboxId, state: "Requested" });
    const wait = vi
      .spyOn(BorealisApiClient.prototype, "waitForRuntime")
      .mockResolvedValue(receipt);
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await run([
        "--api=https://api.example",
        "--json",
        "vm",
        "resume",
        sandboxId,
        "--idempotency-key",
        requestId,
        "--wait",
        "--timeout",
        "2",
      ]),
    ).toBe(130);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "sandbox.resume",
        command: "vm resume",
      }),
      expect.objectContaining({ idempotencyKey: requestId }),
    );
    expect(wait).toHaveBeenCalledWith(
      expect.objectContaining({ requestId }),
      2,
    );
    expect(
      JSON.parse(output.mock.calls.map((call) => call[0]).join("")),
    ).toEqual(receipt);
  });
});

describe("private network terminal output", () => {
  it.each([
    { state: "failed", exitCode: 3 },
    { state: "outcomeUnknown", exitCode: 4 },
    { state: "cancelled", exitCode: 130 },
    { state: "completed", exitCode: 0 },
  ])(
    "preserves private network $state JSON and exits $exitCode",
    async ({ state, exitCode }) => {
      process.env.BOREALIS_ACCESS_TOKEN = "token";
      const requestId = "e8a5c14c-57d4-4bf0-8307-aea8bd50272c";
      const resourceId = "d9ca33cb-ec1e-43d6-97e3-3d56de7f1a74";
      const observation = {
        requestId,
        resourceId,
        kind: "vnet.create",
        state,
        generation: 7,
        failureCode: state === "failed" ? "publication_failed" : null,
      };
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              enabled: true,
              operations: ["private_network.operation.get"],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(observation), {
            headers: { "content-type": "application/json" },
          }),
        );
      vi.stubGlobal("fetch", fetcher);
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      expect(
        await run([
          "--api=https://api.example",
          "--json",
          "network",
          "operation",
          "status",
          requestId,
        ]),
      ).toBe(exitCode);
      expect(stdout).toHaveBeenCalledOnce();
      expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toEqual(observation);
      expect(stderr).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
    },
  );
});

describe("public command boundaries", () => {
  it.each([0, 7])(
    "returns guest exit code %i and writes execution streams",
    async (exitCode) => {
      process.env.BOREALIS_ACCESS_TOKEN = "token";
      const invoke = vi
        .spyOn(BorealisApiClient.prototype, "invoke")
        .mockResolvedValue({
          stdout: "guest output\n",
          stderr: "guest error\n",
          exitCode,
          status: "succeeded",
        });
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      expect(
        await run([
          "vm",
          "exec",
          "a535812b-3c64-4888-824c-928530ad9e21",
          "--command",
          "/bin/sh",
          "--arg=-c",
          "--arg",
          "exit 7",
        ]),
      ).toBe(exitCode);
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "sandbox.exec.transient" }),
        expect.objectContaining({
          body: expect.objectContaining({
            command: "/bin/sh",
            args: ["-c", "exit 7"],
          }),
        }),
      );
      expect(stdout).toHaveBeenCalledWith("guest output\n");
      expect(stderr).toHaveBeenCalledWith("guest error\n");
    },
  );

  it("creates a Cloud microVM from a prepared image with explicit resource units", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const invoke = vi
      .spyOn(BorealisApiClient.prototype, "invoke")
      .mockResolvedValue({ sandboxId: "a535812b-3c64-4888-824c-928530ad9e21" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await run([
        "vm",
        "create",
        "--name",
        "dev",
        "--prepared-image",
        "prepared",
        "--revision",
        "1",
        "--architecture",
        "x86_64",
        "--vcpu",
        "2",
        "--memory-mib",
        "4096",
        "--root-disk-gib",
        "20",
      ]),
    ).toBe(0);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "sandbox.create" }),
      expect.objectContaining({
        body: expect.objectContaining({
          name: "dev",
          runtime: expect.objectContaining({
            kind: "microvm",
            templateId: "prepared",
            templateRevision: 1,
            architecture: "x86_64",
            resources: { vcpu: 2, memoryMiB: 4096, rootDiskGiB: 20 },
          }),
        }),
      }),
    );
  });

  it.each([
    ["sandbox", "list"],
    ["logical-machine", "wake", "vm-id"],
    ["managed", "service", "get", "vm-id", "request-id"],
    ["background", "lease", "acquire"],
    ["vnet", "list"],
    ["private-network", "operation", "get", "request-id"],
  ])(
    "rejects hidden implementation command %s without dispatch",
    async (...args) => {
      process.env.BOREALIS_ACCESS_TOKEN = "token";
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(await run(args)).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("refuses an unprepared Cloud image without creating a container", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    expect(
      await run([
        "vm",
        "create",
        "--name",
        "dev",
        "--image",
        "debian:trixie-slim",
      ]),
    ).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("prepared"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a lifecycle response for another VM before mutation", async () => {
    process.env.BOREALIS_ACCESS_TOKEN = "token";
    const vmId = "a535812b-3c64-4888-824c-928530ad9e21";
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sandboxId: "d9ca33cb-ec1e-43d6-97e3-3d56de7f1a74",
          runtimeKind: "container",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    expect(await run(["--yes", "vm", "delete", vmId])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("identity"));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });
});
