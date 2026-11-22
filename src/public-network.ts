import type { BorealisApiClient } from "./api-client.js";
import { operations } from "./catalog.js";
import { isGuid } from "./guid.js";
import { optionValue, type PreparedRequest } from "./invocation.js";
import type { Operation } from "./types.js";

const generationReads: Readonly<Record<string, string>> = {
  "vnet.delete": "vnet.get",
  "vnet_attachment.delete": "vnet_attachment.get",
  "network_service.update": "network_service.list",
  "network_service.delete": "network_service.list",
  "vm_network_configuration.update": "vm_network_configuration.get",
};

export async function bindNetworkGeneration(
  client: Pick<BorealisApiClient, "invoke">,
  operation: Operation,
  request: PreparedRequest,
  args: readonly string[],
): Promise<void> {
  const readsId = generationReads[operation.operationId];
  if (!readsId) return;
  const read = operations.find(({ operationId }) => operationId === readsId)!;
  const vm = readsId === "vm_network_configuration.get";
  const service = readsId === "network_service.list";
  const body = request.body as Record<string, unknown> | undefined;
  const id = request.path.split("/").at(vm ? -3 : -1);
  const network = service ? optionValue(args, "--network") : undefined;
  if (!id || !isGuid(id))
    throw new Error(`${operation.command} requires a valid resource ID.`);
  if (service && (!network || !isGuid(network)))
    throw new Error(`${operation.command} requires --network NETWORK_ID.`);
  const path = service ? read.path.replace("{vnetId}", network!) : request.path;
  const response = await client.invoke(read, {
    path,
    query: new URLSearchParams(),
  });
  const matches = (item: unknown): item is Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return (
      String(row[vm ? "vmId" : "id"]).toLowerCase() === id.toLowerCase() &&
      (!service ||
        String(row.vNetId ?? row.vnetId).toLowerCase() ===
          network!.toLowerCase())
    );
  };
  const target = Array.isArray(response)
    ? response.find(matches)
    : matches(response)
      ? response
      : undefined;
  const generation = target?.generation;
  if (!Number.isSafeInteger(generation) || Number(generation) < 1)
    throw new Error(
      `Could not verify the current state of the resource for ${operation.command}.`,
    );
  if (operation.method === "DELETE") {
    request.query.set("expectedGeneration", String(generation));
    if (body) delete body.expectedGeneration;
  } else {
    request.body = { ...body, expectedGeneration: generation };
  }
}
