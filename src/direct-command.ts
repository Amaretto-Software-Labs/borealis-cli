import { setTimeout as delay } from "node:timers/promises";
import { AmbiguousDispatchError, ApiError } from "./api-client.js";
import { writeHostOverview } from "./host-overview.js";
import { prepareRequest } from "./invocation.js";
import { attach } from "./interactive.js";
import {
  commandExitCode,
  writeOperationResult,
  writeResult,
  writesExecutionStreams,
} from "./output.js";
import { targetLabel, type SupervisorTarget } from "./profiles.js";
import {
  directClient,
  type DirectTargetMetadata,
  discoverSupervisor,
  doctorRequestTimeoutMs,
  prepareLocalBuild,
  requireSupport,
  reportBackgroundWork,
  supervisorExitCode,
  waitForSupervisor,
} from "./supervisor-client.js";
import {
  connectSupervisor,
  LocalSocketPermissionError,
  openSshPortForward,
  supervisorOrigin,
} from "./supervisor-transport.js";
import type { GlobalOptions, Operation } from "./types.js";

export async function runDirectCommand(
  operation: Operation,
  rest: string[],
  options: GlobalOptions,
  profile: SupervisorTarget,
  confirm: (action: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<number> {
  const transport = await connectSupervisor(profile, signal);
  const label = targetLabel(options.profile, profile);
  try {
    const client = directClient(transport, signal);
    const discovery = await discoverSupervisor(client).catch(
      (error: unknown) => {
        if (
          signal?.aborted ||
          error instanceof ApiError ||
          error instanceof LocalSocketPermissionError
        )
          throw error;
        throw new Error(
          `Could not reach the management API for ${label}. Run 'borealis doctor' on the same target to check it. ${error instanceof Error ? error.message : ""}`,
          { cause: error },
        );
      },
    );
    requireSupport(discovery, operation);
    const target = {
      profile: options.profile,
      type: profile.type,
      hostId: discovery.hostId,
      socket: profile.socket,
      ...(profile.type === "ssh" ? { alias: profile.alias } : {}),
    };
    if (operation.command === "status")
      return await writeHostOverview(
        client,
        discovery,
        target,
        options.json,
        signal,
      );
    const rawStreams = !options.json && writesExecutionStreams(operation);
    if (!options.json && !rawStreams)
      process.stderr.write(`Target ${label}, host ${target.hostId}\n`);
    let request = await prepareRequest(operation, rest, signal, true, true);
    if (request.forwardPort !== undefined && profile.type !== "ssh")
      throw new Error(
        "--forward requires an SSH supervisor profile. Local ports already bind to loopback.",
      );
    if (
      operation.risk === "destructive" &&
      !(
        operation.operationId === "sandbox.workspace.import" &&
        rest.includes("--keep")
      ) &&
      !options.yes &&
      !(await confirm(
        `${operation.command} on ${label}, host ${target.hostId}`,
      ))
    ) {
      throw new Error(
        "Destructive operation cancelled. Pass --yes for non-interactive use.",
      );
    }
    if (operation.operationId === "interactive.stream") {
      if (options.json)
        throw new Error(
          "Interactive output is a terminal stream. Omit --json.",
        );
      await attach(
        new URL(
          `${request.path}${request.query.size ? `?${request.query}` : ""}`,
          supervisorOrigin,
        ).href,
        undefined,
        undefined,
        signal,
        transport.socket,
      );
      return 0;
    }
    if (operation.operationId === "runtime_image_build.create")
      request = await prepareLocalBuild(request, transport, discovery, signal);
    if (request.idempotencyKey && !rawStreams)
      process.stderr.write(
        `Request key ${request.idempotencyKey} on profile '${options.profile}'\n`,
      );
    let result: unknown;
    try {
      result =
        operation.operationId === "supervisor.status"
          ? discovery
          : operation.operationId === "supervisor.doctor"
            ? await client.supervisorRequest(
                "GET",
                operation.path,
                doctorRequestTimeoutMs,
              )
            : await client.invoke(operation, request);
    } catch (error) {
      if (error instanceof AmbiguousDispatchError)
        throw new AmbiguousDispatchError(
          error.idempotencyKey,
          error.operationCommand,
          { cause: error },
          target,
        );
      throw error;
    }
    if (request.waitTimeoutSeconds !== undefined)
      result = await waitForSupervisor(
        client,
        operation,
        result,
        target,
        request,
        signal,
      );
    else reportBackgroundWork(operation, result, target, request);
    if (request.forwardPort !== undefined && profile.type === "ssh") {
      await forwardPreview(
        profile,
        target,
        result,
        request.forwardPort,
        options.json,
        signal,
      );
      return 0;
    }
    if (
      operation.operationId === "sandbox.workspace.export" &&
      request.output === "-"
    )
      return 0;
    writeOperationResult(operation, result, options.json, target);
    return commandExitCode(operation, result) ?? supervisorExitCode(result);
  } finally {
    await transport.close();
  }
}

async function forwardPreview(
  profile: Extract<SupervisorTarget, { type: "ssh" }>,
  target: DirectTargetMetadata,
  value: unknown,
  localPort: number,
  json: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const binding = value as {
    bindAddress?: string;
    expiresAt?: string;
    portBinding?: { hostPort?: number; protocol?: string };
  } | null;
  const hostPort = binding?.portBinding?.hostPort;
  const lifetime = Date.parse(binding?.expiresAt ?? "") - Date.now();
  if (
    binding?.bindAddress !== "127.0.0.1" ||
    binding.portBinding?.protocol !== "tcp" ||
    typeof hostPort !== "number" ||
    !Number.isInteger(hostPort) ||
    hostPort < 1 ||
    hostPort > 65_535 ||
    !Number.isFinite(lifetime) ||
    lifetime <= 0 ||
    lifetime > 16 * 60 * 1000
  )
    throw new Error(
      "The supervisor did not return a valid, bounded loopback port registration.",
    );
  const forward = await openSshPortForward(
    profile,
    hostPort,
    localPort,
    signal,
  );
  try {
    const preview = {
      ...binding,
      localHost: "127.0.0.1",
      localPort: forward.port,
    };
    writeResult(json ? { target, result: preview } : preview, json);
    await delay(
      Math.max(1, Date.parse(binding.expiresAt!) - Date.now()),
      undefined,
      { signal },
    );
  } finally {
    await forward.close();
  }
}
