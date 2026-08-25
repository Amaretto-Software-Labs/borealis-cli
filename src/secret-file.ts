import { lstat, readFile } from "node:fs/promises";

export async function readOwnerOnlySecretFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(
      `Secret file '${path}' must be a regular file, not a symlink.`,
    );
  if (metadata.size > 65_536)
    throw new Error(`Secret file '${path}' exceeds 64 KiB.`);
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o077) !== 0)
      throw new Error(
        `Secret file '${path}' must not be readable or writable by group or other users.`,
      );
    if (process.getuid && metadata.uid !== process.getuid())
      throw new Error(
        `Secret file '${path}' must be owned by the current user.`,
      );
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`Secret file '${path}' is empty.`);
  return value;
}
