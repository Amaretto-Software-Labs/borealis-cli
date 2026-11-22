import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ApiError, BorealisApiClient, boundedText } from "./api-client.js";
import {
  stageBuildContext,
  stageContainerArchive,
  type BuildArtifact,
} from "./build-context.js";
import { isGuid, sameGuid } from "./guid.js";
import type { PreparedRequest } from "./invocation.js";
import {
  followCommand,
  formatInputBytes,
  isTerminalStatus,
  observeInput,
  observeProgress,
  type DurableReference,
} from "./progress.js";
import {
  LocalSocketPermissionError,
  supervisorOrigin,
  type SupervisorTransport,
} from "./supervisor-transport.js";
import type { Operation } from "./types.js";

const discoverySchema = z
  .object({
    apiVersion: z.literal(1),
    hostId: z.string().min(1),
    operations: z.array(z.string()),
    architecture: z.enum(["x86_64", "aarch64"]).optional(),
  })
  .passthrough();
export type SupervisorDiscovery = z.infer<typeof discoverySchema>;
export const doctorRequestTimeoutMs = 180_000;

export interface DirectTargetMetadata {
  profile: string;
  type: "local" | "ssh";
  hostId: string;
  socket: string;
  alias?: string;
}

export type ObservationTarget =
  DirectTargetMetadata | { type: "cloud"; profile?: string };

export class UnsupportedTargetError extends Error {
  readonly code = "unsupported_target";
}

export class InterruptedObservationError extends Error {
  constructor(
    readonly resource: DurableReference,
    readonly target: ObservationTarget,
    options: ErrorOptions & { stopped?: boolean },
  ) {
    const outcome = options.stopped
      ? "Stopped watching. Accepted work remains on its target."
      : "Could not continue checking progress. The final state is unknown.";
    const reason =
      options.cause instanceof LocalSocketPermissionError
        ? ` ${options.cause.message}`
        : options.cause instanceof ApiError
          ? ` The status request returned HTTP ${options.cause.status}.`
          : options.cause instanceof Error &&
              options.cause.message.startsWith("Wait exceeded ")
            ? ` ${options.cause.message}`
            : "";
    const targetHint =
      target.type === "cloud"
        ? " Use the same Cloud target and credentials."
        : "";
    super(
      `${outcome}${reason} Reconnect with '${followCommand(resource, target.profile)}'.${targetHint}`,
      options,
    );
  }
}

export function directClient(
  transport: SupervisorTransport,
  signal?: AbortSignal,
): BorealisApiClient {
  return new BorealisApiClient({
    api: supervisorOrigin,
    standalone: true,
    transport: transport.fetch,
    ...(signal ? { signal } : {}),
  });
}

export async function discoverSupervisor(
  client: BorealisApiClient,
  timeoutMs?: number,
): Promise<SupervisorDiscovery> {
  return parseSupervisorDiscovery(
    await client.supervisorRequest("GET", "/api/v1/supervisor", timeoutMs),
  );
}

export function parseSupervisorDiscovery(value: unknown): SupervisorDiscovery {
  const response = discoverySchema.safeParse(value);
  if (!response.success)
    throw new Error(
      "The selected supervisor does not provide the supported management API version 1.",
    );
  return response.data;
}

