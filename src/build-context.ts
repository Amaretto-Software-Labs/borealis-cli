import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Ignore } from "@balena/dockerignore";
import { pack } from "tar-stream";

const dockerignore = createRequire(import.meta.url)(
  "@balena/dockerignore",
) as (options: { ignorecase: boolean }) => Ignore;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_CONTEXT_ENTRIES = 100_000;
const epoch = new Date(0);
export interface BuildArtifact {
  path: string;
  digest: string;
  sizeBytes: number;
  close(): Promise<void>;
}

async function openRegularFile(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || (await realpath(path)) !== path)
    throw new Error(
      `Build input must be a regular file without symlinks: ${path}`,
    );
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      (await realpath(path)) !== path
    )
      throw new Error(`Build input changed while it was opened: ${path}`);
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readIgnoreFile(path: string): Promise<string | undefined> {
  try {
    const { handle, info } = await openRegularFile(path);
    try {
      if (info.size > 1024 * 1024)
        throw new Error("Docker ignore file exceeds 1 MiB.");
      const buffer = Buffer.alloc(info.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          bytes,
          buffer.length - bytes,
          bytes,
        );
        if (bytesRead === 0) break;
        bytes += bytesRead;
      }
      const current = await handle.stat();
      if (
        bytes !== info.size ||
        current.mtimeMs !== info.mtimeMs ||
        current.ctimeMs !== info.ctimeMs
      )
        throw new Error("Docker ignore file changed during packaging.");
      return buffer.toString("utf8", 0, bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function stageArtifact(
  write: (sink: Transform, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
  onBytes?: (sizeBytes: number) => void,
): Promise<BuildArtifact> {
  const directory = await mkdtemp(join(tmpdir(), "borealis-context-"));
  const path = join(directory, "artifact");
  const close = async (): Promise<void> =>
    await rm(directory, { recursive: true, force: true });
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > MAX_ARTIFACT_BYTES)
        return callback(new Error("Build artifact exceeds 512 MiB."));
      hash.update(chunk);
      onBytes?.(sizeBytes);
      callback(null, chunk);
    },
  });
  const staging = pipeline(
    meter,
    createWriteStream(path, { mode: 0o600, flags: "wx" }),
    { signal },
  );
  const writing = write(meter, signal).catch((error: unknown) => {
    meter.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  });
  try {
    await Promise.all([staging, writing]);
    return { path, digest: `sha256:${hash.digest("hex")}`, sizeBytes, close };
  } catch (error) {
    await Promise.allSettled([staging, writing]);
    await close();
    throw error;
  }
}

export async function stageContainerArchive(
  path: string,
  signal?: AbortSignal,
  onBytes?: (sizeBytes: number) => void,
): Promise<BuildArtifact> {
  return await stageArtifact(
    async (sink) => {
      const absolute = resolve(path);
      const { handle, info } = await openRegularFile(
        join(await realpath(dirname(absolute)), basename(absolute)),
      );
      try {
        if (info.size < 1 || info.size > MAX_ARTIFACT_BYTES)
          throw new Error(
            "Container archive size must be between 1 byte and 512 MiB.",
          );
        await pipeline(handle.createReadStream({ autoClose: false }), sink, {
          signal,
        });
      } finally {
        await handle.close();
      }
    },
    signal,
    onBytes,
  );
}

export async function stageBuildContext(
  context: string,
  dockerfile: string,
  signal?: AbortSignal,
  onBytes?: (sizeBytes: number) => void,
): Promise<{ artifact: BuildArtifact; dockerfilePath: string }> {
  const root = await realpath(context);
  const recipe = relative(root, resolve(root, dockerfile));
  if (
    isAbsolute(dockerfile) ||
    !recipe ||
    recipe === ".." ||
    recipe.startsWith(`..${sep}`) ||
    /[\\\p{Cc}]/u.test(recipe)
  )
    throw new Error(
      "--dockerfile must name a regular file inside the build context.",
    );
  const dockerfilePath = recipe.split(sep).join("/");
  const matcher = dockerignore({ ignorecase: false }).add(
    (await readIgnoreFile(join(root, `${recipe}.dockerignore`))) ??
      (await readIgnoreFile(join(root, ".dockerignore"))) ??
      "",
  );

  return {
    artifact: await stageArtifact(
      async (sink) => {
        const tar = pack();
        const archiving = pipeline(tar, sink, { signal });
        let scanned = 0;
        let recipeIncluded = false;
        const addDirectory = async (directory: string): Promise<void> => {
          if ((await realpath(directory)) !== directory)
            throw new Error(
              "A build context directory changed into a symlink.",
            );
          const children = await readdir(directory, { withFileTypes: true });
          children.sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
          );
          for (const child of children) {
            signal?.throwIfAborted();
            if (++scanned > MAX_CONTEXT_ENTRIES)
              throw new Error("Build context exceeds 100,000 entries.");
            const path = join(directory, child.name);
            const entry = relative(root, path).split(sep).join("/");
            if (/[\\\p{Cc}]/u.test(entry))
              throw new Error(
                "Build context contains an invalid archive path.",
              );
            const isRecipe = entry === dockerfilePath;
            if (child.isDirectory()) {
              if (!matcher.ignores(`${entry}/`))
                await addEmptyDirectory(tar, entry);
              // A later negated pattern can reinclude a child of an excluded directory.
              await addDirectory(path);
            } else if (
              child.isFile() &&
              (isRecipe || !matcher.ignores(entry))
            ) {
              const { handle, info } = await openRegularFile(path);
              try {
                if (info.size > MAX_ARTIFACT_BYTES)
                  throw new Error(
                    "Build context contains a file larger than 512 MiB.",
                  );
                await pipeline(
                  handle.createReadStream({ autoClose: false }),
                  tar.entry({
                    name: entry,
                    size: info.size,
                    mtime: epoch,
                    mode: info.mode & 0o100 ? 0o755 : 0o644,
                  }),
                  { signal },
                );
                if (isRecipe) recipeIncluded = true;
              } finally {
                await handle.close();
              }
            }
          }
        };
        const collecting = (async () => {
          try {
            await addDirectory(root);
            if (!recipeIncluded)
              throw new Error(
                "The Dockerfile was missing or was a symbolic link.",
              );
            tar.finalize();
          } catch (error) {
            tar.destroy(
              error instanceof Error ? error : new Error(String(error)),
            );
            throw error;
          }
        })();
        await Promise.all([archiving, collecting]);
      },
      signal,
      onBytes,
    ),
    dockerfilePath,
  };
}

async function addEmptyDirectory(
  tar: ReturnType<typeof pack>,
  name: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const entry = tar.entry(
      { name, type: "directory", mtime: epoch, mode: 0o755 },
      (error) => (error ? reject(error) : resolve()),
    );
    entry.on("error", reject);
  });
}
