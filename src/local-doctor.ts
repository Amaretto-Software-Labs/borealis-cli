import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { helperPath } from "./host-helper.js";
import { writeResult } from "./output.js";
import { defaultSocket } from "./profiles.js";
import {
  directClient,
  discoverSupervisor,
  doctorRequestTimeoutMs,
  requireSupport,
} from "./supervisor-client.js";
import {
  connectSupervisor,
  localSocketError,
  LocalSocketPermissionError,
} from "./supervisor-transport.js";
import type { GlobalOptions, Operation } from "./types.js";

const runCommand = promisify(execFile);
const serviceUnit = "borealis-standalone-supervisor.service";
const limits = {
  timeout: 2_500,
  maxBuffer: 8_192,
  killSignal: "SIGKILL",
} as const;

async function serviceState(signal?: AbortSignal) {
  if (process.platform !== "linux") return { activeState: "unavailable" };
  try {
    const { stdout } = await runCommand(
      "/usr/bin/systemctl",
      [
        "show",
        "--no-pager",
        "--property=ActiveState,SubState,Result",
        serviceUnit,
      ],
      { ...limits, signal },
    );
    const fields = new Map(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2) as [string, string]),
    );
    return {
      activeState: fields.get("ActiveState") ?? "unknown",
      subState: fields.get("SubState"),
      result: fields.get("Result"),
    };
  } catch {
    signal?.throwIfAborted();
    return { activeState: "unavailable" };
  }
}

