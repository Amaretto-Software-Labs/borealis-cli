import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, BorealisApiClient } from "./api-client.js";
import { operations, resolveOperation } from "./catalog.js";
import { prepareRequest } from "./invocation.js";

const requestId = "e8a5c14c-57d4-4bf0-8307-aea8bd50272c";
const vmId = "a535812b-3c64-4888-824c-928530ad9e21";
const vnetId = "d9ca33cb-ec1e-43d6-97e3-3d56de7f1a74";
const attachmentId = "da8ab732-7614-4516-a106-c2c02ff72f7d";
const operation = (id: string) =>
  operations.find((item) => item.operationId === id)!;
const client = () =>
  new BorealisApiClient({
    api: "https://api.example",
    token: "token",
    organization: "tenant-a",
  });
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());

describe("shared private network transports", () => {
  it("exposes every resource family and independent attachment mutations", () => {
    for (const id of [
      "vnet.create",
      "vnet.delete",
      "vnet_attachment.create",
      "vnet_attachment.delete",
      "network_service.create",
      "network_service.update",
      "network_service.delete",
      "vm_network_configuration.get",
      "vm_network_configuration.update",
      "private_network.operation.get",
    ]) {
      const item = operation(id);
      expect(
        resolveOperation(item.command.split(" "))?.operation.operationId,
      ).toBe(id);
      expect(item.requiresPreflight).toBe(false);
      expect(item.scope).toMatch(/^borealis\.networks\./);
    }
  });

  it("requires an explicit stable mutation request and carries the selected VNet", async () => {
    const attach = operation("vnet_attachment.create");
    await expect(
      prepareRequest(attach, [vmId, "--body", JSON.stringify({ vnetId })]),
    ).rejects.toThrow("explicit UUID");
    const request = await prepareRequest(attach, [
      vmId,
      "--idempotency-key",
      requestId,
      "--body",
      JSON.stringify({ vnetId }),
    ]);
    expect(request.path).toBe(
      `/api/v1/sandboxes/${vmId}/runtime/vnet-attachments`,
    );
    expect(request.idempotencyKey).toBe(requestId);
    expect(request.body).toEqual({ vnetId });
  });

  it("puts expected generation in the DELETE query and preserves the original key", async () => {
    const detach = operation("vnet_attachment.delete");
    const request = await prepareRequest(detach, [
      attachmentId,
      "--expected-generation",
      "7",
      "--idempotency-key",
      requestId,
    ]);
    expect(request.query.get("expectedGeneration")).toBe("7");
    expect(request.idempotencyKey).toBe(requestId);
    expect(request.body ?? {}).not.toHaveProperty("expectedGeneration");
    await expect(
      prepareRequest(detach, [
        attachmentId,
        "--expected-generation",
        "7.5",
        "--idempotency-key",
        requestId,
      ]),
    ).rejects.toThrow("exact positive");
  });

  it("keeps inactive persistent membership distinct from connectivity and capability-gates transport", async () => {
    const attach = operation("vnet_attachment.create");
    const request = await prepareRequest(attach, [
      vmId,
      "--idempotency-key",
      requestId,
      "--body",
      JSON.stringify({ vnetId }),
    ]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ enabled: true, operations: [attach.operationId] }),
      )
      .mockResolvedValueOnce(
        json({
          id: attachmentId,
          vmId,
          vnetId,
          privateAddress: "100.96.0.3",
          generation: 1,
          desiredMembership: "present",
          membershipStatus: "attached",
          connectivity: "inactive",
          connectivityReason: "vm_suspended",
          operationId: requestId,
          operationState: "completed",
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(client().invoke(attach, request)).resolves.toMatchObject({
      membershipStatus: "attached",
      connectivity: "inactive",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ enabled: true, operations: [] })),
    );
    await expect(client().invoke(attach, request)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("reads sanitized diagnostics under the exact managed launch identity", async () => {
    const inspect = operation("managed_service.inspect");
    const request = await prepareRequest(inspect, [vmId, requestId]);
    const observation = {
      vmId,
      requestId,
      configurationGeneration: 1,
      state: "ready",
      initialized: true,
      committedGeneration: 1,
      publicationStatus: "committed",
      authorityExpiresAt: new Date().toISOString(),
      diagnostics: {
        logTail: "[REDACTED]\nrecent",
        logTruncated: true,
        probeKind: "tcp",
        probeState: "succeeded",
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ enabled: true, operations: [inspect.operationId] }),
      )
      .mockResolvedValueOnce(json(observation));
    vi.stubGlobal("fetch", fetcher);
    await expect(client().invoke(inspect, request)).resolves.toEqual(
      observation,
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
    expect(request.path).toBe(
      `/api/v1/sandboxes/${vmId}/runtime/managed-service/${requestId}/diagnostics`,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a response for another resource identity", async () => {
    const get = operation("vnet.get");
    const request = await prepareRequest(get, [vnetId]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ enabled: true, operations: [get.operationId] }),
        )
        .mockResolvedValueOnce(
          json({
            id: attachmentId,
            name: "wrong",
            routingDomain: "region",
            generation: 1,
            state: "active",
          }),
        ),
    );
    await expect(client().invoke(get, request)).rejects.toThrow("invalid");
  });
});
