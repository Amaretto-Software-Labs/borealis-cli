import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function writeCredentialFile(
  destination: string,
  secret: string,
): Promise<void> {
  if (!destination.trim()) throw new Error("Credential output path is empty.");
  const target = resolve(destination);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = `${directory}/.${basename(target)}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    if (process.platform === "win32") {
      const { stdout: account } = await execFileAsync("whoami.exe", [], {
        windowsHide: true,
      });
      const owner = account.trim();
      if (!owner)
        throw new Error("Could not resolve the current Windows account.");
      await execFileAsync(
        "icacls.exe",
        [temporary, "/inheritance:r", "/grant:r", `${owner}:(R,W)`],
        { windowsHide: true },
      );
    }
    await file.writeFile(secret, "utf8");
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await file.close();
  try {
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