export function requireSupport(
  discovery: SupervisorDiscovery,
  operation: Operation,
): void {
  if (
    operation.operationId !== "supervisor.status" &&
    !discovery.operations.includes(operation.operationId)
  )
    throw new UnsupportedTargetError(
      `${operation.command} is unavailable on supervisor ${discovery.hostId}.`,
    );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function durableReference(
  operation: Operation,
  result: unknown,
  path: string,
): DurableReference | undefined {
  const record = asRecord(result);
  if (operation.operationId.startsWith("runtime_image_build.")) {
    const id =
      /^\/api\/v1\/runtime-image-builds\/([^/]+)(?:\/cancel)?$/.exec(
        path,
      )?.[1] ?? record.buildId;
    if (typeof id === "string") return { kind: "build", id };
  } else {
    const id =
      /^\/api\/v1\/operations\/([^/]+)$/.exec(path)?.[1] ?? record.operationId;
    if (typeof id === "string") return { kind: "operation", id };
  }
  return undefined;
}

export function reportBackgroundWork(
  operation: Operation,
  result: unknown,
  target: ObservationTarget,
  request: PreparedRequest,
): void {
  if (operation.method === "GET") return;
  const reference = durableReference(operation, result, request.path);
  const row = asRecord(result);
  const status = row.status;
  if (
    !reference ||
    !isGuid(reference.id) ||
    typeof status !== "string" ||
    !status.trim()
  )
    return;
  if (
    !sameGuid(
      row[reference.kind === "build" ? "buildId" : "operationId"],
      reference.id,
    )
  )
    return;
  const state = status.trim().toLowerCase();
  if (state === "awaiting_approval" && target.type === "cloud") {
    reportRequiredApproval(reference, target);
    return;
  }
  if (isTerminalStatus(state)) return;
  const noun = reference.kind === "build" ? "Build" : "Operation";
  process.stderr.write(
    `${noun} ${reference.id} is in the background. Follow it with '${followCommand(reference, target.profile)}'.${target.type === "cloud" ? " Use the same Cloud target and credentials." : ""}\n`,
  );
}

function reportRequiredApproval(
  reference: DurableReference,
  target: ObservationTarget,
): void {
  const profile = target.profile ? ` --profile ${target.profile}` : "";
  process.stderr.write(
    `Approval is required before publication. If authorized, run 'borealis${profile} image build approve ${reference.id}'.\n`,
  );
}

function buildAssemblySource(
  request: PreparedRequest,
): "oci" | "build" | undefined {
  const body = asRecord(request.body);
  if (
    body.sourceKind === "oci_image" ||
    typeof body.image === "string" ||
    typeof body.imageReference === "string"
  )
    return "oci";
  if (
    body.sourceKind === "dockerfile" ||
    body.sourceKind === "container_archive"
  )
    return "build";
  return undefined;
}

export async function waitForSupervisor(
  client: BorealisApiClient,
  operation: Operation,
  result: unknown,
  target: DirectTargetMetadata,
  request: PreparedRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeoutSeconds = request.waitTimeoutSeconds!;
  const reference = durableReference(operation, result, request.path);
  if (!reference) return await client.waitFor(result, timeoutSeconds);
  const path =
    reference.kind === "build"
      ? `/api/v1/runtime-image-builds/${reference.id}`
      : `/api/v1/operations/${reference.id}`;
  return await watchDurableResult(
    result,
    reference,
    target,
    timeoutSeconds,
    (budget) => client.supervisorRequest("GET", path, budget),
    signal,
    buildAssemblySource(request),
  );
}

export async function waitForCloudImageBuild(
  client: BorealisApiClient,
  operation: Operation,
  result: unknown,
  target: ObservationTarget,
  request: PreparedRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const reference = durableReference(operation, result, request.path);
  if (!reference || reference.kind !== "build")
    throw new Error("The API returned no durable image build ID.");
  return await watchDurableResult(
    result,
    reference,
    target,
    request.waitTimeoutSeconds!,
    (budget) => client.readImageBuild(reference.id, budget),
    signal,
    buildAssemblySource(request),
  );
}

async function watchDurableResult(
  result: unknown,
  reference: DurableReference,
  target: ObservationTarget,
  timeoutSeconds: number,
  read: (budgetMs: number) => Promise<unknown>,
  signal?: AbortSignal,
  assembly?: "oci" | "build",
): Promise<unknown> {
  const { kind, id } = reference;
  if (!isGuid(id))
    throw new Error("The API returned an invalid durable result ID.");
  const field = kind === "build" ? "buildId" : "operationId";
  const deadline = performance.now() + timeoutSeconds * 1000;
  let current = asRecord(result);
  const progress = observeProgress(reference, assembly);
  try {
    while (true) {
      signal?.throwIfAborted();
      if (!sameGuid(current[field], id))
        throw new Error("The API returned a different operation or build ID.");
      const { status, phase, stage, failureMessage, error } = current;
      if (typeof status !== "string" || !status.trim())
        throw new Error("The API returned no operation or build status.");
      const state = status.trim().toLowerCase();
      const phaseName =
        typeof stage === "string" && stage
          ? stage
          : typeof phase === "string" && phase
            ? phase
            : state;
      const detail =
        typeof failureMessage === "string"
          ? failureMessage
          : asRecord(error).message;
      const observedAssembly =
        typeof current.resolvedImage === "string" ||
        current.sourceKind === "oci_image"
          ? "oci"
          : undefined;
      progress(
        state,
        phaseName,
        typeof detail === "string" ? detail : undefined,
        observedAssembly,
      );
      if (isTerminalStatus(state)) {
        if (state === "awaiting_approval" && target.type === "cloud")
          reportRequiredApproval(reference, target);
        return current;
      }
      const untilDelay = deadline - performance.now();
      if (untilDelay <= 0) break;
      await delay(Math.min(1000, untilDelay), undefined, { signal });
      const remaining = deadline - performance.now();
      if (remaining < 1) break;
      current = asRecord(await read(Math.min(Math.ceil(remaining), 30_000)));
    }
    throw new Error(`Wait exceeded ${timeoutSeconds} seconds.`);
  } catch (error) {
    throw new InterruptedObservationError(reference, target, {
      cause: error,
      stopped: signal?.aborted === true,
    });
  }
}

export function supervisorExitCode(result: unknown): number {
  const status = String(asRecord(result).status ?? "").toLowerCase();
  if (["failed", "rolled_back", "repair_required"].includes(status)) return 3;
  if (status === "reconciliation_required") return 4;
  if (status === "canceled" || status === "cancelled") return 130;
  return 0;
}

export function usesClientBuildInput(request: PreparedRequest): boolean {
  const body = asRecord(request.body);
  return [
    "context",
    "dockerfile",
    "archive",
    "image",
    "enableNestedContainers",
  ].some((key) => key in body);
}

async function uploadArtifact(
  transport: SupervisorTransport,
  artifact: BuildArtifact,
  signal?: AbortSignal,
): Promise<string> {
  const progress = observeInput(
    "Uploading build input to the supervisor",
    artifact.sizeBytes,
  );
  const source = createReadStream(artifact.path);
  const upload = Readable.from(
    (async function* () {
      let bytes = 0;
      for await (const chunk of source) {
        bytes += (chunk as Buffer).length;
        progress.bytesProcessed(bytes);
        yield chunk;
      }
    })(),
    { objectMode: false },
  );
  const body = Readable.toWeb(upload);
  const request: RequestInit & { duplex: "half" } = {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(artifact.sizeBytes),
    },
    body: body as unknown as BodyInit,
    duplex: "half",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(600_000)])
      : AbortSignal.timeout(600_000),
  };
  try {
    const response = await transport.fetch(
      `${supervisorOrigin}/api/v1/supervisor/artifacts/${artifact.digest.slice(7)}`,
      request,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        response.status,
        `The supervisor rejected the build input upload (HTTP ${response.status}).`,
      );
    }
    const accepted = asRecord(
      JSON.parse(
        await boundedText(response, 64 * 1024, request.signal ?? undefined),
      ),
    );
    if (
      accepted.digest !== artifact.digest ||
      accepted.sizeBytes !== artifact.sizeBytes
    )
      throw new Error(
        "The supervisor returned different build input bytes or digest.",
      );
    progress.finish(
      `Supervisor verified ${formatInputBytes(artifact.sizeBytes)} of uploaded build input`,
    );
    return artifact.digest;
  } finally {
    progress.close();
    upload.destroy();
    source.destroy();
  }
}

