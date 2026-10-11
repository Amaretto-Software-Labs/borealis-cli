import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AmbiguousDispatchError,
  ApiError,
  BorealisApiClient,
} from "./api-client.js";
import { operations } from "./catalog.js";
import { prepareRequest } from "./invocation.js";

const key = "e8a5c14c-57d4-4bf0-8307-aea8bd50272c";
const vm = "a535812b-3c64-4888-824c-928530ad9e21";
const wake = operations.find(
  (op) => op.operationId === "logical_machine.wake",
)!;
const client = () =>
  new BorealisApiClient({
    api: "https://api.example",
    token: "tenant-token",
    organization: "tenant-a",
  });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());

describe("Runtime v2 client contract", () => {
  it("cancels the exact queued wake without creating a new request identity", async () => {
    const cancel = operations.find(
      (op) => op.operationId === "logical_machine.wake.cancel",
    )!;
    expect(cancel.idempotency).toBe("target-state");
    const request = await prepareRequest(cancel, [vm, key]);
    expect(request.path).toBe(
      `/api/v1/sandboxes/${vm}/runtime/wakes/${key}/cancel`,
    );
    expect(request.idempotencyKey).toBeUndefined();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ enabled: true, operations: [cancel.operationId] }),
      )
      .mockResolvedValueOnce(
        json({ requestId: key, sandboxId: vm, state: "Cancelled" }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(client().invoke(cancel, request)).resolves.toMatchObject({
      state: "Cancelled",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });

  it("requires a stable caller identity before mutation and preserves checkpoint fields", async () => {
    await expect(prepareRequest(wake, [vm])).rejects.toThrow("explicit UUID");
    const complete = operations.find(
      (op) => op.operationId === "logical_machine.turn.complete",
    )!;
    const request = await prepareRequest(complete, [
      vm,
      vm,
      "--idempotency-key",
      key,
      "--body",
      JSON.stringify({ captureBoundaryId: key, outputWatermark: 42 }),
    ]);
    expect(request.idempotencyKey).toBe(key);
    expect(request.body).toEqual({
      captureBoundaryId: key,
      outputWatermark: 42,
    });
  });

  it("binds recovery and completion to exact activity identities", async () => {
    const recover = operations.find(
      (op) => op.operationId === "logical_machine.turn.activity.recover",
    )!;
    const receipt = operations.find(
      (op) => op.operationId === "logical_machine.turn.activity.recovery.get",
    )!;
    const body = {
      expectedActivityLeaseId: key,
      expectedIncarnationId: vm,
      expectedOwnershipEpoch: 2,
      leaseSeconds: 300,
    };
    const request = await prepareRequest(recover, [
      vm,
      vm,
      "--idempotency-key",
      key,
      "--body",
      JSON.stringify(body),
    ]);
    expect(request.body).toEqual(body);
    expect(request.idempotencyKey).toBe(key);
    expect(recover.scope).toBe("borealis.sandboxes.exec");
    expect(receipt.scope).toBe("borealis.sandboxes.exec");
    const complete = operations.find(
      (op) => op.operationId === "logical_machine.turn.complete",
    )!;
    expect(
      (
        await prepareRequest(complete, [
          vm,
          vm,
          "--idempotency-key",
          key,
          "--body",
          JSON.stringify({
            captureBoundaryId: key,
            outputWatermark: 42,
            expectedActivityLeaseId: vm,
          }),
        ])
      ).body,
    ).toEqual({
      captureBoundaryId: key,
      outputWatermark: 42,
      expectedActivityLeaseId: vm,
    });
    const renew = operations.find(
      (op) => op.operationId === "logical_machine.turn.renew",
    )!;
    expect(
      (
        await prepareRequest(renew, [
          vm,
          vm,
          "--body",
          JSON.stringify({ leaseSeconds: 300, expectedActivityLeaseId: key }),
        ])
      ).body,
    ).toEqual({ leaseSeconds: 300, expectedActivityLeaseId: key });
  });

  it("rejects a recovery receipt from another request without replay", async () => {
    const recover = operations.find(
      (op) => op.operationId === "logical_machine.turn.activity.recover",
    )!;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ enabled: true, operations: [recover.operationId] }),
      )
      .mockResolvedValueOnce(
        json({
          requestId: vm,
          sandboxId: vm,
          turnId: vm,
          activityLeaseId: key,
          incarnationId: vm,
          ownershipEpoch: 2,
          expiresAt: "2030-01-01T00:00:00Z",
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      client().invoke(
        recover,
        await prepareRequest(recover, [
          vm,
          vm,
          "--idempotency-key",
          key,
          "--body",
          JSON.stringify({
            expectedActivityLeaseId: key,
            expectedIncarnationId: vm,
            expectedOwnershipEpoch: 2,
          }),
        ]),
      ),
    ).rejects.toBeInstanceOf(AmbiguousDispatchError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses disabled feature discovery without dispatch", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ enabled: false, operations: [] }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      client().invoke(
        wake,
        await prepareRequest(wake, [vm, "--idempotency-key", key]),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never treats capability lookup failure as an ambiguously accepted mutation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("lookup lost")),
    );
    await expect(
      client().invoke(
        wake,
        await prepareRequest(wake, [vm, "--idempotency-key", key]),
      ),
    ).rejects.not.toBeInstanceOf(AmbiguousDispatchError);
  });

  it("preserves the same request and tenant on explicit retry after a lost response", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: URL, init: RequestInit) => {
        if (init.method === "GET")
          return json({ enabled: true, operations: [wake.operationId] });
        seen.push(init);
        if (seen.length === 1) throw new TypeError("lost accepted response");
        return json({ requestId: key, sandboxId: vm, state: "Requested" });
      }),
    );
    const request = await prepareRequest(wake, [vm, "--idempotency-key", key]);
    await expect(client().invoke(wake, request)).rejects.toMatchObject({
      idempotencyKey: key,
    });
    await client().invoke(wake, request);
    expect(seen).toHaveLength(2);
    for (const init of seen)
      expect(init.headers).toMatchObject({
        "idempotency-key": key,
        "x-organization-id": "tenant-a",
      });
  });

  it("preserves wrong-tenant API denial and does not retry", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ enabled: true, operations: [wake.operationId] }),
      )
      .mockResolvedValueOnce(json({ title: "not_found" }, 404));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      client().invoke(
        wake,
        await prepareRequest(wake, [vm, "--idempotency-key", key]),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves request recovery when a success response identifies another machine", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ enabled: true, operations: [wake.operationId] }),
        )
        .mockResolvedValueOnce(
          json({ requestId: key, sandboxId: key, state: "Committed" }),
        ),
    );
    await expect(
      client().invoke(
        wake,
        await prepareRequest(wake, [vm, "--idempotency-key", key]),
      ),
    ).rejects.toMatchObject({ idempotencyKey: key });
  });

  it("routes standard sandbox start through observed logical binding using the explicit key", async () => {
    const start = operations.find((op) => op.operationId === "sandbox.start")!;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ runtimeKind: "microvm", sandboxId: vm }))
      .mockResolvedValueOnce(json({ sandboxId: vm, logicalState: "Available" }))
      .mockResolvedValueOnce(
        json({ enabled: true, operations: ["logical_machine.start"] }),
      )
      .mockResolvedValueOnce(
        json({ requestId: key, sandboxId: vm, state: "Requested" }),
      );
    vi.stubGlobal("fetch", fetcher);
    await client().invoke(
      start,
      await prepareRequest(start, [vm, "--idempotency-key", key]),
    );
    expect(String(fetcher.mock.calls[3]![0])).toBe(
      `https://api.example/api/v1/sandboxes/${vm}/runtime/start`,
    );
    expect(fetcher.mock.calls[3]![1].headers).toMatchObject({
      "idempotency-key": key,
    });
  });

  it("never generates a new key when standard lifecycle targets Runtime v2", async () => {
    const start = operations.find((op) => op.operationId === "sandbox.start")!;
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ runtimeKind: "microvm", sandboxId: vm }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      client().invoke(start, await prepareRequest(start, [vm])),
    ).rejects.toThrow("explicit UUID");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy container lifecycle during migration", async () => {
    const stop = operations.find((op) => op.operationId === "sandbox.stop")!;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ runtimeKind: "container", sandboxId: vm }))
      .mockResolvedValueOnce(json({ sandboxId: vm, status: "Stopped" }));
    vi.stubGlobal("fetch", fetcher);
    await client().invoke(stop, await prepareRequest(stop, [vm]));
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `https://api.example/api/v1/sandboxes/${vm}/stop`,
    );
  });

  it("polls the original wake and recognizes committed completion", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        json({ requestId: key, sandboxId: vm, state: "Committed" }),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = await client().waitForRuntime(
      { requestId: key, sandboxId: vm, state: "Requested" },
      2,
    );
    expect(result).toMatchObject({ state: "Committed" });
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      `https://api.example/api/v1/sandboxes/${vm}/runtime/wakes/${key}`,
    );
  });

  it("returns an already cancelled receipt without polling", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const receipt = { requestId: key, sandboxId: vm, state: "Cancelled" };
    await expect(client().waitForRuntime(receipt, 2)).resolves.toEqual(receipt);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves cancellation observed while polling mixed-case UUIDs", async () => {
    const receipt = { requestId: key, sandboxId: vm, state: "Cancelled" };
    const fetcher = vi.fn().mockResolvedValue(json(receipt));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      client().waitForRuntime(
        {
          requestId: key.toUpperCase(),
          sandboxId: vm.toUpperCase(),
          state: "Requested",
        },
        2,
      ),
    ).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts matching mixed-case wake request identities", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ enabled: true, operations: [wake.operationId] }),
        )
        .mockResolvedValueOnce(
          json({ requestId: key, sandboxId: vm, state: "Committed" }),
        ),
    );
    await expect(
      client().invoke(
        wake,
        await prepareRequest(wake, [
          vm.toUpperCase(),
          "--idempotency-key",
          key.toUpperCase(),
        ]),
      ),
    ).resolves.toMatchObject({ state: "Committed" });
  });

  it.each([
    "logical_machine.turn.activity.recover",
    "logical_machine.turn.activity.recovery.get",
  ])(
    "accepts matching mixed-case recovery identities for %s",
    async (operationId) => {
      const operation = operations.find(
        (op) => op.operationId === operationId,
      )!;
      const receipt = {
        requestId: key,
        sandboxId: vm,
        turnId: vm,
        activityLeaseId: key,
        incarnationId: vm,
        ownershipEpoch: 2,
        expiresAt: "2030-01-01T00:00:00Z",
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            json({ enabled: true, operations: [operationId] }),
          )
          .mockResolvedValueOnce(json(receipt)),
      );
      const args =
        operation.method === "GET"
          ? [vm.toUpperCase(), vm.toUpperCase(), key.toUpperCase()]
          : [
              vm.toUpperCase(),
              vm.toUpperCase(),
              "--idempotency-key",
              key.toUpperCase(),
              "--body",
              JSON.stringify({
                expectedActivityLeaseId: key.toUpperCase(),
                expectedIncarnationId: vm.toUpperCase(),
                expectedOwnershipEpoch: 2,
              }),
            ];
      await expect(
        client().invoke(operation, await prepareRequest(operation, args)),
      ).resolves.toEqual(receipt);
    },
  );

  it("rejects reconciliation for another machine", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ requestId: key, sandboxId: key, state: "Committed" }),
        ),
    );
    await expect(
      client().waitForRuntime(
        { requestId: key, sandboxId: vm, state: "Requested" },
        2,
      ),
    ).rejects.toThrow("different request or machine");
  });
});
