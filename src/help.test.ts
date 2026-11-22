import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "./app.js";

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
        "auth",
        "cloud",
        "completion",
        "doctor",
        "help",
        "image",
        "network",
        "operation",
        "profile",
        "status",
        "supervisor",
        "version",
        "vm",
      ];
      expect(names).toEqual(expected);
      expect(help).toContain("borealis vm create --name dev --image");
      expect(help).not.toContain("API operations");
    },
  );

  it.each([
    ["vm", "--help"],
    ["vm", "exec", "--help"],
    ["image", "--help"],
    ["auth", "--help"],
    ["--profile", "prod", "network", "--help"],
    ["help", "vm"],
  ])("lists nested commands alphabetically for %j", async (...args) => {
    const help = await renderHelp(args);
    const names = commandNames(help);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort());
    expect(help).not.toContain("API operations");
  });

  it("preserves operation flags and identifiers in leaf help", async () => {
    const help = await renderHelp(["vm", "inspect", "--help"]);
    expect(help).toContain("Usage: borealis vm inspect");
    expect(help).toContain("[vm-id]");
    expect(help).not.toContain("sandbox.get");
  });
});
