import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { completion } from "./completion.js";

describe("public command completions", () => {
  it.each(["bash", "zsh", "fish"])("omits internal commands in %s", (shell) => {
    const script = completion(shell);
    expect(script).toContain("vm");
    expect(script).toContain("image");
    expect(script).not.toMatch(
      /logical-machine|runtime-image|private-network|host-pool|sandbox/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "completes nested Bash commands on an explicit target",
    () => {
      const script =
        completion("bash") +
        `
COMP_WORDS=(borealis --profile lab image build st)
COMP_CWORD=5
_borealis
printf '%s\\n' "\${COMPREPLY[@]}"
`;
      const result = spawnSync("bash", ["--noprofile", "--norc"], {
        input: script,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("status\n");
    },
  );
});
