import { describe, expect, it } from "vitest";
import { operations, resolveOperation } from "./catalog.js";

describe("public operation catalog", () => {
  it("contains 91 base and 65 conditional Runtime v2 operations", () => {
    expect(operations).toHaveLength(156);
    expect(
      operations.some((operation) =>
        operation.operationId.startsWith("admin."),
      ),
    ).toBe(false);
    expect(
      new Set(operations.map((operation) => operation.operationId)).size,
    ).toBe(156);
    const commands = operations.flatMap(({ command }) =>
      command ? command.split(" / ") : [],
    );
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands).toHaveLength(156);
  });

  it("exposes explicit image staging as a retryable preparation operation", () => {
    const stage = operations.find(
      (operation) => operation.operationId === "runtime_image_template.stage",
    );
    expect(stage).toMatchObject({
      method: "POST",
      command: "runtime-image template stage",
      path: "/api/v1/runtime-image-templates/{templateId}/{revision}/stage",
      scope: "borealis.runtime-images.write",
      idempotency: "target-state",
      retry: "safe",
    });
  });

  it("resolves every command and prefers the longest command path", () => {
    for (const operation of operations) {
      if (!operation.command) continue;
      for (const command of operation.command.split(" / ")) {
        expect(
          resolveOperation(command.split(" "))?.operation.operationId,
        ).toBe(operation.operationId);
      }
    }
    expect(
      resolveOperation(["sandbox", "exec", "get", "sandbox", "exec"])?.operation
        .operationId,
    ).toBe("sandbox.exec.get");
    expect(
      resolveOperation(["billing", "usage", "summary"])?.operation.operationId,
    ).toBe("billing.usage.get");
  });

  it("preserves CLI aliases and SDK-only tunnel reservations without MCP names", () => {
    const tunnels = operations.filter(({ operationId }) =>
      operationId.startsWith("tunnel."),
    );
    expect(tunnels).toHaveLength(5);
    expect(tunnels.every(({ mcpName }) => mcpName === null)).toBe(true);
    expect(resolveOperation(["tunnel", "http"])?.operation.operationId).toBe(
      "tunnel.attach",
    );
    expect(resolveOperation(["tunnel", "tcp"])?.operation.operationId).toBe(
      "tunnel.attach",
    );
    expect(resolveOperation(["tunnel", "reserve"])).toBeUndefined();
  });

  it("never exposes internal or unversioned paths", () => {
    for (const operation of operations) {
      expect(operation.path).toMatch(/^\/api\/v1\//);
      expect(operation.path).not.toMatch(/control|internal/);
      expect(operation.path).not.toMatch(/^\/v1\//);
    }
  });

  it("preserves public operation safety metadata", () => {
    expect(
      operations.filter(
        (operation) => operation.idempotency === "idempotency-key",
      ),
    ).toHaveLength(48);
    expect(
      operations.filter((operation) => operation.paging === "page"),
    ).toHaveLength(11);
    expect(
      operations.filter((operation) => operation.requiresPreflight),
    ).toHaveLength(14);
    expect(
      operations
        .filter((operation) => operation.requiresPreflight)
        .every((operation) => operation.risk === "destructive"),
    ).toBe(true);
  });
});
