import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { operations } from "./catalog.js";
import {
  prepareRequest,
  readBoundedSecretStdin,
  targetFromPath,
} from "./invocation.js";

const operation = (id: string) =>
  operations.find((candidate) => candidate.operationId === id)!;

describe("request preparation", () => {
  it("binds every public operation to a concrete versioned route", async () => {
    for (const candidate of operations) {
      const identifiers = [...candidate.path.matchAll(/\{[^}]+\}/g)].map(
        (_, index) => `id-${index}`,
      );
      const args =
        candidate.operationId === "billing.auto_top_up.configure"
          ? ["--disable"]
          : identifiers;
      const request = await prepareRequest(candidate, args);
      expect(request.path).toMatch(/^\/api\/v1\//);
      expect(request.path).not.toContain("{");
    }
  });
  it("binds path identifiers, paging, and organization-safe query fields", async () => {
    const request = await prepareRequest(operation("host.list"), [
      "--pool",
      "pool-1",
      "--page",
      "2",
      "--page-size",
      "25",
    ]);
    expect(request.path).toBe("/api/v1/host-pools/pool-1/hosts");
    expect(request.query.toString()).toBe("page=2&pageSize=25");
  });

  it("generates and preserves idempotency keys for keyed creates", async () => {
    const generated = await prepareRequest(operation("sandbox.create"), [
      "--body",
      '{"name":"demo"}',
    ]);
    expect(generated.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const explicit = await prepareRequest(operation("sandbox.create"), [
      "--idempotency-key",
      "018f4c28-dc05-7e91-9f8e-11e421bb8a91",
    ]);
    expect(explicit.idempotencyKey).toBe(
      "018f4c28-dc05-7e91-9f8e-11e421bb8a91",
    );
    expect(explicit.body).toEqual(undefined);
  });

  it("preserves every character after the first inline option separator", async () => {
    const request = await prepareRequest(
      operation("service_principal.create"),
      [
        '--body={"name":"automation=a"}',
        "--set=description=managed=externally",
        "--output=/tmp/credential=name",
      ],
    );

    expect(request.body).toEqual({
      name: "automation=a",
      description: "managed=externally",
    });
    expect(request.output).toBe("/tmp/credential=name");
  });

  it("prepares inline wait timeouts as validated typed metadata", async () => {
    const request = await prepareRequest(operation("snapshot.create"), [
      "sandbox-a",
      "--wait",
      "--timeout=123",
    ]);
    expect(request.waitTimeoutSeconds).toBe(123);
    await expect(
      prepareRequest(operation("snapshot.create"), [
        "sandbox-a",
        "--wait",
        "--timeout=21601",
      ]),
    ).rejects.toThrow("integer from 1 to 21600");
  });

  it("derives preflight targets only from route identifiers", async () => {
    const request = await prepareRequest(operation("host.evict"), [
      "pool-a",
      "host-b",
      "--reason",
      "maintenance",
    ]);
    expect(targetFromPath(operation("host.evict"), request.path)).toEqual({
      poolId: "pool-a",
      hostId: "host-b",
    });
    expect(request.body).toEqual({ reason: "maintenance" });
  });

  it("preserves registry secret sources in the public request body", async () => {
    process.env.BOREALIS_REGISTRY_SECRET = "registry-secret";
    try {
      const request = await prepareRequest(operation("registry.create"), [
        "--name",
        "registry",
        "--host",
        "ghcr.io",
        "--username",
        "robot",
      ]);
      expect(request.body).toMatchObject({
        displayName: "registry",
        registryHost: "ghcr.io",
        username: "robot",
        secret: "registry-secret",
      });
    } finally {
      delete process.env.BOREALIS_REGISTRY_SECRET;
    }
  });

  it("bounds registry secrets read from stdin to 64 KiB", async () => {
    await expect(
      readBoundedSecretStdin(Readable.from([Buffer.alloc(65_537, "x")])),
    ).rejects.toThrow("exceeds 64 KiB");
    await expect(
      readBoundedSecretStdin(Readable.from([Buffer.alloc(65_536, "x")])),
    ).resolves.toHaveLength(65_536);
  });

  it("stops waiting for a registry secret when the caller cancels", async () => {
    const stream = new Readable({ read() {} });
    const controller = new AbortController();
    const reading = readBoundedSecretStdin(stream, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
  });

  it("does not overwrite explicit template contract bodies", async () => {
    const body = {
      displayName: "Node",
      defaults: { name: "node", image: "node:22", idleTimeoutMinutes: 30 },
    };
    const request = await prepareRequest(operation("template.create"), [
      "--body",
      JSON.stringify(body),
    ]);
    expect(request.body).toEqual(body);
  });

  it("shapes template fields supplied through --set into the API contract", async () => {
    const request = await prepareRequest(operation("template.create"), [
      "--set",
      "displayName=Node",
      "--set",
      "image=node:22",
    ]);
    expect(request.body).toEqual({
      displayName: "Node",
      defaults: {
        name: "Node",
        image: "node:22",
        idleTimeoutMinutes: 60,
      },
    });
  });

  it("preserves string input and maps operation-specific request fields", async () => {
    const stdin = await prepareRequest(operation("interactive.stdin"), [
      "session-id",
      "--data",
      '{"literal":true}',
      "--newline",
    ]);
    expect(stdin.body).toEqual({
      data: '{"literal":true}',
      addNewLine: true,
    });

    const principal = await prepareRequest(
      operation("service_principal.create"),
      ["--name", "automation", "--scope", "read", "--scope", "write"],
    );
    expect(principal.body).toEqual({
      name: "automation",
      scopes: ["read", "write"],
    });
  });

  it("preserves legacy explicit route aliases without consuming another identifier", async () => {
    const host = await prepareRequest(operation("host.get"), [
      "host-a",
      "--pool",
      "pool-a",
    ]);
    expect(host.path).toBe("/api/v1/host-pools/pool-a/hosts/host-a");

    const snapshot = await prepareRequest(operation("snapshot.operation.get"), [
      "request-a",
      "--sandbox",
      "sandbox-a",
    ]);
    expect(snapshot.path).toBe(
      "/api/v1/sandboxes/sandbox-a/snapshot-operations/request-a",
    );
  });

  it("maps snapshot request IDs and billing requests to their public contracts", async () => {
    const snapshot = await prepareRequest(operation("snapshot.create"), [
      "--sandbox",
      "sandbox-a",
      "--request-id",
      "request-a",
    ]);
    expect(snapshot.idempotencyKey).toBe("request-a");
    expect(snapshot.body).toBeUndefined();

    const autoTopUp = await prepareRequest(
      operation("billing.auto_top_up.configure"),
      ["--enable", "--threshold", "100", "--target", "1000"],
    );
    expect(autoTopUp.body).toEqual({
      enabled: true,
      thresholdMicrocredits: 100,
      targetMicrocredits: 1000,
    });
    await expect(
      prepareRequest(operation("billing.auto_top_up.configure"), ["--enable"]),
    ).rejects.toThrow("requires a non-negative --threshold");

    const topUp = await prepareRequest(operation("billing.top_up.create"), [
      "--microcredits",
      "1000",
      "--success-url",
      "https://example.com/success",
      "--cancel-url",
      "https://example.com/cancel",
      "--idempotency-key",
      "request-a",
    ]);
    expect(topUp.idempotencyKey).toBe("request-a");
    expect(topUp.body).toMatchObject({
      microcredits: 1000,
      idempotencyKey: "request-a",
    });
  });

  it("maps sandbox compatibility options without compatibility commands", async () => {
    const create = await prepareRequest(operation("sandbox.create"), [
      "--name",
      "demo",
      "--image",
      "node:22",
      "--port",
      "8080:80",
      "--no-start",
    ]);
    expect(create.body).toMatchObject({
      name: "demo",
      image: "node:22",
      exposedPorts: [
        {
          containerPort: 80,
          hostPort: 8080,
          protocol: "tcp",
          expose: true,
        },
      ],
      startImmediately: false,
    });

    const workspace = await prepareRequest(
      operation("sandbox.workspace.import"),
      ["sandbox-a", "workspace.tar", "--keep"],
    );
    expect(workspace.body).toMatchObject({ clearWorkspace: false });
  });
});
