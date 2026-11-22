import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { validateOrigin } from "./config.js";
import { isGuid } from "./guid.js";
import {
  helperCommands,
  invokeHostHelper,
  waitForHostUpdate,
} from "./host-helper.js";
import { optionValue, readBoundedSecretStdin } from "./invocation.js";
import { writeResult } from "./output.js";
import {
  defaultSocket,
  parseProfileTarget,
  ProfileStore,
  targetLabel,
  type ProfileTarget,
  type SupervisorTarget,
} from "./profiles.js";
import { readOwnerOnlySecretFile } from "./secret-file.js";
import {
  directClient,
  discoverSupervisor,
  parseSupervisorDiscovery,
  UnsupportedTargetError,
} from "./supervisor-client.js";
import {
  connectSupervisor,
  LocalSocketPermissionError,
} from "./supervisor-transport.js";
import type { GlobalOptions } from "./types.js";

type ConfirmAction = (action: string) => Promise<boolean>;

export async function runProfileCommand(
  profiles: ProfileStore,
  command: string[],
  json: boolean,
  signal?: AbortSignal,
): Promise<number> {
  const name = command[2];
  if (command[1] === "list") {
    const result = await profiles.list(signal);
    if (json) writeResult(result, true);
    else
      for (const profile of result)
        process.stdout
          .write(`${profile.selected ? "* " : "  "}${targetLabel(profile.name, profile.target)}
`);
    return 0;
  }
  if (command[1] === "use" && name) {
    await profiles.select(name, false, signal);
    writeResult({ selected: name }, json);
    return 0;
  }
  if (command[1] === "add" && name) {
    const alias = optionValue(command, "--ssh");
    const local = command.includes("--local");
    const cloud = command.includes("--cloud");
    const socket = optionValue(command, "--socket");
    if (
      Number(local) + Number(cloud) + Number(alias !== undefined) !== 1 ||
      (cloud && socket)
    )
      throw new Error(
        "Specify exactly one profile target with --local, --ssh <alias>, or --cloud. --socket applies to direct targets.",
      );
    const target: ProfileTarget = cloud
      ? { type: "cloud" }
      : alias
        ? { type: "ssh", alias, socket: socket ?? defaultSocket }
        : { type: "local", socket: socket ?? defaultSocket };
    await profiles.add(name, target, signal);
    writeResult({ name, target }, json);
    return 0;
  }
  throw new Error("profile requires add, list, or use.");
}

