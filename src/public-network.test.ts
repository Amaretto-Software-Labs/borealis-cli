import { describe, expect, it, vi } from "vitest";
import { bindNetworkGeneration } from "./public-network.js";
import { publicOperations } from "./public-commands.js";
import type { PreparedRequest } from "./invocation.js";

const networkId = "d9ca33cb-ec1e-43d6-97e3-3d56de7f1a74";
const otherId = "da8ab732-7614-4516-a106-c2c02ff72f7d";
const vmId = "a535812b-3c64-4888-824c-928530ad9e21";
const requestId = "e8a5c14c-57d4-4bf0-8307-aea8bd50272c";
const operation = (id: string) =>
  publicOperations.find(({ operation }) => operation.operationId === id)!
    .operation;

function request(
  path: string,
  body?: Record<string, unknown>,
): PreparedRequest {
  return {
    path,
    query: new URLSearchParams(),
    idempotencyKey: requestId,
    ...(body ? { body } : {}),
  };
}

describe("public private-network concurrency binding", () => {
  it("reads the exact network and sends its generation while retaining the request key", async () => {
    const client = {
      invoke: vi.fn().mockResolvedValue({ id: networkId, generation: 13 }),
    };
    const prepared = request(`/api/v1/vnets/${networkId}`);
    await bindNetworkGeneration(client, operation("vnet.delete"), prepared, []);
    expect(client.invoke).toHaveBeenCalledOnce();
    expect(client.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "vnet.get", method: "GET" }),
      expect.objectContaining({ path: prepared.path }),
    );
    expect(prepared.query.get("expectedGeneration")).toBe("13");
    expect(prepared.idempotencyKey).toBe(requestId);
  });

  it.each([
    { id: otherId, generation: 1 },
    { id: networkId, generation: 0 },
    { id: networkId, generation: 1.5 },
    { id: networkId, generation: "1" },
  ])(
    "refuses unverified identity or generation without changing the request: %j",
    async (response) => {
      const client = { invoke: vi.fn().mockResolvedValue(response) };
      const prepared = request(`/api/v1/vnets/${networkId}`);
      await expect(
        bindNetworkGeneration(client, operation("vnet.delete"), prepared, []),
      ).rejects.toThrow("Could not verify");
      expect(prepared.query.has("expectedGeneration")).toBe(false);
      expect(prepared.idempotencyKey).toBe(requestId);
      expect(
        client.invoke.mock.calls.every(([read]) => read.method === "GET"),
      ).toBe(true);
    },
  );

  it("binds a service from its network-scoped inventory and preserves its requested target", async () => {
    const client = {
      invoke: vi.fn().mockResolvedValue([
        { id: vmId, vnetId: networkId, generation: 8 },
        { id: otherId, vnetId: networkId, generation: 4 },
      ]),
    };
    const prepared = request(`/api/v1/network-services/${otherId}`, {
      targetAttachmentId: vmId,
    });
    await bindNetworkGeneration(
      client,
      operation("network_service.update"),
      prepared,
      ["--network", networkId],
    );
    expect(client.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "network_service.list",
        method: "GET",
      }),
      expect.objectContaining({ path: `/api/v1/vnets/${networkId}/services` }),
    );
    expect(prepared.body).toEqual({
      targetAttachmentId: vmId,
      expectedGeneration: 4,
    });
  });

  it("rejects a same-ID service from a different network", async () => {
    const client = {
      invoke: vi
        .fn()
        .mockResolvedValue([{ id: otherId, vnetId: vmId, generation: 4 }]),
    };
    const prepared = request(`/api/v1/network-services/${otherId}`);
    await expect(
      bindNetworkGeneration(
        client,
        operation("network_service.delete"),
        prepared,
        ["--network", networkId],
      ),
    ).rejects.toThrow("Could not verify");
    expect(prepared.query.has("expectedGeneration")).toBe(false);
  });

  it("requires a service's network before any request", async () => {
    const client = { invoke: vi.fn() };
    await expect(
      bindNetworkGeneration(
        client,
        operation("network_service.delete"),
        request(`/api/v1/network-services/${otherId}`),
        [],
      ),
    ).rejects.toThrow("--network");
    expect(client.invoke).not.toHaveBeenCalled();
  });

  it("retains clearing the VM default DNS attachment while binding its own generation", async () => {
    const client = {
      invoke: vi.fn().mockResolvedValue({ vmId, generation: 9 }),
    };
    const prepared = request(`/api/v1/sandboxes/${vmId}/runtime/network`, {
      defaultDnsAttachmentId: null,
    });
    await bindNetworkGeneration(
      client,
      operation("vm_network_configuration.update"),
      prepared,
      [],
    );
    expect(client.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "vm_network_configuration.get",
        method: "GET",
      }),
      expect.objectContaining({ path: prepared.path }),
    );
    expect(prepared.body).toEqual({
      defaultDnsAttachmentId: null,
      expectedGeneration: 9,
    });
  });

  it("does not add a generation read to a network creation", async () => {
    const client = { invoke: vi.fn() };
    const prepared = request("/api/v1/vnets", {
      name: "dev",
      routingDomain: "home",
    });
    await bindNetworkGeneration(client, operation("vnet.create"), prepared, []);
    expect(client.invoke).not.toHaveBeenCalled();
    expect(prepared.body).toEqual({ name: "dev", routingDomain: "home" });
  });
});
