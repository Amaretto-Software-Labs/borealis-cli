import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { configDirectory } from "./config.js";
import { loadSession } from "./session-store.js";

export const defaultSocket = "/run/borealis/supervisor.sock";
const profileName = z
  .string()
  .regex(
    /^[A-Za-z0-9._-]{1,64}$/,
    "Profile names may contain only 1-64 letters, digits, dots, underscores, or hyphens.",
  );
const socketPath = z
  .string()
  .min(1)
  .refine(
    (value) => isAbsolute(value) && !/[:\p{Cc}]/u.test(value),
    "Supervisor socket must be an absolute path without colons or control characters.",
  );
const sshAlias = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/,
    "Use an OpenSSH configuration alias without a username, port, or options.",
  );
const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cloud") }).strict(),
  z.object({ type: z.literal("local"), socket: socketPath }).strict(),
  z
    .object({ type: z.literal("ssh"), alias: sshAlias, socket: socketPath })
    .strict(),
]);
export type ProfileTarget = z.infer<typeof targetSchema>;
export type SupervisorTarget = Exclude<ProfileTarget, { type: "cloud" }>;
export const noTargetMessage =
  "No Borealis profile is selected. Run 'borealis supervisor install', 'borealis profile use <name>', or 'borealis auth login' for Cloud.";

export function parseProfileTarget(target: ProfileTarget): ProfileTarget {
  return targetSchema.parse(target);
}

export function targetLabel(name: string, target: ProfileTarget): string {
  if (target.type === "cloud") return `Cloud profile '${name}'`;
  const location =
    target.type === "local"
      ? target.socket
      : `${target.alias}:${target.socket}`;
  return `profile '${name}' (${target.type}, ${location})`;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(
  path: string,
  contents: string,
  replace: boolean,
): Promise<boolean> {
  const staging = `${path}.${randomUUID()}.tmp`;
  await writeFile(staging, contents, { mode: 0o600, flag: "wx" });
  try {
    if (replace) await rename(staging, path);
    else await link(staging, path);
    return true;
  } catch (error) {
    if (!replace && (error as NodeJS.ErrnoException).code === "EEXIST")
      return false;
    throw error;
  } finally {
    await rm(staging, { force: true });
  }
}

export class ProfileStore {
  constructor(private readonly directory = join(configDirectory, "profiles")) {}

  private profilePath(name: string): string {
    return join(this.directory, `${profileName.parse(name)}.json`);
  }

  async get(name: string): Promise<ProfileTarget | undefined> {
    const data = await readOptional(this.profilePath(name));
    return data === undefined
      ? undefined
      : targetSchema.parse(JSON.parse(data));
  }

  async find(
    name: string,
    signal?: AbortSignal,
  ): Promise<ProfileTarget | undefined> {
    return (
      (await this.get(name)) ??
      ((await loadSession(name, signal)) ? { type: "cloud" } : undefined)
    );
  }

  async selected(signal?: AbortSignal): Promise<string | undefined> {
    const stored = await readOptional(join(this.directory, "selected"));
    if (stored !== undefined) return profileName.parse(stored.trimEnd());
    return (await loadSession("default", signal)) ? "default" : undefined;
  }

  async add(
    name: string,
    target: ProfileTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = this.profilePath(name);
    const validated = targetSchema.parse(target);
    if (target.type !== "cloud" && (await loadSession(name, signal)))
      throw new Error(
        `Profile '${name}' already has Cloud credentials. Choose another profile name.`,
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    if (
      !(await writeAtomic(path, JSON.stringify(validated), false)) &&
      !isDeepStrictEqual(await this.get(name), validated)
    )
      throw new Error(
        `Profile '${name}' already identifies a different target. Choose another profile name.`,
      );
  }

  async select(
    name: string,
    whenUnconfigured: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!(await this.find(name, signal)))
      throw new Error(`Unknown Borealis profile '${name}'.`);
    const previous = whenUnconfigured ? await this.selected(signal) : undefined;
    if (previous) return previous;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    await writeAtomic(
      join(this.directory, "selected"),
      `${name}\n`,
      !whenUnconfigured,
    );
    return (await this.selected(signal))!;
  }

  async list(
    signal?: AbortSignal,
  ): Promise<{ name: string; target: ProfileTarget; selected: boolean }[]> {
    const names = await readdir(this.directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const selected = await this.selected(signal);
    const profiles = new Map<string, ProfileTarget>();
    for (const file of names.filter((file) => file.endsWith(".json"))) {
      const name = file.slice(0, -5);
      profiles.set(name, (await this.get(name))!);
    }
    if (selected && !profiles.has(selected)) {
      const target = await this.find(selected, signal);
      if (target) profiles.set(selected, target);
    }
    return [...profiles]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, target]) => ({ name, target, selected: name === selected }));
  }
}
