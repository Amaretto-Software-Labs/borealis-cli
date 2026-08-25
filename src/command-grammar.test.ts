import { describe, expect, it } from "vitest";
import { operations } from "./catalog.js";
import {
  createCommandGrammar,
  validateCommandGrammar,
} from "./command-grammar.js";

describe("Commander grammar", () => {
  it("defines all 75 customer operations as real nested commands", () => {
    const program = createCommandGrammar();
    for (const operation of operations) {
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
    }
  });

  it("accepts operation-specific arguments and rejects unknown options", () => {
    expect(() =>
      validateCommandGrammar(["sandbox", "get", "sandbox-id", "--json"]),
    ).not.toThrow();
    expect(() =>
      validateCommandGrammar([
        "sandbox",
        "exec",
        "get",
        "sandbox-id",
        "exec-id",
      ]),
    ).not.toThrow();
    expect(() =>
      validateCommandGrammar([
        "sandbox",
        "create",
        "--body",
        '{"name":"demo"}',
      ]),
    ).not.toThrow();
    expect(() =>
      validateCommandGrammar(["sandbox", "get", "sandbox-id", "--invented"]),
    ).toThrow();
    expect(() =>
      validateCommandGrammar(["sandbox", "get", "sandbox-id", "--name", "x"]),
    ).toThrow();
    expect(() =>
      validateCommandGrammar(["sandbox", "create", "--pool", "pool-id"]),
    ).toThrow();
    expect(() =>
      validateCommandGrammar([
        "sandbox",
        "create",
        "--request-id",
        "018f4c28-dc05-7e91-9f8e-11e421bb8a91",
      ]),
    ).toThrow();
  });

  it("does not define public admin commands", () => {
    expect(() => validateCommandGrammar(["admin", "host", "list"])).toThrow();
  });
});
