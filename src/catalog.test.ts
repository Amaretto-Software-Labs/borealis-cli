import { describe, expect, it } from "vitest";
import { operations, resolveOperation } from "./catalog.js";

describe("public operation catalog", () => {
  it("contains exactly the 75 canonical non-admin operations", () => {
    expect(operations).toHaveLength(75);
    expect(
      operations.some((operation) =>
        operation.operationId.startsWith("admin."),
      ),
    ).toBe(false);
    expect(
      new Set(operations.map((operation) => operation.operationId)).size,
    ).toBe(75);
    expect(new Set(operations.map((operation) => operation.command)).size).toBe(
      75,
    );
  });

  it("resolves every command and prefers the longest command path", () => {
    for (const operation of operations) {
      expect(
        resolveOperation(operation.command.split(" "))?.operation.operationId,
      ).toBe(operation.operationId);
    }
    expect(
      resolveOperation(["sandbox", "exec", "get", "sandbox", "exec"])?.operation
        .operationId,
    ).toBe("sandbox.exec.get");
    expect(
      resolveOperation(["billing", "usage", "summary"])?.operation.operationId,
    ).toBe("billing.usage.get");
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
    ).toHaveLength(15);
    expect(
      operations.filter((operation) => operation.paging === "page"),
    ).toHaveLength(11);
    expect(
      operations.filter((operation) => operation.requiresPreflight),
    ).toHaveLength(10);
    expect(
      operations
        .filter((operation) => operation.requiresPreflight)
        .every((operation) => operation.risk === "destructive"),
    ).toBe(true);
  });
});
