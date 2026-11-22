import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isGuid } from "./guid.js";
import type { SupervisorTarget } from "./profiles.js";
import { installerBootstrap } from "./install-bootstrap.js";
import {
  directSubprocessEnvironment,
  verifiedSshOptions,
} from "./supervisor-transport.js";

export const helperPath = "/usr/libexec/borealis/borealis-host";
const helperPaths = [
  "/",
  "/usr",
  "/usr/libexec",
  "/usr/libexec/borealis",
  helperPath,
];

// The installer's mode-0700 directory deliberately prevents the CLI user
// from inspecting the launcher. Inspect the same fixed path as root, then
// replace this process so stdin, exit codes, and signals reach the launcher.
const elevatedHelperBootstrap = `
import os, stat, sys

if os.geteuid() != 0:
    raise SystemExit("Borealis host helper verification requires root.")
paths = ${JSON.stringify(helperPaths)}
helper = paths[-1]
for path in paths:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        raise SystemExit(f"The trusted Borealis host helper at {helper} is required. Install it from a verified host release.")
    except OSError:
        raise SystemExit(f"Could not inspect Borealis host helper path {path} as root.")
    launcher = path == helper
    valid_type = (stat.S_ISREG(info.st_mode) and info.st_mode & stat.S_IXUSR) if launcher else stat.S_ISDIR(info.st_mode)
    if not valid_type or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit(f"Borealis host helper path {path} must be root-owned and protected against writes by other users.")
os.execv(helper, [helper, *sys.argv[1:]])
`;

export function elevatedHostHelperArgs(
  args: readonly string[],
  nonInteractive = false,
): string[] {
  return [
    ...(nonInteractive ? ["-n"] : []),
    "--",
    "/usr/bin/python3",
    "-I",
    "-B",
    "-c",
    elevatedHelperBootstrap,
    ...args,
  ];
}

export const helperCommands: Readonly<
  Record<
    string,
    {
      command: string;
      privileged?: boolean;
      acceptsBundle?: boolean;
    }
  >
> = {
  "supervisor logs": { command: "logs", privileged: true },
  "supervisor config show": { command: "config-show", privileged: true },
  "supervisor config validate": {
    command: "config-validate",
    privileged: true,
  },
  "supervisor config apply": { command: "config-apply", privileged: true },
  "supervisor builder install": {
    command: "builder-install",
    privileged: true,
  },
  "supervisor uninstall": { command: "uninstall", privileged: true },
  "supervisor restart": { command: "restart", privileged: true },
  "supervisor start": { command: "start", privileged: true },
  "supervisor stop": { command: "stop", privileged: true },
  "supervisor repair": { command: "repair", privileged: true },
  "supervisor update check": {
    command: "update-check",
    privileged: true,
    acceptsBundle: true,
  },
  "supervisor update plan": {
    command: "plan",
    privileged: true,
    acceptsBundle: true,
  },
  "supervisor update apply": {
    command: "apply",
    privileged: true,
    acceptsBundle: true,
  },
  "supervisor update status": { command: "update-status", privileged: true },
  "supervisor cloud connect": { command: "cloud-connect", privileged: true },
  "supervisor cloud status": { command: "cloud-status", privileged: true },
  "supervisor cloud disconnect": {
    command: "cloud-disconnect",
    privileged: true,
  },
};

async function checkHelper(): Promise<void> {
  for (const path of helperPaths) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(
          `The trusted Borealis host bootstrap at ${helperPath} is required. Install it from a verified host release before running this command.`,
        );
      throw error;
    });
    const isHelper = path === helperPath;
    if (
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      (isHelper && (!info.isFile() || (info.mode & 0o100) === 0)) ||
      (!isHelper && !info.isDirectory())
    )
      throw new Error(
        `Borealis host bootstrap path ${path} must be root-owned and protected against writes by other users.`,
      );
  }
}

function hostPath(
  target: SupervisorTarget,
  path: string,
  flag: string,
): string {
  if (target.type === "local") return resolve(path);
  if (!posix.isAbsolute(path) || path.length > 4096 || /\p{Cc}/u.test(path))
    throw new Error(
      `${flag} must be an absolute path on the selected SSH host.`,
    );
  return path;
}

// OpenSSH sends a command string to the remote login shell. Quote every typed
// argument so it arrives as one literal argv value, including POSIX paths.
function quoteSshArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function remoteHelperArgs(
  target: Extract<SupervisorTarget, { type: "ssh" }>,
  args: string[],
): string[] {
  return [
    ...verifiedSshOptions(),
    "-T",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "RemoteCommand=none",
    "--",
    target.alias,
    args.map(quoteSshArgument).join(" "),
  ];
}

