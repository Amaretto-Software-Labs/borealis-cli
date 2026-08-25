import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeCredentialFile } from "./credential-file.js";

describe("credential file delivery", () => {
  it("writes an owner-only file without overwriting an existing destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "borealis-credential-"));
    const destination = join(directory, "credential.txt");
    await writeCredentialFile(destination, "one-time-secret");
    expect(await readFile(destination, "utf8")).toBe("one-time-secret");
    if (process.platform !== "win32")
      expect((await stat(destination)).mode & 0o777).toBe(0o600);

    await expect(
      writeCredentialFile(destination, "replacement"),
    ).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("one-time-secret");
  });

  it("does not overwrite a destination created during delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "borealis-credential-"));
    const destination = join(directory, "credential.txt");
    await writeFile(destination, "existing", { mode: 0o600 });
    await expect(writeCredentialFile(destination, "secret")).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("existing");
  });
});