export async function installSupervisor(
  profiles: ProfileStore,
  options: GlobalOptions,
  command: string[],
  profileExplicit: boolean,
  confirm: ConfirmAction,
  signal?: AbortSignal,
): Promise<number> {
  const name = profileExplicit ? options.profile : "local";
  const existing = await profiles.find(name, signal);
  const socket = optionValue(command, "--socket");
  if (existing?.type === "cloud")
    throw new UnsupportedTargetError(
      `Profile '${name}' identifies Cloud. Choose a direct host profile name.`,
    );
  if (profileExplicit && !existing)
    throw new Error(
      `Unknown Borealis profile '${name}'. Use 'borealis profile add' first.`,
    );
  const target = parseProfileTarget(
    existing?.type === "ssh"
      ? { ...existing, socket: socket ?? existing.socket }
      : { type: "local", socket: socket ?? existing?.socket ?? defaultSocket },
  ) as SupervisorTarget;
  if (existing && target.socket !== existing.socket)
    throw new Error(
      `Profile '${name}' identifies a different socket. Choose another profile name.`,
    );
  const label =
    target.type === "local"
      ? `this machine using ${targetLabel(name, target)}`
      : targetLabel(name, target);
  process.stderr.write(`Installing on ${label}
`);
  const helperOptions = {
    bundle: optionValue(command, "--bundle")!,
    ...(optionValue(command, "--configuration")
      ? { configuration: optionValue(command, "--configuration")! }
      : {}),
    ...(command.includes("--without-builder") ? { withoutBuilder: true } : {}),
  };
  const report = (value: unknown): void => {
    process.stderr.write(`${JSON.stringify(value, null, 2)}
`);
  };
  const preflight = await invokeHostHelper(
    target,
    "preflight",
    { ...helperOptions, privileged: true },
    signal,
    report,
  );
  report(preflight);
  const checked = preflight as {
    ok?: boolean;
    bundleDigest?: string;
    configurationDigest?: string;
  } | null;
  if (
    checked?.ok !== true ||
    !/^[0-9a-f]{64}$/.test(checked.bundleDigest ?? "") ||
    !/^[0-9a-f]{64}$/.test(checked.configurationDigest ?? "")
  )
    throw new Error(
      "The host installation preflight did not establish prerequisites and signed input digests.",
    );
  if (!options.yes && !(await confirm(`supervisor install on ${label}`)))
    throw new Error(
      "Supervisor install cancelled. Pass --yes for non-interactive use.",
    );
  const installation = await invokeHostHelper(
    target,
    "install",
    {
      ...helperOptions,
      privileged: true,
      expected: [checked.bundleDigest!, checked.configurationDigest!],
    },
    signal,
    report,
  );
  const transport = await connectSupervisor(target, signal);
  try {
    const probe = async () => {
      const deadline = Date.now() + 10_000;
      const client = directClient(
        transport,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(11_000)])
          : AbortSignal.timeout(11_000),
      );
      while (true) {
        try {
          return await discoverSupervisor(client);
        } catch (error) {
          if (
            signal?.aborted ||
            !(error instanceof TypeError) ||
            Date.now() >= deadline
          )
            throw error;
          await delay(250, undefined, { signal });
        }
      }
    };
    let membershipRefreshRequired = false;
    const supervisor = await probe().catch(async (error: unknown) => {
      if (
        error instanceof LocalSocketPermissionError &&
        target.type === "local" &&
        target.socket === defaultSocket
      ) {
        const evidence = await invokeHostHelper(
          target,
          "probe",
          { privileged: true },
          signal,
        );
        membershipRefreshRequired = true;
        process.stderr.write(
          `The management API is responding. ${error.message}\n`,
        );
        return parseSupervisorDiscovery(evidence);
      }
      report(installation);
      throw new Error(
        `The helper installed files but the supervisor socket/API could not be verified at ${target.socket}. Run 'borealis doctor' to check the service and socket.`,
        { cause: error },
      );
    });
    const installed = installation as {
      releaseId?: string;
      evidence?: { hostId?: string };
    } | null;
    if (
      (installed?.releaseId &&
        supervisor.releaseRevision !== installed.releaseId) ||
      (installed?.evidence?.hostId &&
        supervisor.hostId !== installed.evidence.hostId)
    )
      throw new Error(
        "The responding supervisor identity differs from the installed release or host identity.",
      );
    if (target.type === "local") await profiles.add(name, target, signal);
    const selected =
      target.type === "local"
        ? await profiles.select(name, true, signal)
        : ((await profiles.selected(signal)) ?? null);
    if (selected !== name && !options.json) {
      if (selected) process.stderr.write(`Preserved profile '${selected}'.\n`);
      process.stderr.write(`Switch with 'borealis profile use ${name}'.\n`);
    }
    writeResult(
      {
        installation,
        profile: name,
        selected,
        hostId: supervisor.hostId,
        membershipRefreshRequired,
      },
      options.json,
    );
    return (installation as { status?: string } | null)?.status ===
      "installed_incomplete" || supervisor.healthy === false
      ? 3
      : 0;
  } finally {
    await transport.close();
  }
}

async function cloudConnectInput(
  command: string[],
  signal?: AbortSignal,
): Promise<string> {
  const origin = validateOrigin(
    optionValue(command, "--control-plane")!,
    "Control-plane URL",
  );
  if (!origin.startsWith("https://"))
    throw new Error("Cloud attachment requires an HTTPS control-plane origin.");
  const file = optionValue(command, "--enrollment-code-file");
  const stdin = command.includes("--enrollment-code-stdin");
  if (Number(file !== undefined) + Number(stdin) !== 1)
    throw new Error(
      "Specify one enrollment code source with --enrollment-code-file or --enrollment-code-stdin.",
    );
  const code = file
    ? (await readOwnerOnlySecretFile(file)).trim()
    : await readBoundedSecretStdin(
        process.stdin,
        signal,
        "Host enrollment code",
      );
  if (!code || code.length > 4096 || /\p{Cc}/u.test(code))
    throw new Error("Use an enrollment code containing 1 to 4096 characters.");
  return JSON.stringify({
    controlPlane: origin,
    code,
    allowControl: command.includes("--enable-control"),
    pool: optionValue(command, "--pool") ?? "default",
  });
}