export async function invokeHostHelper(
  target: SupervisorTarget,
  command: string,
  settings: {
    privileged?: boolean;
    bundle?: string;
    configuration?: string;
    expected?: [string, string];
    withoutBuilder?: boolean;
    input?: string;
    planId?: string;
    attemptId?: string;
    resume?: boolean;
    revision?: string;
    limit?: number;
    nonInteractive?: boolean;
  },
  signal?: AbortSignal,
  onFailure?: (data: unknown) => void,
): Promise<unknown> {
  signal?.throwIfAborted();
  const args = [command];
  if (settings.bundle)
    args.push("--bundle", hostPath(target, settings.bundle, "--bundle"));
  if (settings.configuration)
    args.push(
      "--configuration",
      hostPath(target, settings.configuration, "--configuration"),
    );
  if (settings.planId) {
    if (!/^[0-9a-f]{64}$/.test(settings.planId))
      throw new Error("--plan-id must identify an exact update plan.");
    args.push("--plan-id", settings.planId);
  }
  if (settings.attemptId) {
    if (!isGuid(settings.attemptId))
      throw new Error("Update attempt ID must be a UUID.");
    args.push("--attempt-id", settings.attemptId);
  }
  if (settings.resume) args.push("--resume");
  if (settings.revision) {
    if (!/^[0-9a-f]{64}$/.test(settings.revision))
      throw new Error("--revision must be an exact configuration digest.");
    args.push("--revision", settings.revision);
  }
  if (settings.limit !== undefined) {
    if (
      !Number.isInteger(settings.limit) ||
      settings.limit < 1 ||
      settings.limit > 1000
    )
      throw new Error("--limit must be an integer between 1 and 1000.");
    args.push("--limit", String(settings.limit));
  }
  let executable: string;
  let invocation: string[];
  if (
    ["preflight", "install"].includes(command) ||
    (command === "uninstall" && settings.bundle)
  ) {
    if (target.type === "local" && process.platform !== "linux")
      throw new Error(
        "Running the Borealis host bootstrap requires a Linux host.",
      );
    if (!settings.bundle)
      throw new Error("Host installation requires a signed bundle.");
    const python = [
      "/usr/bin/python3",
      "-I",
      "-B",
      "-c",
      installerBootstrap,
      command,
      hostPath(target, settings.bundle, "--bundle"),
      settings.configuration
        ? hostPath(target, settings.configuration, "--configuration")
        : "",
      settings.withoutBuilder ? "without-builder" : "with-builder",
      ...(settings.expected ?? []),
    ];
    if (target.type === "ssh") {
      executable = "ssh";
      invocation = remoteHelperArgs(target, ["sudo", "-n", "--", ...python]);
    } else {
      [executable, ...invocation] =
        process.getuid?.() === 0
          ? (python as [string, ...string[]])
          : ["sudo", "--", ...python];
    }
  } else if (target.type === "local") {
    if (process.platform !== "linux")
      throw new Error(
        "Installing and servicing a local Borealis runtime requires a Linux host.",
      );
    if (settings.privileged && process.geteuid?.() !== 0) {
      executable = "/usr/bin/sudo";
      invocation = elevatedHostHelperArgs(args, settings.nonInteractive);
    } else {
      await checkHelper();
      executable = helperPath;
      invocation = args;
    }
  } else {
    if (
      settings.configuration ||
      ![
        "start",
        "stop",
        "repair",
        "cloud-connect",
        "cloud-status",
        "cloud-disconnect",
        "update-status",
        "update-check",
        "plan",
        "apply",
        "probe",
        "config-show",
        "config-validate",
        "config-apply",
        "builder-install",
        "uninstall",
        "logs",
      ].includes(command)
    )
      throw new Error(
        "This host helper requires a verified local installation bundle on the Linux host.",
      );
    executable = "ssh";
    invocation = remoteHelperArgs(target, [
      ...(settings.privileged ? ["sudo", "-n", "--"] : []),
      helperPath,
      ...args,
    ]);
  }

  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(executable, invocation, {
      env: directSubprocessEnvironment(),
      stdio: [
        settings.input !== undefined
          ? "pipe"
          : target.type === "ssh"
            ? "ignore"
            : "inherit",
        "pipe",
        "inherit",
      ],
      ...(signal ? { signal } : {}),
    });
    if (settings.input !== undefined) {
      child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin!.end(settings.input);
    }
    const output: Buffer[] = [];
    let bytes = 0;
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        child.kill("SIGTERM");
        reject(
          new Error("Borealis host helper exceeded its 1 MiB response limit."),
        );
      } else output.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      let data: unknown;
      const stdout = Buffer.concat(output).toString("utf8").trim();
      if (stdout) {
        try {
          data = JSON.parse(stdout);
        } catch {
          reject(
            new Error(
              "Borealis host helper returned an invalid JSON response.",
            ),
          );
          return;
        }
      }
      if (code !== 0) {
        if (data !== undefined) onFailure?.(data);
        reject(
          new Error(
            `Borealis host helper '${command}' exited with status ${String(code)}.`,
          ),
        );
      } else if (data === undefined) {
        reject(new Error("Borealis host helper returned no JSON response."));
      } else resolve(data);
    });
  });
}

export class HostUpdateObservationError extends Error {
  constructor(
    readonly profile: string,
    readonly attemptId: string,
    options?: ErrorOptions,
  ) {
    super(
      `Update observation ended. Reconcile with 'borealis --profile ${profile} supervisor update status ${attemptId}'.`,
      options,
    );
  }
}

export async function waitForHostUpdate(
  profile: string,
  attemptId: string,
  timeoutSeconds: number,
  read: (signal: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
  const observation = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let previous: string | undefined;
  try {
    while (true) {
      observation.throwIfAborted();
      const update = (await read(observation)) as {
        attemptId?: string;
        status?: string;
      } | null;
      if (update?.attemptId !== attemptId || typeof update.status !== "string")
        throw new Error(
          "The host did not return the requested update attempt.",
        );
      if (update.status !== previous) {
        previous = update.status;
        process.stderr.write(`Host update ${attemptId}: ${update.status}\n`);
      }
      if (
        ["succeeded", "rolled_back", "aborted", "repair_required"].includes(
          update.status,
        )
      )
        return update;
      await delay(1000, undefined, { signal: observation });
    }
  } catch (error) {
    throw new HostUpdateObservationError(profile, attemptId, { cause: error });
  }
}