export async function prepareLocalBuild(
  request: PreparedRequest,
  transport: SupervisorTransport,
  discovery: SupervisorDiscovery,
  signal?: AbortSignal,
): Promise<PreparedRequest> {
  const body = { ...asRecord(request.body) };
  const { context, dockerfile, archive, image } = body;
  for (const key of ["context", "dockerfile", "archive", "image"])
    delete body[key];
  if (
    Number(context !== undefined) +
      Number(archive !== undefined) +
      Number(image !== undefined) >
    1
  )
    throw new Error(
      "Specify one build input with --context, --archive, or --image.",
    );
  if (dockerfile !== undefined && context === undefined)
    throw new Error("--dockerfile requires --context.");
  if (context !== undefined || archive !== undefined || image !== undefined) {
    if (
      body.sourceKind !== undefined ||
      body.buildContextReference !== undefined ||
      body.imageReference !== undefined
    )
      throw new Error(
        "Do not combine a client build input with explicit build source fields.",
      );
  }
  body.architecture ??= discovery.architecture;
  if (context !== undefined || archive !== undefined || image !== undefined)
    body.enableManagedService ??= true;
  if (image !== undefined) {
    if (typeof image !== "string" || !image.trim())
      throw new Error("--image requires a registry image.");
    body.sourceKind = "oci_image";
    body.imageReference = image;
  }
  let artifact: BuildArtifact | undefined;
  let preparation: ReturnType<typeof observeInput> | undefined;
  try {
    if (context !== undefined) {
      if (
        typeof context !== "string" ||
        (dockerfile !== undefined && typeof dockerfile !== "string")
      )
        throw new Error("Enter a local context directory and Dockerfile path.");
      preparation = observeInput("Packaging the local Docker context");
      const packaged = await stageBuildContext(
        context,
        dockerfile ?? "Dockerfile",
        signal,
        preparation.bytesProcessed,
      );
      artifact = packaged.artifact;
      body.sourceKind = "dockerfile";
      body.dockerfilePath = packaged.dockerfilePath;
    } else if (archive !== undefined) {
      if (typeof archive !== "string")
        throw new Error("--archive requires a local archive path.");
      preparation = observeInput(
        "Reading and hashing the local container archive",
      );
      artifact = await stageContainerArchive(
        archive,
        signal,
        preparation.bytesProcessed,
      );
      body.sourceKind = "container_archive";
    }
    if (artifact) {
      preparation?.finish(
        `Prepared ${formatInputBytes(artifact.sizeBytes)} of build input`,
      );
      body.buildContextReference = await uploadArtifact(
        transport,
        artifact,
        signal,
      );
    }
    return { ...request, body };
  } finally {
    preparation?.close();
    await artifact?.close();
  }
}
