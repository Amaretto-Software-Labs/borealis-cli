import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "./app.js";
import { operations } from "./catalog.js";

function commandNames(help: string): string[] {
  const commands = help.split("Commands:\n")[1]?.split("\n\n")[0] ?? "";
  return commands
    .split("\n")
    .map((line) => /^ {2}([a-z][a-z-]*)/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

async function renderHelp(args: string[]): Promise<string> {
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(await run(args)).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
  return output.mock.calls.map(([chunk]) => String(chunk)).join("");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("rendered CLI help", () => {
  it.each([[], ["help"], ["--help"], ["-h"]])(
    "lists every root command alphabetically for %j",
    async (...args) => {
      const help = await renderHelp(args);
      const names = commandNames(help);
      const expected = [
        ...new Set(
          operations.map((operation) => operation.command.split(" ")[0]!),
        ),
        "auth",
        "completion",
        "help",
        "version",
      ].sort();
      expect(names).toEqual(expected);
      expect(help).toContain("API operations");
    },
  );

  it.each([
    ["sandbox", "--help"],
    ["sandbox", "exec", "--help"],
    ["logical-machine", "--help"],
    ["auth", "--help"],
    ["--profile", "prod", "logical-machine", "--help"],
    ["help", "sandbox"],
  ])("lists nested commands alphabetically for %j", async (...args) => {
    const help = await renderHelp(args);
    const names = commandNames(help);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort());
    expect(help).not.toContain("API operations");
  });

  it("preserves operation flags and identifiers in leaf help", async () => {
    const help = await renderHelp(["logical-machine", "hibernate", "--help"]);
    expect(help).toContain("Usage: borealis logical-machine hibernate");
    expect(help).toContain("--idempotency-key <value>");
    expect(help).toContain("[identifiers...]");
  });
});
