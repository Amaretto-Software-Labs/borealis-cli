import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operations } from "./catalog.js";
import {
  BorealisApiClient,
  implementedTransportOperationIds,
  publishStagedWorkspaceExport,
  validateWorkspaceImportCompletion,
} from "./api-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BorealisApiClient", () => {
  it("maps all eleven first-party transport operations", () => {
    expect(implementedTransportOperationIds).toEqual([
      "destructive.preflight.create",
      "sandbox.workspace.export.resource.create",
      "sandbox.workspace.export.resource.read",
      "sandbox.workspace.import.upload.create",
      "sandbox.workspace.import.upload.status",
      "sandbox.workspace.import.upload.chunk",
      "sandbox.workspace.import.upload.complete",
      "sandbox.exec.stream",
      "registry.create.interactive",
      "service_principal.create.interactive",
      "host_enrollment.create.interactive",
    ]);
  });
  it("sends bearer, organization, and idempotency headers without changing JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"sandboxId":"one"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
      organization: "org-1",
    });
    const operation = operations.find(
      (candidate) => candidate.operationId === "sandbox.create",
    )!;
    await expect(
      client.invoke(operation, {
        path: operation.path,
        query: new URLSearchParams(),
        body: { name: "one" },
        idempotencyKey: "key-1",
      }),
    ).resolves.toEqual({ sandboxId: "one" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toMatchObject({
      authorization: "Bearer secret",
      "x-organization-id": "org-1",
      "idempotency-key": "key-1",
    });
    expect(JSON.parse(init.body)).toEqual({ name: "one" });
  });

  it.each([
    ["network failure", new TypeError("fetch failed")],
    [
      "retryable server response",
      new Response('{"detail":"temporarily unavailable"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    ],
  ])("surfaces the exact idempotency key after %s", async (_, failure) => {
    const fetchMock =
      failure instanceof Response
        ? vi.fn().mockResolvedValue(failure)
        : vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetchMock);
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
    });
    const operation = operations.find(
      (candidate) => candidate.operationId === "sandbox.create",
    )!;
    await expect(
      client.invoke(operation, {
        path: operation.path,
        query: new URLSearchParams(),
        body: { name: "one" },
        idempotencyKey: "018f4c28-dc05-7e91-9f8e-11e421bb8a91",
      }),
    ).rejects.toThrow(
      "Retry with --idempotency-key 018f4c28-dc05-7e91-9f8e-11e421bb8a91",
    );
  });

  it("does not label deterministic client errors as ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"detail":"invalid request"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
    });
    const operation = operations.find(
      (candidate) => candidate.operationId === "sandbox.create",
    )!;
    await expect(
      client.invoke(operation, {
        path: operation.path,
        query: new URLSearchParams(),
        idempotencyKey: "018f4c28-dc05-7e91-9f8e-11e421bb8a91",
      }),
    ).rejects.toThrow("invalid request");
  });

  it("bounds ordinary API requests with a per-request deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async (_url, init: RequestInit) =>
            await new Promise((_, reject) =>
              init.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              ),
            ),
        ),
    );
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
      requestTimeoutMs: 5,
    });
    const operation = operations.find(
      (candidate) => candidate.operationId === "context.get",
    )!;
    await expect(
      client.invoke(operation, {
        path: operation.path,
        query: new URLSearchParams(),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("bounds each in-flight operation-status poll", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async (_url, init: RequestInit) =>
            await new Promise((_, reject) =>
              init.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              ),
            ),
        ),
    );
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
      requestTimeoutMs: 5,
    });
    const waiting = client.waitFor({ statusUri: "/api/v1/operations/one" }, 2);
    await expect(waiting).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("derives and polls the snapshot operation URI from an accepted snapshot", async () => {
    const sandboxId = "1a2ddb9b-71dc-5256-8382-0b0119b49586";
    const requestId = "66de533e-590d-440e-b1c1-3ed16fefa82e";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestId,
          sourceSandboxId: sandboxId,
          status: "completed",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
    });

    await expect(
      client.waitFor(
        { requestId, sourceSandboxId: sandboxId, status: "accepted" },
        2,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `https://api.borealishq.io/api/v1/sandboxes/${sandboxId}/snapshot-operations/${requestId}`,
    );
  });

  it("polls an accepted dedicated workspace status handle at its exact origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          uploadId: "upload-id",
          nextOffset: 10,
          totalLength: 10,
          maximumChunkBytes: 8 * 1024 * 1024,
          committed: true,
          importStatus: "completed",
          importCompletedAt: "2026-08-25T12:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
    });

    await expect(
      client.waitFor(
        {
          uploadId: "upload-id",
          sandboxId: "sandbox-id",
          status: "queued",
          imported: false,
          completedAt: null,
          statusUri:
            "https://uploads-api.borealishq.io/api/v1/workspace-import-uploads/upload-id/status",
        },
        2,
      ),
    ).resolves.toMatchObject({
      uploadId: "upload-id",
      sandboxId: "sandbox-id",
      status: "completed",
      imported: true,
      completedAt: "2026-08-25T12:00:00Z",
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://uploads-api.borealishq.io/api/v1/workspace-import-uploads/upload-id/status",
    );
  });

  it.each([
    [
      "a different upload",
      {
        uploadId: "other-upload",
        nextOffset: 10,
        totalLength: 10,
        committed: true,
        importStatus: "completed",
        importCompletedAt: "2026-08-25T12:00:00Z",
      },
    ],
    [
      "an inconsistent completed state",
      {
        uploadId: "upload-id",
        nextOffset: 9,
        totalLength: 10,
        committed: false,
        importStatus: "completed",
        importCompletedAt: null,
      },
    ],
  ])("rejects workspace status for %s", async (_, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(status), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
    });

    await expect(
      client.waitFor(
        {
          uploadId: "upload-id",
          sandboxId: "sandbox-id",
          status: "processing",
          imported: false,
          completedAt: null,
          statusUri:
            "https://uploads-api.borealishq.io/api/v1/workspace-import-uploads/upload-id/status",
        },
        2,
      ),
    ).rejects.toThrow("invalid workspace import status");
  });

  it("preflights destructive requests and binds the returned token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"preflightToken":"proof"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BorealisApiClient({
      api: "https://api.borealishq.io",
      token: "secret",
    });
    const operation = operations.find(
      (candidate) => candidate.operationId === "sandbox.delete",
    )!;
    await client.invoke(operation, {
      path: "/api/v1/sandboxes/sandbox-1",
      query: new URLSearchParams(),
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      operationId: "sandbox.delete",
      target: { sandboxId: "sandbox-1" },
    });
    expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({
      "x-borealis-preflight": "proof",
    });
  });

  it.each([
    [
      "registry.create.interactive",
      "registry.create",
      "/api/v1/registries/interactive",
      "/api/v1/registries",
    ],
    [
      "service_principal.create.interactive",
      "service_principal.create",
      "/api/v1/service-principals/interactive",
      "/api/v1/service-principals",
    ],
    [
      "host_enrollment.create.interactive",
      "host_enrollment.create",
      "/api/v1/host-pools/pool-1/enrollment-sessions/interactive",
      "/api/v1/host-pools/pool-1/enrollment-sessions",
    ],
  ])(
    "implements bounded %s delivery",
    async (_transportId, operationId, expectedPath, requestPath) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            metadata:
              operationId === "host_enrollment.create"
                ? { hostPoolId: "pool-1" }
                : {},
            claimUri:
              "https://api.borealishq.io/api/v1/credential-claims/018f4c28-dc05-7e91-9f8e-11e421bb8a91",
            expiresAt: "2099-01-01T00:00:00Z",
            requiresAuthentication: true,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = new BorealisApiClient({
        api: "https://api.borealishq.io",
        token: "secret",
      });
      const operation = operations.find(
        (candidate) => candidate.operationId === operationId,
      )!;
      await client.invokeInteractiveCredential(operation, {
        path: requestPath,
        query: new URLSearchParams(),
        body: { name: "example" },
        idempotencyKey: "018f4c28-dc05-7e91-9f8e-11e421bb8a91",
      });
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        `https://api.borealishq.io${expectedPath}`,
      );
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
    },
  );

  it.each([
    ["network failure", new TypeError("fetch failed")],
    ["timeout", new DOMException("timed out", "TimeoutError")],
  ])(
    "surfaces the original idempotency key after an interactive %s",
    async (_, failure) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
      const client = new BorealisApiClient({
        api: "https://api.borealishq.io",
        token: "secret",
      });
      const operation = operations.find(
        (candidate) => candidate.operationId === "registry.create",
      )!;

      await expect(
        client.invokeInteractiveCredential(operation, {
          path: operation.path,
          query: new URLSearchParams(),
          body: { displayName: "example", registryHost: "ghcr.io" },
          idempotencyKey: "018f4c28-dc05-7e91-9f8e-11e421bb8a91",
        }),
      ).rejects.toThrow(
        "Retry with --idempotency-key 018f4c28-dc05-7e91-9f8e-11e421bb8a91",
      );
    },
  );

  it("downloads workspace exports through an authenticated handle and verifies SHA-256", async () => {
    const archive = Buffer.from("tar archive");
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const temporary = await mkdtemp(join(tmpdir(), "borealis-test-"));
    const destination = join(temporary, "workspace.tar");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resourceId: "export-key",
            sandboxId: "sandbox",
            resourceUri:
              "https://api.borealishq.io/api/v1/workspace-export-resources/export-key",
            contentType: "application/x-tar",
            expiresAt: "2099-01-01T00:00:00Z",
            contentLength: archive.length,
            sha256,
            requiresAuthentication: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(archive, {
          status: 200,
          headers: { "content-type": "application/x-tar" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new BorealisApiClient({
        api: "https://api.borealishq.io",
        token: "secret",
      });
      const operation = operations.find(
        (candidate) => candidate.operationId === "sandbox.workspace.export",
      )!;
      await client.invoke(operation, {
        path: "/api/v1/sandboxes/sandbox/workspace/export",
        query: new URLSearchParams(),
        output: destination,
        idempotencyKey: "export-key",
      });
      expect(await readFile(destination)).toEqual(archive);
      expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({
        authorization: "Bearer secret",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("downloads workspace exports whose pre-stream integrity metadata is null", async () => {
    const archive = Buffer.from("tar archive");
    const temporary = await mkdtemp(join(tmpdir(), "borealis-test-"));
    const destination = join(temporary, "workspace.tar");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resourceId: "export-key",
            sandboxId: "sandbox",
            resourceUri:
              "https://api.borealishq.io/api/v1/workspace-export-resources/export-key",
            contentType: "application/x-tar",
            expiresAt: "2099-01-01T00:00:00Z",
            contentLength: null,
            sha256: null,
            requiresAuthentication: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(archive, {
          status: 200,
          headers: { "content-type": "application/x-tar" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new BorealisApiClient({
        api: "https://api.borealishq.io",
        token: "secret",
      });
      const operation = operations.find(
        (candidate) => candidate.operationId === "sandbox.workspace.export",
      )!;
      await expect(
        client.invoke(operation, {
          path: "/api/v1/sandboxes/sandbox/workspace/export",
          query: new URLSearchParams(),
          output: destination,
          idempotencyKey: "export-key",
        }),
      ).resolves.toMatchObject({ bytes: archive.length });
      expect(await readFile(destination)).toEqual(archive);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("aborts a workspace export whose response body stops making progress", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "borealis-test-"));
    const destination = join(temporary, "workspace.tar");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resourceId: "export-key",
            sandboxId: "sandbox",
            resourceUri:
              "https://api.borealishq.io/api/v1/workspace-export-resources/export-key",
            contentType: "application/x-tar",
            expiresAt: "2099-01-01T00:00:00Z",
            requiresAuthentication: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/x-tar" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new BorealisApiClient({
        api: "https://api.borealishq.io",
        token: "secret",
        streamInactivityTimeoutMs: 10,
      });
      const operation = operations.find(
        (candidate) => candidate.operationId === "sandbox.workspace.export",
      )!;
      await expect(
        client.invoke(operation, {
          path: "/api/v1/sandboxes/sandbox/workspace/export",
          query: new URLSearchParams(),
          output: destination,
          idempotencyKey: "export-key",
        }),
      ).rejects.toBeDefined();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("allows active workspace export progress beyond one inactivity interval", async () => {
    const chunks = [
      Buffer.from("one"),
      Buffer.from("two"),
      Buffer.from("three"),
    ];
    const archive = Buffer.concat(chunks);
    const temporary = await mkdtemp(join(tmpdir(), "borealis-test-"));
    const destination = join(temporary, "workspace.tar");
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resourceId: "export-key",
            sandboxId: "sandbox",
            resourceUri:
              "https://api.borealishq.io/api/v1/workspace-export-resources/export-key",
            contentType: "application/x-tar",
            contentLength: archive.length,
            expiresAt: "2099-01-01T00:00:00Z",
            requiresAuthentication: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-tar" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new BorealisApiClient({
        api: "https://api.borealishq.io",
        token: "secret",
        streamInactivityTimeoutMs: 50,
      });
      const operation = operations.find(
        (candidate) => candidate.operationId === "sandbox.workspace.export",
      )!;
      await client.invoke(operation, {
        path: "/api/v1/sandboxes/sandbox/workspace/export",
        query: new URLSearchParams(),
        output: destination,
        idempotencyKey: "export-key",
      });
      expect(await readFile(destination)).toEqual(archive);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("cancels the final export copy without publishing a partial destination", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "borealis-test-"));
    const staged = join(temporary, "staged.tar");
    const destination = join(temporary, "workspace.tar");
    await writeFile(staged, Buffer.alloc(1024 * 1024, 1));
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    try {
      await expect(
        publishStagedWorkspaceExport(staged, destination, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(readFile(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(temporary)).toEqual(["staged.tar"]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("uploads workspace imports in hashed chunks and completes with a preflight", async () => {
    const archive = Buffer.from("tar archive");
    const uploadKey = "018f4c28-dc05-7e91-9f8e-11e421bb8a91";
    const temporary = await mkdtemp(join(tmpdir(), "borealis-test-"));
    const archivePath = join(temporary, "workspace.tar");
    await writeFile(archivePath, archive);
    const json = { "content-type": "application/json" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: uploadKey,
            sandboxId: "sandbox",
            uploadUri: `https://api.borealishq.io/api/v1/workspace-import-uploads/${uploadKey}`,
            maximumBytes: 1024,
            expiresAt: "2099-01-01T00:00:00Z",
            contentType: "application/x-tar",
            requiresAuthentication: true,
          }),
          { status: 200, headers: json },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: uploadKey,
            nextOffset: 0,
            totalLength: 0,
            maximumChunkBytes: 8 * 1024 * 1024,
            committed: false,
          }),
          {
            status: 200,
            headers: json,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: uploadKey,
            nextOffset: archive.length,
            totalLength: archive.length,
            maximumChunkBytes: 8 * 1024 * 1024,
            committed: true,
          }),
          {
            status: 200,
            headers: json,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ preflightToken: "proof" }), {
          status: 200,
          headers: json,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: uploadKey,
            sandboxId: "sandbox",
            status: "completed",
            imported: true,
            completedAt: "2026-08-25T12:00:00Z",
          }),
          { status: 200, headers: json },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new BorealisApiClient({
        api: "https://api.borealishq.io",
        token: "secret",
      });
      const operation = operations.find(
        (candidate) => candidate.operationId === "sandbox.workspace.import",
      )!;
      await expect(
        client.invoke(operation, {
          path: "/api/v1/sandboxes/sandbox/workspace/import-uploads",
          query: new URLSearchParams(),
          body: { archivePath },
          idempotencyKey: uploadKey,
        }),
      ).resolves.toMatchObject({ status: "completed", imported: true });
      expect(fetchMock.mock.calls[2]![1].headers).toMatchObject({
        "content-range": `bytes 0-${archive.length - 1}/${archive.length}`,
        "x-borealis-archive-sha256": createHash("sha256")
          .update(archive)
          .digest("hex"),
      });
      expect(fetchMock.mock.calls[4]![1].headers).toMatchObject({
        "x-borealis-preflight": "proof",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "different upload",
      {
        uploadId: "different",
        sandboxId: "sandbox",
        status: "completed",
        imported: true,
        completedAt: "2026-08-25T12:00:00Z",
      },
    ],
    [
      "inconsistent completion",
      {
        uploadId: "upload-id",
        sandboxId: "sandbox",
        status: "completed",
        imported: false,
        completedAt: "2026-08-25T12:00:00Z",
      },
    ],
    [
      "noncanonical status casing",
      {
        uploadId: "upload-id",
        sandboxId: "sandbox",
        status: "COMPLETED",
        imported: true,
        completedAt: "2026-08-25T12:00:00Z",
      },
    ],
    [
      "missing status",
      {
        uploadId: "upload-id",
        sandboxId: "sandbox",
        imported: true,
        completedAt: "2026-08-25T12:00:00Z",
      },
    ],
    [
      "wrong status handle",
      {
        uploadId: "upload-id",
        sandboxId: "sandbox",
        status: "queued",
        imported: false,
        completedAt: null,
        statusUri:
          "https://api.borealishq.io/api/v1/workspace-import-uploads/other/status",
      },
    ],
    [
      "cross-origin status handle",
      {
        uploadId: "upload-id",
        sandboxId: "sandbox",
        status: "processing",
        imported: false,
        completedAt: null,
        statusUri:
          "https://evil.example/api/v1/workspace-import-uploads/upload-id/status",
      },
    ],
    [
      "relative status handle",
      {
        uploadId: "upload-id",
        sandboxId: "sandbox",
        status: "queued",
        imported: false,
        completedAt: null,
        statusUri: "/api/v1/workspace-import-uploads/upload-id/status",
      },
    ],
  ])("rejects a workspace import completion with %s", (_, completion) => {
    expect(() =>
      validateWorkspaceImportCompletion(
        completion,
        "upload-id",
        "sandbox",
        new URL(
          "https://api.borealishq.io/api/v1/workspace-import-uploads/upload-id",
        ),
      ),
    ).toThrow(/different handle|invalid workspace import/);
  });

  it("accepts only the exact upload-bound pending status handle", () => {
    expect(
      validateWorkspaceImportCompletion(
        {
          uploadId: "upload-id",
          sandboxId: "sandbox",
          status: "queued",
          imported: false,
          completedAt: null,
          statusUri:
            "https://uploads-api.borealishq.io/api/v1/workspace-import-uploads/upload-id/status",
        },
        "upload-id",
        "sandbox",
        new URL(
          "https://uploads-api.borealishq.io/api/v1/workspace-import-uploads/upload-id",
        ),
      ),
    ).toMatchObject({ status: "queued", imported: false });
  });
});