async function readConfigChanges(path: string): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 16_384)
      throw new Error(
        "Configuration changes must be a regular JSON file up to 16 KiB.",
      );
    const data = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(
        data,
        length,
        data.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size)
      throw new Error("Configuration file changed while it was read.");
    return JSON.stringify(JSON.parse(data.toString("utf8", 0, length)));
  } finally {
    await handle.close();
  }
}

export async function runHostCommand(
  command: string[],
  options: GlobalOptions,
  profile: SupervisorTarget,
  helper: (typeof helperCommands)[string],
  confirm: ConfirmAction,
  signal?: AbortSignal,
): Promise<number> {
  const label = targetLabel(options.profile, profile);
  if (!options.json) process.stderr.write(`Target ${label}\n`);
  const bundle = optionValue(command, "--bundle");
  const planId = optionValue(command, "--plan-id");
  const resume = command.includes("--resume");
  const attemptId = helper.command === "update-status" ? command[3] : undefined;
  const configFile = optionValue(command, "--file");
  const revision = optionValue(command, "--revision");
  const limit = optionValue(command, "--limit");
  const input =
    helper.command === "cloud-connect"
      ? await cloudConnectInput(command, signal)
      : configFile
        ? await readConfigChanges(configFile)
        : undefined;
  const action = command
    .slice(
      0,
      ["cloud", "update", "config", "builder"].includes(command[1] ?? "")
        ? 3
        : 2,
    )
    .join(" ");
  const timeout = optionValue(command, "--timeout");
  const wait = command.includes("--wait");
  const timeoutSeconds = timeout === undefined ? 900 : Number(timeout);
  if (
    timeout !== undefined &&
    (!wait ||
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 21600)
  )
    throw new Error(
      "--timeout requires --wait and must be an integer from 1 to 21600 seconds.",
    );
  if (
    ([
      "stop",
      "restart",
      "apply",
      "cloud-disconnect",
      "config-apply",
      "builder-install",
      "uninstall",
    ].includes(helper.command) ||
      resume) &&
    !options.yes &&
    !(await confirm(`${action} on ${label}`))
  )
    throw new Error(
      "Supervisor action cancelled. Pass --yes for non-interactive use.",
    );
  if (helper.command === "restart")
    await invokeHostHelper(profile, "stop", { privileged: true }, signal);
  let result = await invokeHostHelper(
    profile,
    helper.command === "restart" ? "start" : helper.command,
    {
      ...(helper.privileged ? { privileged: true } : {}),
      ...(bundle ? { bundle } : {}),
      ...(planId ? { planId } : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(resume ? { resume } : {}),
      ...(input ? { input } : {}),
      ...(revision ? { revision } : {}),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    },
    signal,
  );
  if (wait) {
    const accepted = (result as { attemptId?: string } | null)?.attemptId;
    if (!accepted || !isGuid(accepted))
      throw new Error(
        "The host did not return a durable update attempt ID. Inspect 'supervisor update status'.",
      );
    process.stderr.write(`Host update ${accepted} accepted.\n`);
    result = await waitForHostUpdate(
      options.profile,
      accepted,
      timeoutSeconds,
      (observation) =>
        invokeHostHelper(
          profile,
          "update-status",
          {
            privileged: true,
            attemptId: accepted,
            nonInteractive: true,
          },
          observation,
        ),
      signal,
    );
  }
  writeResult(
    options.json
      ? { target: { profile: options.profile, ...profile }, result }
      : result,
    options.json,
  );
  const status = (result as { status?: string } | null)?.status ?? "";
  return ["aborted", "rolled_back", "repair_required", "not_found"].includes(
    status,
  )
    ? 3
    : 0;
}
