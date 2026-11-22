import { describe, expect, it } from "vitest";
import { publicOperations, resolvePublicOperation } from "./public-commands.js";
import {
  createCommandGrammar,
  validateCommandGrammar,
} from "./command-grammar.js";

describe("Commander grammar", () => {
  it("defines each declared public command against a catalog operation", () => {
    const program = createCommandGrammar();
    expect(
      new Set(publicOperations.map(({ operation }) => operation.command)).size,
    ).toBe(publicOperations.length);
    for (const { operation } of publicOperations) {
      let node = program;
      for (const token of operation.command.split(" ")) {
        node = node.commands.find((candidate) => candidate.name() === token)!;
        expect(node).toBeDefined();
      }
      const identifiers = [...operation.path.matchAll(/\{[^}]+\}/g)].map(
        (_, index) => `id-${index}`,
      );
      expect(() =>
        validateCommandGrammar([
          ...operation.command.split(" "),
          ...identifiers,
        ]),
      ).not.toThrow();
      expect(
        resolvePublicOperation([
          ...operation.command.split(" "),
          ...identifiers,
        ]),
      ).toMatchObject({ operation, rest: identifiers });
    }
  });

  it("accepts operation-specific arguments and rejects unknown options", () => {
    expect(() =>
      validateCommandGrammar(["vm", "inspect", "vm-id", "--json"]),
    ).not.toThrow();
    expect(() =>
      validateCommandGrammar(["vm", "exec", "status", "vm-id", "exec-id"]),
    ).not.toThrow();
    expect(() =>
      validateCommandGrammar(["vm", "create", "--body", '{"name":"demo"}']),
    ).not.toThrow();
    expect(() =>
      validateCommandGrammar(["vm", "inspect", "vm-id", "--invented"]),
    ).toThrow();
    expect(() =>
      validateCommandGrammar(["vm", "inspect", "vm-id", "--name", "x"]),
    ).toThrow();
    expect(() =>
      validateCommandGrammar(["vm", "create", "--pool", "pool-id"]),
    ).toThrow();
    expect(() =>
      validateCommandGrammar([
        "vm",
        "create",
        "--request-id",
        "018f4c28-dc05-7e91-9f8e-11e421bb8a91",
      ]),
    ).toThrow();
  });

  it.each([
    "admin",
    "sandbox",
    "logical-machine",
    "runtime-image",
    "runtime-template",
    "vnet",
    "private-network",
    "background",
    "managed",
  ])("does not expose '%s' or aliases", (root) => {
    expect(() => validateCommandGrammar([root, "list"])).toThrow();
  });
});
