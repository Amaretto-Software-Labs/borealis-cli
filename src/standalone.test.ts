import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { extract } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeHostHelper = vi.hoisted(() => vi.fn());
vi.mock("./host-helper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./host-helper.js")>()),
  invokeHostHelper,
}));
const loadSession = vi.hoisted(() => vi.fn());
vi.mock("./session-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-store.js")>()),
  loadSession,
}));
const login = vi.hoisted(() => vi.fn());
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  login,
}));
const unixFetchFailure = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => {
  const undici = await importOriginal<typeof import("undici")>();
  return {
    ...undici,
    fetch: (...args: Parameters<typeof undici.fetch>) => {
      unixFetchFailure();
      return undici.fetch(...args);
    },
  };
});
const helperStatFailure = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === "/usr/libexec/borealis/borealis-host")
        helperStatFailure();
      return fs.lstat(...args);
    },
  };
});

interface Request {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const operationId = "d0f090ba-733f-4dd5-9b2b-81fd482dce98";
const sandboxId = "6be39892-2462-4cc7-919a-c5621680969b";
const buildId = "3bdb5242-2dc3-45b2-ab82-0cd98d149ca4";

describe.skipIf(process.platform === "win32")("standalone CLI", () => {
  let root: string;
  let run: typeof import("./app.js").run;
  let stdout: ReturnType<typeof vi.spyOn<typeof process.stdout, "write">>;
  let stderr: ReturnType<typeof vi.spyOn<typeof process.stderr, "write">>;
  const cleanup: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    root = await mkdtemp("/tmp/borealis-cli-test-");
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("BOREALIS_CONFIG_HOME", join(root, "configuration"));
    vi.stubEnv("BOREALIS_ACCESS_TOKEN", undefined);
    vi.doMock("./profiles.js", async () => ({
      ...(await vi.importActual<typeof import("./profiles.js")>(
        "./profiles.js",
      )),
      defaultSocket: join(root, "auto.sock"),
    }));
    run = (await import("./app.js")).run;
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
    vi.doUnmock("./profiles.js");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  async function serve(
    name: string,
    operations: string[],
    respond: (request: Request) => unknown,
    discovery: Record<string, unknown> = {},
  ) {
    const socket = join(root, `${name}.sock`);
    const requests: Request[] = [];
    const server = createServer(async (request, response) => {
      try {
        const buffers: Buffer[] = [];
        for await (const buffer of request) buffers.push(buffer);
        const observed = {
          path: request.url!,
          method: request.method!,
          headers: request.headers,
          body: Buffer.concat(buffers),
        };
        requests.push(observed);
        const result =
          observed.path === "/api/v1/supervisor"
            ? {
                hostId: name,
                apiVersion: 1,
                architecture: "aarch64",
                operations,
                ...discovery,
              }
            : respond(observed);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500);
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) =>
      server.listen(socket, resolve).on("error", reject),
    );
    return { socket, requests };
  }

  function readOutput(): unknown {
    return JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    );
  }

  async function selectLocal(socket: string) {
    expect(
      await run(["profile", "add", "local", "--local", "--socket", socket]),
    ).toBe(0);
    expect(await run(["profile", "use", "local"])).toBe(0);
    stdout.mockClear();
  }

  it("requires a selected target without making a Cloud request", async () => {
    const cloud = vi.fn();
    vi.stubGlobal("fetch", cloud);
    expect(await run(["vm", "list"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("No Borealis profile is selected"),
    );
    expect(cloud).not.toHaveBeenCalled();
  });

  it("shows a fresh host's running VMs across pages and separates active builds from recent results", async () => {
    const host = await serve(
      "auto",
      ["sandbox.list", "runtime_image_build.list"],
      ({ path }) => {
        const { pathname, searchParams } = new URL(path, "http://test");
        if (pathname === "/api/v1/sandboxes") {
          const page = Number(searchParams.get("page"));
          return {
            page,
            pageSize: 100,
            totalCount: 102,
            items:
              page === 1
                ? Array.from({ length: 100 }, (_, id) => ({
                    sandboxId: `vm-${id}`,
                    name: `Stopped ${id}`,
                    status: "stopped",
                  }))
                : [
                    {
                      sandboxId: "vm-late",
                      name: "Web",
                      status: "running",
                      runtimeTemplateId: "web",
                      runtimeTemplateRevision: 9,
                    },
                    { sandboxId: "vm-pause", name: "Paused", status: "paused" },
                  ],
          };
        }
        if (pathname === "/api/v1/runtime-image-builds")
          return {
            items: [
              {
                buildId: "passed-build",
                status: "ready",
                publishedTemplateId: "web",
                publishedTemplateRevision: 9,
                updatedAt: "2026-11-18T18:00:00Z",
              },
              {
                buildId: "failed-build",
                status: "failed",
                phase: "source_pull_failed",
                failureCode: "source_pull_failed",
                resolvedImage: "debian@sha256:example",
                updatedAt: "2026-11-19T16:00:00Z",
              },
              {
                buildId: "active-build",
                status: "building",
                phase: "assembly_execute",
                resolvedImage: "debian:trixie-slim",
              },
              {
                buildId: "cleanup-build",
                status: "failed",
                phase: "cleanup_unconfirmed",
                failureCode: "cleanup_unconfirmed",
              },
            ],
          };
        throw new Error("Unexpected status route");
      },
      {
        healthy: true,
        releaseRevision: "release-1",
        admissionClosed: true,
        activeOperations: 4,
        builderEnabled: true,
        runtime: {
          provider: "firecracker",
          capacity: {
            totalVcpu: 20,
            totalMemoryMiB: 16000,
            availableDiskMiB: 22000,
          },
        },
      },
    );
    expect(await run(["status", "--json"])).toBe(0);
    expect(readOutput()).toMatchObject({
      schemaVersion: 1,
      target: { profile: "local", hostId: "auto" },
      result: {
        host: {
          releaseRevision: "release-1",
          architecture: "aarch64",
          acceptingNewWork: false,
          healthy: true,
          activeOperations: 4,
          capacity: {
            totalVcpu: 20,
            totalMemoryMiB: 16000,
            availableDiskMiB: 22000,
          },
        },
        vms: {
          coverage: "complete",
          totalCount: 102,
          observedCount: 102,
          stateCounts: { stopped: 100, paused: 1, running: 1 },
          running: [
            { vmId: "vm-late", name: "Web", image: "web", imageRevision: 9 },
          ],
        },
        imageBuilds: {
          coverage: "complete",
          totalCount: 4,
          activeCount: 2,
          active: [
            { buildId: "active-build", phase: "assembly_execute" },
            { buildId: "cleanup-build", failureCode: "cleanup_unconfirmed" },
          ],
          recent: [
            { buildId: "failed-build", source: "debian@sha256:example" },
            { buildId: "passed-build", publishedTemplateRevision: 9 },
          ],
        },
      },
    });
    expect(host.requests.every(({ method }) => method === "GET")).toBe(true);
    expect(host.requests.map(({ path }) => path).sort()).toEqual([
      "/api/v1/runtime-image-builds",
      "/api/v1/sandboxes?page=1&pageSize=100",
      "/api/v1/sandboxes?page=2&pageSize=100",
      "/api/v1/supervisor",
    ]);
    await expect(
      lstat(join(root, "configuration", "profiles", "selected")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves observed VM counts when a later page and the image inventory fail", async () => {
    const host = await serve(
      "auto",
      ["sandbox.list", "runtime_image_build.list"],
      ({ path }) => {
        if (path === "/api/v1/sandboxes?page=1&pageSize=100")
          return {
            page: 1,
            pageSize: 100,
            totalCount: 101,
            items: Array.from({ length: 100 }, (_, id) => ({
              sandboxId: `vm-${id}`,
              name: `Stopped ${id}`,
              status: "stopped",
            })),
          };
        throw new Error("Inventory endpoint temporarily unavailable");
      },
    );
    expect(await run(["status", "--json"])).toBe(1);
    expect(readOutput()).toMatchObject({
      result: {
        vms: {
          coverage: "partial",
          totalCount: 101,
          observedCount: 100,
          error: expect.any(String),
        },
        imageBuilds: {
          coverage: "unavailable",
          totalCount: null,
          activeCount: null,
          error: expect.any(String),
        },
      },
    });
    expect(host.requests).toHaveLength(4);
  });

  it("bounds VM pagination and distinguishes a disabled image builder", async () => {
    const host = await serve(
      "auto",
      ["sandbox.list", "runtime_image_build.list"],
      ({ path }) => {
        const url = new URL(path, "http://test");
        const page = Number(url.searchParams.get("page"));
        expect(url.pathname).toBe("/api/v1/sandboxes");
        expect(url.searchParams.get("pageSize")).toBe("100");
        return {
          page,
          pageSize: 100,
          totalCount: 501,
          items: Array.from({ length: 100 }, (_, id) => ({
            sandboxId: `vm-${page}-${id}`,
            name: `Worker ${id}`,
            status: "running",
          })),
        };
      },
      { builderEnabled: false },
    );
    expect(await run(["status", "--json"])).toBe(0);
    const report = readOutput() as { result: { vms: { running: unknown[] } } };
    expect(report.result.vms.running).toHaveLength(10);
    expect(report).toMatchObject({
      result: {
        vms: {
          coverage: "partial",
          totalCount: 501,
          observedCount: 500,
          limitReached: true,
          runningOmittedCount: 490,
        },
        imageBuilds: {
          enabled: false,
          coverage: "disabled",
          activeCount: null,
        },
      },
    });
    expect(
      host.requests.filter(({ path }) => path.startsWith("/api/v1/sandboxes?"))
        .length,
    ).toBe(5);
  });

  it.each([false, true])(
    "diagnoses EACCES from the Unix transport with a selected profile %s",
    async (selected) => {
      const host = await serve("auto", ["sandbox.list"], () => ({ items: [] }));
      if (selected) await selectLocal(host.socket);
      unixFetchFailure.mockImplementation(() => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect EACCES"), { code: "EACCES" }),
        });
      });
      expect(await run(["vm", "list", "--json"])).toBe(2);
      expect(readOutput()).toMatchObject({
        error: "supervisor_socket_permission_denied",
        socket: host.socket,
        message: expect.stringContaining("borealis doctor"),
      });
      expect(host.requests).toHaveLength(0);
      if (!selected)
        await expect(
          lstat(join(root, "configuration", "profiles", "selected")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("reports missing local socket and service checks from a fresh config without invoking the API", async () => {
    const cloud = vi.fn();
    vi.stubGlobal("fetch", cloud);
    expect(await run(["doctor", "--json"])).toBe(1);
    expect(readOutput()).toMatchObject({
      target: { profile: "local", type: "local" },
      result: {
        healthy: false,
        local: {
          installer: { state: expect.any(String) },
          service: { activeState: expect.any(String) },
          socket: { state: "missing" },
        },
        error: { code: "supervisor_doctor_check_failed" },
      },
    });
    expect(cloud).not.toHaveBeenCalled();
    expect(unixFetchFailure).not.toHaveBeenCalled();
    expect(await run(["supervisor", "doctor"])).toBe(1);
  });

  it("checks the local socket before the API health report without selecting a profile", async () => {
    const host = await serve("auto", ["supervisor.doctor"], () => ({
      healthy: true,
      hostId: "auto",
      builderEnabled: true,
      builderReady: true,
    }));
    const exitCode = await run(["doctor", "--json"]);
    const report = readOutput() as { result: { local: { issues: string[] } } };
    const healthy = report.result.local.issues.length === 0;
    expect(exitCode).toBe(healthy ? 0 : 1);
    expect(report).toMatchObject({
      target: { profile: "local", type: "local", hostId: "auto" },
      result: {
        healthy,
        apiHealthy: true,
        builderReady: true,
        local: {
          socket: {
            state: "accessible",
            mode: expect.stringMatching(/^0[0-7]{3}$/),
            path: host.socket,
            gid: expect.any(Number),
          },
        },
      },
    });
    expect(host.requests.map(({ path }) => path)).toEqual([
      "/api/v1/supervisor",
      "/api/v1/supervisor/doctor",
    ]);
    await expect(
      lstat(join(root, "configuration", "profiles", "selected")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports socket permission loss even if it happens during the doctor API check", async () => {
    const host = await serve("auto", ["supervisor.doctor"], () => ({}));
    unixFetchFailure.mockImplementation(() => {
      throw new TypeError("fetch failed", {
        cause: new Error("dispatcher", {
          cause: Object.assign(new Error("connect EACCES"), { code: "EACCES" }),
        }),
      });
    });
    expect(await run(["doctor", "--json"])).toBe(2);
    expect(readOutput()).toMatchObject({
      result: {
        healthy: false,
        local: { socket: { state: "denied" } },
        error: { code: "supervisor_socket_permission_denied" },
      },
    });
    expect(host.requests).toHaveLength(0);
  });

  it.each([
    [
      "EACCES",
      { state: "unverified", executable: null, reason: "protected_directory" },
    ],
    ["ENOENT", { state: "missing", executable: false }],
  ])(
    "distinguishes a protected helper from a missing helper (%s)",
    async (code, expected) => {
      await serve("auto", ["supervisor.doctor"], () => ({
        healthy: true,
        hostId: "auto",
        builderEnabled: true,
        builderReady: true,
      }));
      helperStatFailure.mockImplementation(() => {
        throw Object.assign(new Error(`helper stat ${code}`), { code });
      });
      const exitCode = await run(["doctor", "--json"]);
      const report = readOutput() as {
        result: { local: { issues: string[] } };
      };
      expect(report).toMatchObject({
        result: {
          apiHealthy: true,
          builderReady: true,
          local: { installer: expected },
        },
      });
      const installIssue = report.result.local.issues.some((issue) =>
        issue.includes("host helper"),
      );
      expect(installIssue).toBe(
        process.platform === "linux" && code === "ENOENT",
      );
      expect(exitCode).toBe(report.result.local.issues.length ? 1 : 0);
    },
  );

  it("honors a selected Cloud target and never substitutes the local doctor for an unknown profile", async () => {
    const host = await serve("auto", ["supervisor.doctor"], () => ({}));
    expect(await run(["--profile", "missing", "doctor"])).toBe(1);
    expect(await run(["--profile", "missing", "status"])).toBe(1);
    expect(await run(["profile", "add", "prod", "--cloud"])).toBe(0);
    expect(await run(["profile", "use", "prod"])).toBe(0);
    expect(await run(["doctor"])).toBe(3);
    expect(await run(["status"])).toBe(3);
    expect(host.requests).toHaveLength(0);
  });

  it("discovers a supervisor from a fresh profile store and reports the local OS identity", async () => {
    const host = await serve("auto", ["sandbox.list"], () => ({ items: [] }));
    const cloud = vi.fn();
    vi.stubGlobal("fetch", cloud);
    const { username, uid, gid } = userInfo();
    expect(await run(["auth", "whoami", "--json"])).toBe(0);
    expect(readOutput()).toEqual({
      target: {
        profile: "local",
        type: "local",
        hostId: "auto",
        socket: host.socket,
      },
      result: {
        profile: "local",
        hostId: "auto",
        authentication: "unix-socket",
        username,
        uid,
        gid,
      },
    });
    for (const command of [
      ["supervisor", "status"],
      ["vm", "list"],
    ]) {
      stdout.mockClear();
      expect(await run([...command, "--json"])).toBe(0);
      expect(readOutput()).toMatchObject({
        target: { profile: "local", hostId: "auto" },
      });
    }
    stdout.mockClear();
    expect(await run(["profile", "list", "--json"])).toBe(0);
    expect(readOutput()).toEqual([
      {
        name: "local",
        selected: true,
        target: { type: "local", socket: host.socket },
      },
    ]);
    expect(
      await readFile(
        join(root, "configuration", "profiles", "selected"),
        "utf8",
      ),
    ).toBe("local\n");
    expect(cloud).not.toHaveBeenCalled();
    expect(host.requests.every(({ headers }) => !headers.authorization)).toBe(
      true,
    );
  });

  it("discovers a fresh local profile when listing profiles first", async () => {
    const host = await serve("auto", [], () => ({}));
    expect(await run(["profile", "list", "--json"])).toBe(0);
    expect(readOutput()).toMatchObject([{ name: "local", selected: true }]);
    expect(host.requests.map(({ path }) => path)).toEqual([
      "/api/v1/supervisor",
    ]);
  });

  it("keeps explicit fresh Cloud login and logout on the Cloud path when a local socket exists", async () => {
    const host = await serve("auto", [], () => ({}));
    login.mockResolvedValue({ expiresAt: 123 });
    expect(await run(["auth", "logout", "--json"])).toBe(0);
    expect(readOutput()).toMatchObject({
      authenticated: false,
      profile: "default",
    });
    stdout.mockClear();
    expect(await run(["auth", "login", "--json"])).toBe(0);
    expect(readOutput()).toMatchObject({
      authenticated: true,
      profile: "default",
    });
    expect(login).toHaveBeenCalledOnce();
    expect(host.requests).toHaveLength(0);
  });

  it("preserves explicit Cloud auth and never replaces an existing or unknown selection", async () => {
    const host = await serve("auto", [], () => ({}));
    const cloud = vi.fn(async () => Response.json({ userId: "cloud" }));
    vi.stubGlobal("fetch", cloud);
    vi.stubEnv("BOREALIS_ACCESS_TOKEN", "cloud-token");
    expect(await run(["auth", "whoami", "--json"])).toBe(0);
    expect(readOutput()).toEqual({ userId: "cloud" });
    expect(cloud).toHaveBeenCalledOnce();
    expect(await run(["--profile", "unregistered", "auth", "whoami"])).toBe(1);
    expect(
      await run([
        "profile",
        "add",
        "saved",
        "--local",
        "--socket",
        join(root, "unavailable.sock"),
      ]),
    ).toBe(0);
    expect(await run(["profile", "use", "saved"])).toBe(0);
    expect(await run(["auth", "whoami"])).not.toBe(0);
    stdout.mockClear();
    expect(await run(["profile", "list", "--json"])).toBe(0);
    expect(readOutput()).toMatchObject([{ name: "saved", selected: true }]);
    expect(cloud).toHaveBeenCalledOnce();
    expect(host.requests).toHaveLength(0);
  });

  it.each(["fresh", "legacy", "selected"] as const)(
    "registers a verified local install and preserves a %s selection",
    async (scenario) => {
      const host = await serve("host-1", ["sandbox.list"], () => ({
        items: [],
      }));
      invokeHostHelper.mockImplementation(async (_target, command) =>
        command === "preflight"
          ? {
              ok: true,
              bundleDigest: "a".repeat(64),
              configurationDigest: "b".repeat(64),
            }
          : { status: "installed_unverified" },
      );
      if (scenario === "selected") {
        expect(await run(["profile", "add", "production", "--cloud"])).toBe(0);
        expect(await run(["profile", "use", "production"])).toBe(0);
      }
      if (scenario === "legacy")
        loadSession.mockImplementation(async (name) =>
          name === "default" ? { accessToken: "stored" } : undefined,
        );
      stdout.mockClear();
      expect(
        await run([
          "supervisor",
          "install",
          "--bundle",
          "/bundle",
          "--configuration",
          "/configuration",
          "--socket",
          host.socket,
          "--yes",
          "--json",
        ]),
      ).toBe(0);
      const selected =
        scenario === "selected"
          ? "production"
          : scenario === "legacy"
            ? "default"
            : "local";
      expect(readOutput()).toMatchObject({
        profile: "local",
        selected,
        hostId: "host-1",
      });
      expect(invokeHostHelper.mock.calls.map((entry) => entry[1])).toEqual([
        "preflight",
        "install",
      ]);
      stdout.mockClear();
      expect(
        await run([
          ...(selected !== "local" ? ["--profile", "local"] : []),
          "vm",
          "list",
          "--json",
        ]),
      ).toBe(0);
      expect(readOutput()).toMatchObject({
        target: { hostId: "host-1" },
        result: { items: [] },
      });
      stdout.mockClear();
      expect(await run(["profile", "list", "--json"])).toBe(0);
      expect(readOutput()).toContainEqual(
        expect.objectContaining({ name: selected, selected: true }),
      );
    },
  );

  it("routes ordinary commands through a Unix socket and sends no Cloud credentials", async () => {
    const host = await serve("local", ["sandbox.list"], () => ({
      items: [{ name: "one" }],
    }));
    const cloud = vi.fn();
    vi.stubGlobal("fetch", cloud);
    vi.stubEnv("BOREALIS_ACCESS_TOKEN", "cloud-only");
    await selectLocal(host.socket);
    expect(await run(["vm", "list", "--json"])).toBe(0);
    expect(readOutput()).toEqual({
      target: {
        profile: "local",
        hostId: "local",
        type: "local",
        socket: host.socket,
      },
      result: { items: [{ name: "one" }] },
    });
    expect(host.requests.map((request) => request.path)).toEqual([
      "/api/v1/supervisor",
      "/api/v1/sandboxes",
    ]);
    expect(
      host.requests.every((request) => !request.headers.authorization),
    ).toBe(true);
    expect(await run(["--token", "cloud", "vm", "list"])).toBe(1);
    expect(await run(["auth", "login"])).toBe(3);
    expect(host.requests).toHaveLength(2);
    expect(cloud).not.toHaveBeenCalled();
  });

  it("rejects Cloud-only commands and unavailable sockets without fallback", async () => {
    const real = await serve("local", [], () => ({}));
    const cloud = vi.fn();
    vi.stubGlobal("fetch", cloud);
    await selectLocal(real.socket);
    expect(await run(["cloud", "organization", "list", "--json"])).toBe(3);
    expect(readOutput()).toMatchObject({ error: "unsupported_target" });
    expect(real.requests).toHaveLength(1);
    expect(
      await run([
        "profile",
        "add",
        "unavailable",
        "--local",
        "--socket",
        join(root, "missing"),
      ]),
    ).toBe(0);
    expect(await run(["--profile", "unavailable", "vm", "list"])).toBe(1);
    expect(cloud).not.toHaveBeenCalled();
  });

  it("submits a source image with a durable request and follows its original operation", async () => {
    const host = await serve(
      "local",
      ["sandbox.create", "operation.get"],
      ({ path, body }) =>
        path === "/api/v1/sandboxes"
          ? {
              operationId,
              resourceId: sandboxId,
              status: "queued",
              stage: "Resolving image",
              body: JSON.parse(body.toString()),
            }
          : {
              operationId,
              resourceId: sandboxId,
              status: "succeeded",
              stage: "Starting",
            },
    );
    await selectLocal(host.socket);
    expect(
      await run([
        "vm",
        "create",
        "--name",
        "dev",
        "--image",
        "ubuntu:24.04",
        "--checkpoint-policy",
        "AgentTurn",
        "--enable-nested-containers",
        "--vcpu",
        "2",
        "--wait",
        "--timeout",
        "3",
        "--json",
      ]),
    ).toBe(0);
    expect(host.requests).toHaveLength(3);
    expect(JSON.parse(host.requests[1]!.body.toString())).toEqual({
      image: "ubuntu:24.04",
      enableNestedContainers: true,
      name: "dev",
      runtime: {
        kind: "microvm",
        checkpointPolicy: "AgentTurn",
        resources: { vcpu: 2, memoryMiB: 2048, rootDiskGiB: 20 },
      },
    });
    expect(host.requests[1]!.headers["idempotency-key"]).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    expect(host.requests[2]!.path).toBe(`/api/v1/operations/${operationId}`);
    expect(readOutput()).toMatchObject({
      result: { operationId, resourceId: sandboxId, status: "succeeded" },
    });
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Preparing the VM's source image"),
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Operation completed"),
    );
  });

  it("reports background work and a reusable wait command after accepting an image build", async () => {
    const host = await serve("local", ["runtime_image_build.create"], () => ({
      buildId,
      status: "queued",
      phase: "queued",
    }));
    await selectLocal(host.socket);
    expect(
      await run(["image", "build", "--image", "debian:trixie-slim", "--json"]),
    ).toBe(0);
    expect(readOutput()).toMatchObject({
      result: { buildId, status: "queued" },
    });
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        `is in the background. Follow it with 'borealis --profile local image build status ${buildId} --wait'.`,
      ),
    );
    expect(host.requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
  });

  it("distinguishes a failed status poll after submission from a failed image build", async () => {
    const host = await serve(
      "local",
      ["runtime_image_build.create"],
      ({ method }) => {
        if (method === "POST")
          return { buildId, status: "building", phase: "assembly_execute" };
        throw new Error("Temporary API fault");
      },
    );
    await selectLocal(host.socket);
    expect(
      await run([
        "image",
        "build",
        "--image",
        "debian:trixie-slim",
        "--wait",
        "--timeout",
        "5",
        "--json",
      ]),
    ).toBe(4);
    expect(readOutput()).toMatchObject({
      error: "observation_interrupted",
      resource: { kind: "build", id: buildId },
      message: expect.stringContaining(`image build status ${buildId} --wait`),
    });
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Pulling and preparing the registry image"),
    );
    expect(stderr.mock.calls.map(([value]) => value).join("")).not.toContain(
      "Image is ready",
    );
    expect(host.requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("stops watching on Ctrl+C and leaves the operation available for reconnect", async () => {
    const host = await serve("local", ["operation.get"], () => ({
      operationId,
      status: "running",
      stage: "assessment_malware",
    }));
    await selectLocal(host.socket);
    const controller = new AbortController();
    const waiting = run(
      ["operation", "wait", operationId, "--json"],
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("Scanning for malware"),
      ),
    );
    controller.abort();
    expect(await waiting).toBe(130);
    expect(readOutput()).toMatchObject({
      error: "observation_interrupted",
      resource: { kind: "operation", id: operationId },
      message: expect.stringContaining(`operation wait ${operationId}`),
    });
    expect(host.requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
  });

  it("does not announce a verified upload or submit a build when the file receipt mismatches", async () => {
    const archive = join(root, "archive.tar");
    await writeFile(archive, "local archive bytes");
    const host = await serve("local", ["runtime_image_build.create"], () => ({
      digest: `sha256:${"0".repeat(64)}`,
      sizeBytes: 19,
    }));
    await selectLocal(host.socket);
    expect(await run(["image", "build", "--archive", archive, "--json"])).toBe(
      1,
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        "Reading and hashing the local container archive",
      ),
    );
    expect(stderr.mock.calls.map(([value]) => value).join("")).not.toContain(
      "Supervisor verified",
    );
    expect(host.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
  });

  it("runs vm exec synchronously, preserves stream separation and returns the guest exit code", async () => {
    const host = await serve("local", ["sandbox.exec.transient"], () => ({
      status: "failed",
      exitCode: 7,
      stdout: "one\n",
      stderr: "two\n",
    }));
    await selectLocal(host.socket);
    expect(
      await run([
        "vm",
        "exec",
        sandboxId,
        "--command",
        "/bin/sh",
        "--arg=-c",
        "--arg=exit 7",
        "--timeout",
        "10",
      ]),
    ).toBe(7);
    expect(stdout.mock.calls.map(([value]) => value)).toEqual(["one\n"]);
    expect(stderr.mock.calls.map(([value]) => value)).toEqual(["two\n"]);
    expect(host.requests[1]!.path).toBe(
      `/api/v1/sandboxes/${sandboxId}/exec/transient`,
    );
    expect(JSON.parse(host.requests[1]!.body.toString())).toEqual({
      command: "/bin/sh",
      args: ["-c", "exit 7"],
      timeoutSeconds: 10,
    });
    stdout.mockClear();
    expect(
      await run(["vm", "exec", sandboxId, "--command", "/bin/false", "--json"]),
    ).toBe(7);
    expect(readOutput()).toMatchObject({
      result: { exitCode: 7, stdout: "one\n", stderr: "two\n" },
    });
  });

  it("requires supervisor preflight and the same target for destructive dispatch", async () => {
    const host = await serve("local", ["sandbox.delete"], ({ path }) =>
      path === "/api/v1/preflights"
        ? { preflightToken: "signed" }
        : { operationId, resourceId: sandboxId, status: "queued" },
    );
    await selectLocal(host.socket);
    expect(
      await run([
        "vm",
        "delete",
        sandboxId,
        "--yes",
        "--idempotency-key",
        operationId,
        "--json",
      ]),
    ).toBe(0);
    expect(host.requests[1]!.method).toBe("POST");
    expect(JSON.parse(host.requests[1]!.body.toString())).toEqual({
      operationId: "sandbox.delete",
      target: { sandboxId },
    });
    expect(host.requests[2]!.method).toBe("DELETE");
    expect(host.requests[2]!.headers).toMatchObject({
      "x-borealis-preflight": "signed",
      "idempotency-key": operationId,
    });
    expect(readOutput()).toMatchObject({
      target: { profile: "local" },
      result: { operationId },
    });
  });

  it("uploads a bounded Docker tar with only the selected context and its digest", async () => {
    const outside = join(root, "outside-secret");
    const context = join(root, "context");
    await mkdir(join(context, "fixtures"), { recursive: true });
    await writeFile(outside, "not uploaded");
    await writeFile(
      join(context, ".dockerignore"),
      "*.secret\nfixtures/*\n!fixtures/example.txt\n",
    );
    await writeFile(join(context, "Dockerfile"), "FROM ubuntu:24.04\n");
    await writeFile(join(context, "dev.secret"), "do not upload");
    await writeFile(join(context, "fixtures", "ignore.txt"), "do not upload");
    await writeFile(join(context, "fixtures", "example.txt"), "allowed");
    await symlink(outside, join(context, "external-link.txt"));
    const host = await serve(
      "local",
      ["runtime_image_build.create"],
      ({ method, body }) => {
        if (method === "PUT")
          return {
            digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
            sizeBytes: body.length,
          };
        return { buildId, status: "queued" };
      },
    );
    await selectLocal(host.socket);
    expect(
      await run([
        "image",
        "build",
        "--context",
        context,
        "--dockerfile",
        "Dockerfile",
        "--json",
      ]),
    ).toBe(0);
    const upload = host.requests[1]!;
    const hash = createHash("sha256").update(upload.body).digest("hex");
    expect(upload.path).toBe(`/api/v1/supervisor/artifacts/${hash}`);
    expect(upload.headers["content-length"]).toBe(String(upload.body.length));
    const files: string[] = [];
    const tar = extract();
    await new Promise<void>((resolve, reject) => {
      tar.on("entry", (entry, stream, next) => {
        files.push(entry.name);
        stream.on("end", next);
        stream.resume();
      });
      tar.on("finish", resolve);
      tar.on("error", reject);
      tar.end(upload.body);
    });
    expect(files).toContain("Dockerfile");
    expect(files).toContain("fixtures/example.txt");
    expect(files).not.toContain("fixtures/ignore.txt");
    expect(files).not.toContain("dev.secret");
    expect(files).not.toContain("external-link.txt");
    expect(upload.body.includes("do not upload")).toBe(false);
    expect(JSON.parse(host.requests[2]!.body.toString())).toEqual({
      sourceKind: "dockerfile",
      architecture: "aarch64",
      enableManagedService: true,
      dockerfilePath: "Dockerfile",
      buildContextReference: `sha256:${hash}`,
    });
    expect(readOutput()).toMatchObject({
      result: { buildId, status: "queued" },
    });
  });

  it("passes a Cloud enrollment code as typed helper stdin and keeps observability as the default", async () => {
    const host = await serve("local", [], () => ({}));
    const code = join(root, "enrollment");
    await writeFile(code, "private-code", { mode: 0o600 });
    invokeHostHelper.mockResolvedValue({
      status: "connecting",
      mode: "observability",
    });
    await selectLocal(host.socket);
    expect(
      await run([
        "supervisor",
        "cloud",
        "connect",
        "--control-plane",
        "https://control.example",
        "--enrollment-code-file",
        code,
        "--json",
      ]),
    ).toBe(0);
    const [target, command, settings] = invokeHostHelper.mock.calls[0]!;
    expect(target).toEqual({ type: "local", socket: host.socket });
    expect(command).toBe("cloud-connect");
    expect(JSON.parse(settings.input)).toEqual({
      controlPlane: "https://control.example",
      code: "private-code",
      allowControl: false,
      pool: "default",
    });
    expect(readOutput()).toMatchObject({
      result: { status: "connecting", mode: "observability" },
    });
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("private-code");
    expect(host.requests).toHaveLength(0);
  });

  it("reads the bounded service journal through the fixed helper while events remain API receipts", async () => {
    const host = await serve(
      "local",
      ["supervisor.events", "supervisor.logs"],
      () => ({ items: [{ operationId }] }),
    );
    await selectLocal(host.socket);
    invokeHostHelper.mockResolvedValue({
      items: [{ message: "supervisor started" }],
      truncated: false,
    });
    expect(await run(["supervisor", "logs", "--limit", "7", "--json"])).toBe(0);
    expect(invokeHostHelper.mock.calls[0]?.slice(1, 3)).toEqual([
      "logs",
      { privileged: true, limit: 7 },
    ]);
    expect(readOutput()).toMatchObject({
      result: { items: [{ message: "supervisor started" }] },
    });
    expect(host.requests).toHaveLength(0);
    stdout.mockClear();
    expect(await run(["supervisor", "events", "--limit", "7", "--json"])).toBe(
      0,
    );
    expect(host.requests[1]?.path).toBe("/api/v1/supervisor/events?limit=7");
    expect(readOutput()).toMatchObject({
      result: { items: [{ operationId }] },
    });
  });

  it("validates a managed configuration and applies only with its exact revision", async () => {
    const host = await serve("local", [], () => ({}));
    await selectLocal(host.socket);
    const changes = join(root, "changes.json");
    await writeFile(changes, '{"maximumConcurrentPhysicalStarts":2}');
    invokeHostHelper
      .mockResolvedValueOnce({ valid: true })
      .mockResolvedValueOnce({ status: "applied", restartRequired: true });
    const revision = "a".repeat(64);
    expect(
      await run(["supervisor", "config", "validate", "--file", changes]),
    ).toBe(0);
    stdout.mockClear();
    expect(
      await run([
        "supervisor",
        "config",
        "apply",
        "--file",
        changes,
        "--revision",
        revision,
        "--yes",
        "--json",
      ]),
    ).toBe(0);
    expect(
      invokeHostHelper.mock.calls.map(([, command, options]) => [
        command,
        options,
      ]),
    ).toEqual([
      [
        "config-validate",
        { input: '{"maximumConcurrentPhysicalStarts":2}', privileged: true },
      ],
      [
        "config-apply",
        {
          input: '{"maximumConcurrentPhysicalStarts":2}',
          revision,
          privileged: true,
        },
      ],
    ]);
    expect(readOutput()).toMatchObject({
      result: { status: "applied", restartRequired: true },
    });
  });

  it("applies an exact update plan and follows its retained terminal attempt", async () => {
    const host = await serve("local", [], () => ({}));
    await selectLocal(host.socket);
    invokeHostHelper
      .mockResolvedValueOnce({ status: "queued", attemptId: operationId })
      .mockResolvedValueOnce({
        status: "succeeded",
        attemptId: operationId,
        target: "release",
      });
    expect(
      await run([
        "supervisor",
        "update",
        "apply",
        "--bundle",
        "/release",
        "--plan-id",
        "a".repeat(64),
        "--wait",
        "--timeout",
        "2",
        "--yes",
        "--json",
      ]),
    ).toBe(0);
    expect(
      invokeHostHelper.mock.calls.map(([, command, options]) => [
        command,
        options,
      ]),
    ).toEqual([
      [
        "apply",
        { bundle: "/release", planId: "a".repeat(64), privileged: true },
      ],
      [
        "update-status",
        { attemptId: operationId, nonInteractive: true, privileged: true },
      ],
    ]);
    expect(readOutput()).toMatchObject({
      result: { status: "succeeded", attemptId: operationId },
    });
  });

  it("passes staged release paths as literal SSH arguments for update and uninstall recovery", async () => {
    const { invokeHostHelper: invoke } =
      await vi.importActual<typeof import("./host-helper.js")>(
        "./host-helper.js",
      );
    const helper = "/usr/libexec/borealis/borealis-host";
    await writeFile(
      join(root, "ssh"),
      `#!${process.execPath}
const { execFileSync } = require('node:child_process');
if (process.env.BOREALIS_ACCESS_TOKEN || process.env.BOREALIS_REGISTRY_SECRET) process.exit(3);
const target = process.argv.at(-1);
const decoded = execFileSync('/bin/sh', ['-c', "printf '%s\\\\0' " + target], { encoding: 'utf8' }).split(String.fromCharCode(0));
if (decoded.slice(0, 3).join(' ') !== 'sudo -n --') process.exit(2);
const args = decoded.slice(3, -1);
if (args[0] === '${helper}') process.stdout.write(JSON.stringify(args.slice(1)));
else if (args.slice(0, 4).join(' ') === '/usr/bin/python3 -I -B -c' && args[4].includes('uninstall(recovery_manifest=sys.argv[2])')) {
  process.stdout.write(JSON.stringify(args.slice(5)));
} else process.exit(4);
`,
      { mode: 0o700 },
    );
    vi.stubEnv("BOREALIS_ACCESS_TOKEN", "cloud-only");
    vi.stubEnv("BOREALIS_REGISTRY_SECRET", "registry-only");
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    const profile = {
      type: "ssh" as const,
      alias: "server",
      socket: "/run/borealis/supervisor.sock",
    };
    const bundle = "/var/tmp/release 'one' $(printf unintended) [world]";
    await expect(
      invoke(profile, "plan", { privileged: true, bundle }),
    ).resolves.toEqual(["plan", "--bundle", bundle]);
    await expect(
      invoke(profile, "uninstall", { privileged: true, bundle }),
    ).resolves.toEqual(["uninstall", bundle, "", "with-builder"]);
    await expect(
      invoke(profile, "plan", { privileged: true, bundle: "relative" }),
    ).rejects.toThrow("absolute path on the selected SSH host");
  });

  it("uses a private OpenSSH forward, insists on verified host keys, and preserves the selected profile", async () => {
    const local = await serve("local", ["sandbox.list"], () => ({ items: [] }));
    const remote = await serve(
      "remote",
      ["sandbox.list"],
      () => ({
        items: [],
        page: 1,
        pageSize: 100,
        totalCount: 0,
      }),
      { builderEnabled: false, healthy: true },
    );
    const log = join(root, "ssh.json");
    await writeFile(
      join(root, "ssh"),
      `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.BOREALIS_TEST_SSH_LOG, JSON.stringify(args));
if (args.at(-1) === 'untrusted') {
  process.stderr.write('Host key verification failed.\\n');
  process.exit(255);
}
const [local, remote] = args[args.indexOf('-L') + 1].split(':');
net.createServer(client => {
  const target = net.connect(remote);
  client.pipe(target).pipe(client);
}).listen(local);
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    vi.stubEnv("BOREALIS_TEST_SSH_LOG", log);
    await selectLocal(local.socket);
    expect(
      await run([
        "profile",
        "add",
        "remote",
        "--ssh",
        "lab",
        "--socket",
        remote.socket,
      ]),
    ).toBe(0);
    stdout.mockClear();
    expect(await run(["--profile", "remote", "vm", "list", "--json"])).toBe(0);
    expect(readOutput()).toMatchObject({
      target: { hostId: "remote", type: "ssh", alias: "lab" },
    });
    const args = JSON.parse(await readFile(log, "utf8")) as string[];
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ControlPath=none");
    expect(args).toContain("ExitOnForwardFailure=yes");
    const forward = args[args.indexOf("-L") + 1]!.split(":")[0]!;
    await expect(lstat(forward)).rejects.toHaveProperty("code", "ENOENT");
    stdout.mockClear();
    expect(await run(["--profile", "remote", "status", "--json"])).toBe(0);
    expect(readOutput()).toMatchObject({
      target: { hostId: "remote", type: "ssh", alias: "lab" },
      result: {
        host: { healthy: true },
        vms: { coverage: "complete", totalCount: 0 },
        imageBuilds: { coverage: "disabled" },
      },
    });
    expect(local.requests).toHaveLength(0);
    stdout.mockClear();
    invokeHostHelper.mockImplementation(async (_target, command) =>
      command === "preflight"
        ? {
            ok: true,
            bundleDigest: "a".repeat(64),
            configurationDigest: "b".repeat(64),
          }
        : { status: "installed_unverified" },
    );
    expect(
      await run([
        "--profile",
        "remote",
        "supervisor",
        "install",
        "--bundle",
        "/staging/signed-bundle",
        "--yes",
        "--json",
      ]),
    ).toBe(0);
    expect(readOutput()).toMatchObject({
      profile: "remote",
      selected: "local",
      hostId: "remote",
    });
    expect(
      invokeHostHelper.mock.calls.map(([target, command, options]) => [
        target.type,
        command,
        options.bundle,
      ]),
    ).toEqual([
      ["ssh", "preflight", "/staging/signed-bundle"],
      ["ssh", "install", "/staging/signed-bundle"],
    ]);
    expect(await run(["vm", "list", "--json"])).toBe(0);
    expect(local.requests).toHaveLength(2);
    expect(
      await run(["profile", "add", "untrusted", "--ssh", "untrusted"]),
    ).toBe(0);
    expect(await run(["--profile", "untrusted", "vm", "list"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Host key verification failed"),
    );
    expect(local.requests).toHaveLength(2);
  });
});
