import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOwnerOnlySecretFile } from "./secret-file.js";

describe("secret input files", () => {
  it("reads owner-only files and rejects broadly readable files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "borealis-secret-"));
    const path = join(directory, "token");
    try {
      await writeFile(path, "secret\n", { mode: 0o600 });
      expect(await readOwnerOnlySecretFile(path)).toBe("secret");
      if (process.platform !== "win32") {
        await chmod(path, 0o644);
        await expect(readOwnerOnlySecretFile(path)).rejects.toThrow(
          /group or other/,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
