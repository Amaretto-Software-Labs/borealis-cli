import type { Operation } from "./types.js";

function standaloneOperation(
  operationId: string,
  command: string,
  method: Operation["method"],
  path: string,
  risk: Operation["risk"] = "read",
): Operation {
  return {
    operationId,
    command,
    method,
    path,
    risk,
    scope: "supervisor socket",
    clientMethod: operationId,
    mcpName: operationId,
    ownership: "subject",
    idempotency: method === "GET" ? "safe" : "idempotency-key",
    retry: method === "GET" ? "safe" : "never-after-dispatch",
    paging: "none",
    requiresPreflight: risk === "destructive",
  };
}

export const standaloneOperations = [
  standaloneOperation(
    "supervisor.status",
    "supervisor status",
    "GET",
    "/api/v1/supervisor",
  ),
  standaloneOperation(
    "supervisor.doctor",
    "supervisor doctor",
    "GET",
    "/api/v1/supervisor/doctor",
  ),
  standaloneOperation(
    "supervisor.events",
    "supervisor events",
    "GET",
    "/api/v1/supervisor/events",
  ),
  standaloneOperation(
    "supervisor.logs",
    "supervisor logs",
    "GET",
    "/api/v1/supervisor/logs",
  ),
  standaloneOperation(
    "sandbox.pause",
    "sandbox pause",
    "POST",
    "/api/v1/sandboxes/{sandboxId}/pause",
    "write",
  ),
  standaloneOperation(
    "runtime_image_build.list",
    "runtime-image list",
    "GET",
    "/api/v1/runtime-image-builds",
  ),
  standaloneOperation(
    "operation.get",
    "operation get",
    "GET",
    "/api/v1/operations/{operationId}",
  ),
  standaloneOperation(
    "operation.get",
    "operation wait",
    "GET",
    "/api/v1/operations/{operationId}",
  ),
];

export const standaloneOperationIds = new Set(
  standaloneOperations.map(({ operationId }) => operationId),
);