async function groupName(
  gid: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const { stdout } = await runCommand(
      "/usr/bin/getent",
      ["group", String(gid)],
      { ...limits, signal },
    );
    const [name, , groupId] = stdout.trim().split(":");
    return typeof name === "string" && groupId === String(gid)
      ? name
      : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

interface SocketCheck {
  path: string;
  state: "missing" | "invalid" | "unavailable" | "denied" | "accessible";
  mode?: string;
  uid?: number;
  gid?: number;
  group?: string;
  processInGroup?: boolean;
}

interface InstallerCheck {
  path: string;
  state: "present" | "missing" | "invalid" | "unverified";
  executable: boolean | null;
  reason?: "protected_directory" | "stat_failed";
}

async function inspectInstaller(): Promise<InstallerCheck> {
  try {
    const info = await lstat(helperPath);
    const executable = info.isFile() && Boolean(info.mode & 0o111);
    return {
      path: helperPath,
      state: executable ? "present" : "invalid",
      executable,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { path: helperPath, state: "missing", executable: false }
      : {
          path: helperPath,
          state: "unverified",
          executable: null,
          reason:
            code === "EACCES" || code === "EPERM"
              ? "protected_directory"
              : "stat_failed",
        };
  }
}

async function inspectSocket(
  path: string,
  signal?: AbortSignal,
): Promise<{ socket: SocketCheck; error?: Error }> {
  const socket: SocketCheck = { path, state: "unavailable" };
  try {
    const info = await stat(path);
    socket.mode = `0${(info.mode & 0o777).toString(8).padStart(3, "0")}`;
    socket.uid = info.uid;
    socket.gid = info.gid;
    const group = await groupName(info.gid, signal);
    if (group !== undefined) socket.group = group;
    if (process.getgroups)
      socket.processInGroup = process.getgroups().includes(info.gid);
    if (!info.isSocket()) {
      socket.state = "invalid";
      return {
        socket,
        error: new Error(`The path ${path} is not a Unix socket.`),
      };
    }
    await access(path, constants.W_OK);
    socket.state = "accessible";
    return { socket };
  } catch (error) {
    signal?.throwIfAborted();
    const failure = localSocketError(
      error,
      path,
      socket.group,
      socket.processInGroup,
    );
    if (failure instanceof LocalSocketPermissionError) {
      socket.state = "denied";
      return { socket, error: failure };
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      socket.state = "missing";
      return {
        socket,
        error: new Error(
          `No management socket found at ${path}. Check the supervisor service or run 'borealis supervisor install' to install it.`,
        ),
      };
    }
    return {
      socket,
      error: new Error(`Could not inspect the management socket at ${path}.`, {
        cause: error,
      }),
    };
  }
}

export async function runLocalDoctor(
  operation: Operation,
  socketPath: string,
  options: GlobalOptions,
  signal?: AbortSignal,
): Promise<number> {
  const [installer, service, { socket, error }] = await Promise.all([
    inspectInstaller(),
    serviceState(signal),
    inspectSocket(socketPath, signal),
  ]);
  const issues: string[] = [];
  if (process.platform === "linux" && socketPath === defaultSocket) {
    if (installer.executable === false)
      issues.push(
        "The standalone host helper is unavailable. Use 'borealis supervisor install' with a verified host bundle.",
      );
    if (service.activeState !== "active")
      issues.push(
        `Check the supervisor service with 'systemctl status ${serviceUnit}'.`,
      );
  }
  const local = {
    installer,
    service: { unit: serviceUnit, ...service },
    socket,
    issues,
  };
  const target = {
    profile: options.profile,
    type: "local",
    socket: socketPath,
  };
  let hostId: string | undefined;
  let failure = error;
  let result: Record<string, unknown> = {};
  if (!failure) {
    if (!options.json)
      process.stderr.write("Checking the management API and image builder.\n");
    const transport = await connectSupervisor(
      { type: "local", socket: socketPath },
      signal,
    );
    try {
      const client = directClient(transport, signal);
      const discovery = await discoverSupervisor(client, 5_000);
      hostId = discovery.hostId;
      requireSupport(discovery, operation);
      const payload = await client.supervisorRequest(
        "GET",
        operation.path,
        doctorRequestTimeoutMs,
      );
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !("hostId" in payload) ||
        payload.hostId !== hostId ||
        !("healthy" in payload) ||
        typeof payload.healthy !== "boolean"
      )
        throw new Error("Supervisor returned an invalid health report.");
      result = payload as Record<string, unknown>;
    } catch (cause) {
      signal?.throwIfAborted();
      failure =
        cause instanceof LocalSocketPermissionError
          ? cause
          : new Error(
              `Could not complete the management API health check. Check the service with 'systemctl status ${serviceUnit}'.`,
              { cause },
            );
      if (failure instanceof LocalSocketPermissionError)
        socket.state = "denied";
    } finally {
      await transport.close();
    }
  }
  const apiHealthy = !failure && result.healthy === true;
  const healthy =
    apiHealthy &&
    issues.length === 0 &&
    !(result.builderEnabled === true && result.builderReady !== true);
  const errorInfo = failure && {
    code:
      failure instanceof LocalSocketPermissionError
        ? failure.code
        : "supervisor_doctor_check_failed",
    message: failure.message,
  };
  const report = {
    ...result,
    apiHealthy,
    healthy,
    local,
    ...(errorInfo && { error: errorInfo }),
  };
  if (options.json)
    writeResult(
      { target: { ...target, ...(hostId && { hostId }) }, result: report },
      true,
    );
  else writeResult(formatDoctor(local, report, failure, hostId), false);
  return failure instanceof LocalSocketPermissionError ? 2 : healthy ? 0 : 1;
}

function formatDoctor(
  local: {
    installer: InstallerCheck;
    service: { unit: string; activeState: string };
    socket: SocketCheck;
    issues: string[];
  },
  result: {
    apiHealthy: boolean;
    builderEnabled?: unknown;
    builderReady?: unknown;
  },
  failure?: Error,
  hostId?: string,
): string {
  const { installer, service, socket } = local;
  const socketDetails =
    socket.gid === undefined
      ? ""
      : ` (${socket.mode}, group ${socket.group ?? socket.gid}, current shell ${socket.processInGroup ? "in group" : "outside group"})`;
  const checks = [
    `Host helper at ${installer.path} is ${installer.state}${installer.reason === "protected_directory" ? " from this shell (protected installation directory)" : ""}`,
    `Supervisor service is ${service.activeState} (${service.unit})`,
    `Socket ${socket.path} is ${socket.state}${socketDetails}`,
    `Management API ${failure ? "check did not complete" : result.apiHealthy ? "healthy" : "unhealthy"}${hostId ? ` on host ${hostId}` : ""}`,
  ];
  if (result.builderEnabled !== undefined)
    checks.push(
      `Image builder ${result.builderEnabled ? (result.builderReady ? "ready" : "not ready") : "disabled"}`,
    );
  if (failure) checks.push(failure.message);
  checks.push(...local.issues);
  return checks.join("\n");
}
