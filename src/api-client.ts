import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Operation } from "./types.js";
import type { PreparedRequest } from "./invocation.js";
import { targetFromPath } from "./invocation.js";
import { createRequestDeadline } from "./http-timeout.js";

export const implementedTransportOperationIds = Object.freeze([
  "destructive.preflight.create",
  "sandbox.workspace.export.resource.create",
  "sandbox.workspace.export.resource.read",
  "sandbox.workspace.import.upload.create",
  "sandbox.workspace.import.upload.status",
  "sandbox.workspace.import.upload.chunk",
  "sandbox.workspace.import.upload.complete",
  "sandbox.exec.stream",
  "sandbox.events.stream",
  "sandbox.usage.batch",
  "registry.create.interactive",
  "service_principal.create.interactive",
  "host_enrollment.create.interactive",
] as const);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly traceId?: string,
  ) {
    super(message);
  }
}

export class AmbiguousDispatchError extends Error {
  constructor(
    readonly idempotencyKey: string,
    operationCommand: string,
    options: ErrorOptions,
  ) {
    super(
      `${operationCommand} may have been accepted, but its result is unknown. Retry with --idempotency-key ${idempotencyKey}.`,
      options,
    );
  }
}

export interface ClientOptions {
  api: string;
  token: string;
  organization?: string;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  streamInactivityTimeoutMs?: number;
}

async function boundedBytes(
  response: Response,
  limit = 10 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > limit) throw new Error(`Response exceeded ${limit} bytes.`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { value, done } = signal
      ? await readWithSignal(reader, signal)
      : await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error(`Response exceeded ${limit} bytes.`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function boundedText(
  response: Response,
  limit = 10 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<string> {
  return Buffer.from(await boundedBytes(response, limit, signal)).toString(
    "utf8",
  );
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function snapshotOperationStatusUri(
  result: Record<string, unknown>,
): string | undefined {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const requestId = result.requestId;
  const sandboxId = result.sourceSandboxId;
  if (
    typeof requestId !== "string" ||
    typeof sandboxId !== "string" ||
    !uuid.test(requestId) ||
    !uuid.test(sandboxId)
  )
    return undefined;
  return `/api/v1/sandboxes/${sandboxId}/snapshot-operations/${requestId}`;
}

export class BorealisApiClient {
  constructor(private readonly options: ClientOptions) {}

  private headers(request?: PreparedRequest): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.token}`,
      accept: "application/json",
      "user-agent": `borealis-cli/${process.env.npm_package_version ?? "0.1.0"}`,
      ...(this.options.organization
        ? { "x-organization-id": this.options.organization }
        : {}),
      ...(request?.idempotencyKey
        ? { "idempotency-key": request.idempotencyKey }
        : {}),
    };
  }

  async invoke(
    operation: Operation,
    request: PreparedRequest,
  ): Promise<unknown> {
    try {
      return await this.invokeCore(operation, request);
    } catch (error) {
      if (
        operation.idempotency === "idempotency-key" &&
        request.idempotencyKey &&
        isAmbiguousDispatchFailure(error)
      )
        throw new AmbiguousDispatchError(
          request.idempotencyKey,
          operation.command,
          { cause: error },
        );
      throw error;
    }
  }

  async invokeInteractiveCredential(
    operation: Operation,
    request: PreparedRequest,
  ): Promise<unknown> {
    try {
      return await this.invokeInteractiveCredentialCore(operation, request);
    } catch (error) {
      if (
        operation.idempotency === "idempotency-key" &&
        request.idempotencyKey &&
        isAmbiguousDispatchFailure(error)
      )
        throw new AmbiguousDispatchError(
          request.idempotencyKey,
          operation.command,
          { cause: error },
        );
      throw error;
    }
  }

  private async invokeInteractiveCredentialCore(
    operation: Operation,
    request: PreparedRequest,
  ): Promise<unknown> {
    const paths: Record<string, string> = {
      "registry.create": "/api/v1/registries/interactive",
      "service_principal.create": "/api/v1/service-principals/interactive",
      "host_enrollment.create": `${request.path}/interactive`,
    };
    const path = paths[operation.operationId];
    if (!path)
      throw new Error(
        `${operation.command} does not support interactive credential delivery.`,
      );
    const body = { ...((request.body ?? {}) as Record<string, unknown>) };
    delete body.secret;
    if (operation.operationId === "registry.create")
      body.delivery = "interactive";
    const result = (await this.send(
      "POST",
      path,
      this.headers(request),
      body,
    )) as Record<string, unknown>;
    const claimUri = result.claimUri;
    const expiresAt = result.expiresAt;
    const claim =
      typeof claimUri === "string" ? new URL(claimUri, this.options.api) : null;
    if (
      !claim ||
      claim.origin !== new URL(this.options.api).origin ||
      !/^\/api\/v1\/credential-claims\/[0-9a-f-]{36}$/i.test(claim.pathname) ||
      claim.search ||
      claim.hash ||
      result.requiresAuthentication !== true ||
      typeof expiresAt !== "string" ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now()
    )
      throw new Error("The API returned an invalid credential claim handle.");
    if (operation.operationId === "host_enrollment.create") {
      const expectedPool = decodeURIComponent(
        request.path.match(/\/host-pools\/([^/]+)/)?.[1] ?? "",
      );
      const metadata = result.metadata as Record<string, unknown> | undefined;
      if (metadata?.hostPoolId !== expectedPool)
        throw new Error(
          "The API returned an enrollment claim for a different host pool.",
        );
    }
    return result;
  }

  private async invokeCore(
    operation: Operation,
    request: PreparedRequest,
  ): Promise<unknown> {
    if (operation.operationId === "sandbox.workspace.export") {
      return await this.exportWorkspace(request);
    }
    if (operation.operationId === "sandbox.workspace.import") {
      return await this.importWorkspace(request);
    }
    const headers = this.headers(request);
    if (operation.risk === "destructive") {
      const target = targetFromPath(operation, request.path);
      const preflight = (await this.send(
        "POST",
        "/api/v1/preflights",
        headers,
        { operationId: operation.operationId, target },
      )) as { preflightToken?: string };
      if (!preflight.preflightToken)
        throw new Error(
          "The API returned an invalid destructive-operation preflight.",
        );
      headers["x-borealis-preflight"] = preflight.preflightToken;
    }
    const path = `${request.path}${request.query.size ? `?${request.query}` : ""}`;
    const result = await this.send(
      operation.method,
      path,
      headers,
      request.body,
    );
    return result;
  }

  async waitFor(result: unknown, timeoutSeconds: number): Promise<unknown> {
    if (!result || typeof result !== "object") return result;
    const initial = result as Record<string, unknown>;
    const rawUri =
      initial.statusUri ??
      initial.operationUri ??
      snapshotOperationStatusUri(initial);
    if (typeof rawUri !== "string") return result;
    const uri = new URL(rawUri, this.options.api);
    const apiUri = new URL(this.options.api);
    const dedicatedWorkspaceStatus =
      uri.protocol === "https:" &&
      uri.hostname === `uploads-${apiUri.hostname}` &&
      (uri.port === "" || uri.port === "443") &&
      /^\/api\/v1\/workspace-import-uploads\/[^/]+\/status$/.test(uri.pathname);
    if (
      (uri.origin !== apiUri.origin && !dedicatedWorkspaceStatus) ||
      !uri.pathname.startsWith("/api/v1/") ||
      uri.username ||
      uri.password ||
      uri.hash
    )
      throw new Error("The API returned an invalid operation status URI.");
    const workspaceImport =
      /^\/api\/v1\/workspace-import-uploads\/[^/]+\/status$/.test(uri.pathname);
    const workspaceUploadId =
      workspaceImport && typeof initial.uploadId === "string"
        ? initial.uploadId
        : undefined;
    const workspaceSandboxId =
      workspaceImport && typeof initial.sandboxId === "string"
        ? initial.sandboxId
        : undefined;
    if (workspaceImport) {
      if (!workspaceUploadId || !workspaceSandboxId)
        throw new Error(
          "The API returned an invalid workspace import completion result.",
        );
      validateWorkspaceImportCompletion(
        initial,
        workspaceUploadId,
        workspaceSandboxId,
        new URL(uri.pathname.slice(0, -"/status".length), uri),
      );
    }
    const deadline = Date.now() + timeoutSeconds * 1000;
    let current: unknown = result;
    while (Date.now() < deadline) {
      await delay(1_000, undefined, { signal: this.options.signal });
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      current = await this.send(
        "GET",
        uri.href,
        this.headers(),
        undefined,
        Math.min(this.options.requestTimeoutMs ?? 30_000, remaining),
      );
      if (workspaceImport) {
        current = workspaceImportResultFromStatus(
          current,
          workspaceUploadId!,
          workspaceSandboxId!,
          uri.href,
        );
      }
      const status = String(
        (current as Record<string, unknown>)?.status ?? "",
      ).toLowerCase();
      if (
        ["completed", "succeeded", "failed", "cancelled", "canceled"].includes(
          status,
        )
      )
        return current;
    }
    throw new Error(
      `Operation did not complete within ${timeoutSeconds} seconds.`,
    );
  }

  private async exportWorkspace(request: PreparedRequest): Promise<unknown> {
    if (!request.output)
      throw new Error("Workspace export requires an output path or '-'.");
    const key = request.idempotencyKey ?? randomUUID();
    const resource = (await this.send(
      "POST",
      request.path.replace(
        /\/workspace\/export$/,
        "/workspace/export-resource",
      ),
      { ...this.headers(), "idempotency-key": key },
    )) as {
      resourceId: string;
      sandboxId: string;
      resourceUri: string;
      expiresAt: string;
      contentType: string;
      contentLength?: number | null;
      sha256?: string | null;
      requiresAuthentication: boolean;
    };
    const resourceUrl = new URL(resource.resourceUri, this.options.api);
    const exportSandboxId = decodeURIComponent(
      request.path.match(/\/sandboxes\/([^/]+)/)?.[1] ?? "",
    );
    if (
      resourceUrl.origin !== new URL(this.options.api).origin ||
      !resourceUrl.pathname.startsWith("/api/v1/workspace-export-resources/") ||
      resource.resourceId !== key ||
      resource.sandboxId !== exportSandboxId ||
      !Number.isFinite(Date.parse(resource.expiresAt)) ||
      Date.parse(resource.expiresAt) <= Date.now() ||
      resource.contentType !== "application/x-tar" ||
      (resource.contentLength != null &&
        (!Number.isSafeInteger(resource.contentLength) ||
          resource.contentLength < 0 ||
          resource.contentLength > 100 * 1024 * 1024 * 1024)) ||
      (resource.sha256 != null &&
        (typeof resource.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/i.test(resource.sha256))) ||
      resource.requiresAuthentication !== true
    ) {
      throw new Error(
        "The API returned an invalid authenticated workspace export handle.",
      );
    }
    const inactivity = new AbortController();
    const streamSignal = this.options.signal
      ? AbortSignal.any([this.options.signal, inactivity.signal])
      : inactivity.signal;
    const deadline = createRequestDeadline(
      streamSignal,
      this.options.requestTimeoutMs ?? 30_000,
    );
    let response: Response;
    try {
      response = await fetch(resourceUrl, {
        headers: this.headers(),
        redirect: "error",
        signal: deadline.signal,
      });
    } finally {
      deadline.dispose();
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        `Workspace export failed (${response.status}).`,
      );
    if (
      response.headers.get("content-type")?.split(";", 1)[0] !==
      "application/x-tar"
    ) {
      throw new Error("Workspace export returned an unexpected content type.");
    }
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "borealis-export-"),
    );
    const staged = join(temporaryDirectory, "workspace.tar");
    let inactivityTimer: NodeJS.Timeout | undefined;
    const resetInactivity = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        const error = new DOMException(
          "Workspace export stalled.",
          "TimeoutError",
        );
        inactivity.abort(error);
      }, this.options.streamInactivityTimeoutMs ?? 60_000);
      inactivityTimer.unref();
    };
    try {
      if (!response.body)
        throw new Error("Workspace export returned no content.");
      const hash = createHash("sha256");
      let bytes = 0;
      const reader = response.body.getReader();
      const stagedFile = await open(staged, "wx", 0o600);
      try {
        resetInactivity();
        while (true) {
          const { value, done } = await readWithSignal(reader, streamSignal);
          if (done) break;
          resetInactivity();
          bytes += value.byteLength;
          if (bytes > 100 * 1024 * 1024 * 1024)
            throw new Error("Workspace export exceeded 100 GiB.");
          hash.update(value);
          const { bytesWritten } = await stagedFile.write(value);
          if (bytesWritten !== value.byteLength)
            throw new Error("Workspace export could not be fully staged.");
        }
        await stagedFile.sync();
      } finally {
        void reader.cancel().catch(() => undefined);
        await stagedFile.close();
      }
      if (resource.contentLength != null && bytes !== resource.contentLength)
        throw new Error("Workspace export length did not match its handle.");
      const digest = hash.digest("hex");
      if (
        resource.sha256 != null &&
        digest.toLowerCase() !== resource.sha256.toLowerCase()
      )
        throw new Error("Workspace export SHA-256 did not match its handle.");
      await publishStagedWorkspaceExport(
        staged,
        request.output,
        this.options.signal,
      );
      return { output: request.output, bytes, sha256: digest };
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async importWorkspace(request: PreparedRequest): Promise<unknown> {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const archivePath = body.archivePath;
    if (typeof archivePath !== "string" || archivePath === "-")
      throw new Error(
        "Workspace import requires a seekable archive file path; stdin is not supported.",
      );
    const metadata = await stat(archivePath);
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > 100 * 1024 * 1024 * 1024
    )
      throw new Error(
        "Workspace import must be a non-empty file no larger than 100 GiB.",
      );
    const archiveHash = createHash("sha256");
    for await (const chunk of createReadStream(archivePath)) {
      this.options.signal?.throwIfAborted();
      archiveHash.update(chunk as Buffer);
    }
    const sha256 = archiveHash.digest("hex");
    const key = request.idempotencyKey ?? randomUUID();
    const upload = (await this.send(
      "POST",
      request.path,
      { ...this.headers(), "idempotency-key": key },
      {
        clearWorkspace: body.clearWorkspace !== false,
        contentType: "application/x-tar",
        contentLength: metadata.size,
        sha256,
      },
    )) as {
      uploadId: string;
      sandboxId: string;
      uploadUri: string;
      expiresAt: string;
      contentType: string;
      maximumBytes: number;
      requiresAuthentication: boolean;
    };
    const uploadUrl = new URL(upload.uploadUri, this.options.api);
    const apiUrl = new URL(this.options.api);
    const importSandboxId = decodeURIComponent(
      request.path.match(/\/sandboxes\/([^/]+)/)?.[1] ?? "",
    );
    const sameOrigin = uploadUrl.origin === apiUrl.origin;
    const dedicatedOrigin =
      uploadUrl.protocol === "https:" &&
      uploadUrl.hostname === `uploads-${apiUrl.hostname}` &&
      (uploadUrl.port === "" || uploadUrl.port === "443");
    if (
      (!sameOrigin && !dedicatedOrigin) ||
      uploadUrl.username ||
      uploadUrl.password ||
      uploadUrl.search ||
      uploadUrl.hash ||
      uploadUrl.pathname !==
        `/api/v1/workspace-import-uploads/${encodeURIComponent(upload.uploadId)}` ||
      upload.uploadId !== key ||
      upload.sandboxId !== importSandboxId ||
      ![
        "application/x-tar",
        "application/tar",
        "application/x-gtar",
        "application/zip",
        "application/x-zip-compressed",
        "application/gzip",
        "application/x-gzip",
        "application/gzip-compressed",
      ].includes(upload.contentType.split(";", 1)[0]!.toLowerCase()) ||
      !Number.isFinite(Date.parse(upload.expiresAt)) ||
      Date.parse(upload.expiresAt) <= Date.now() ||
      upload.requiresAuthentication !== true ||
      upload.maximumBytes <= 0 ||
      upload.maximumBytes > 100 * 1024 * 1024 * 1024 ||
      metadata.size > upload.maximumBytes
    )
      throw new Error(
        "The API returned an invalid authenticated workspace upload handle.",
      );
    const file = await open(archivePath, "r");
    try {
      let status = await this.getWorkspaceUploadStatus(
        uploadUrl,
        upload.uploadId,
        metadata.size,
      );
      const chunkSize = status.maximumChunkBytes;
      let offset = status.nextOffset;
      while (offset < metadata.size) {
        const length = Math.min(chunkSize, metadata.size - offset);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(chunk, 0, length, offset);
        if (bytesRead !== length)
          throw new Error(
            "Workspace archive changed while it was being uploaded.",
          );
        const final = offset + length === metadata.size;
        let uploaded = false;
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
          try {
            const deadline = createRequestDeadline(
              this.options.signal,
              this.options.requestTimeoutMs ?? 60_000,
            );
            let response: Response;
            let responseText: string;
            try {
              response = await fetch(uploadUrl, {
                method: "PUT",
                headers: {
                  ...this.headers(),
                  "content-type": "application/x-tar",
                  "content-range": `bytes ${offset}-${offset + length - 1}/${metadata.size}`,
                  "x-borealis-chunk-sha256": createHash("sha256")
                    .update(chunk)
                    .digest("hex"),
                  ...(final ? { "x-borealis-archive-sha256": sha256 } : {}),
                },
                body: chunk,
                redirect: "error",
                signal: deadline.signal,
              });
              if (!response.ok)
                throw new ApiError(
                  response.status,
                  `Workspace upload failed (${response.status}).`,
                );
              responseText = await boundedText(
                response,
                10 * 1024 * 1024,
                deadline.signal,
              );
            } finally {
              deadline.dispose();
            }
            status = JSON.parse(responseText) as typeof status;
            if (status.nextOffset !== offset + length)
              throw new Error(
                "The API returned an unexpected workspace upload offset.",
              );
            uploaded = true;
          } catch (error) {
            lastError = error;
            if (
              error instanceof ApiError &&
              error.status !== 408 &&
              error.status !== 429 &&
              error.status < 500
            )
              throw error;
            status = await this.getWorkspaceUploadStatus(
              uploadUrl,
              upload.uploadId,
              metadata.size,
            );
            if (status.nextOffset === offset + length) uploaded = true;
            else if (status.nextOffset !== offset || attempt === 3)
              throw lastError;
          }
        }
        offset += length;
      }
    } finally {
      await file.close();
    }
    const target = targetFromPath(operationForImport, request.path);
    const preflight = (await this.send(
      "POST",
      "/api/v1/preflights",
      this.headers(),
      { operationId: "sandbox.workspace.import", target },
    )) as { preflightToken?: string };
    if (!preflight.preflightToken)
      throw new Error(
        "The API returned an invalid workspace import preflight.",
      );
    const completion = await this.send(
      "POST",
      `${request.path}/${encodeURIComponent(upload.uploadId)}/complete`,
      { ...this.headers(), "x-borealis-preflight": preflight.preflightToken },
      { contentLength: metadata.size, sha256 },
    );
    return validateWorkspaceImportCompletion(
      completion,
      upload.uploadId,
      importSandboxId,
      uploadUrl,
    );
  }

  private async getWorkspaceUploadStatus(
    uploadUrl: URL,
    uploadId: string,
    totalLength: number,
  ): Promise<{
    uploadId: string;
    nextOffset: number;
    totalLength: number;
    maximumChunkBytes: number;
    committed: boolean;
  }> {
    const deadline = createRequestDeadline(
      this.options.signal,
      this.options.requestTimeoutMs ?? 30_000,
    );
    let statusResponse: Response;
    let statusText: string;
    try {
      statusResponse = await fetch(`${uploadUrl}/status`, {
        headers: this.headers(),
        redirect: "error",
        signal: deadline.signal,
      });
      if (!statusResponse.ok)
        throw new ApiError(
          statusResponse.status,
          `Workspace upload status failed (${statusResponse.status}).`,
        );
      statusText = await boundedText(
        statusResponse,
        10 * 1024 * 1024,
        deadline.signal,
      );
    } finally {
      deadline.dispose();
    }
    const status = JSON.parse(statusText) as {
      uploadId: string;
      nextOffset: number;
      totalLength: number;
      maximumChunkBytes: number;
      committed: boolean;
    };
    const totalUnset =
      status.totalLength === 0 &&
      status.nextOffset === 0 &&
      status.committed === false;
    const totalValid =
      totalUnset ||
      (status.totalLength === totalLength &&
        status.nextOffset >= 0 &&
        status.nextOffset <= totalLength &&
        (status.nextOffset === totalLength ||
          status.nextOffset % (8 * 1024 * 1024) === 0) &&
        status.committed === (status.nextOffset === totalLength));
    if (
      status.uploadId !== uploadId ||
      status.maximumChunkBytes !== 8 * 1024 * 1024 ||
      !totalValid
    )
      throw new Error("The API returned an invalid workspace upload status.");
    return status;
  }

  private async send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<unknown> {
    const deadline = createRequestDeadline(this.options.signal, timeoutMs);
    try {
      const response = await fetch(new URL(path, this.options.api), {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: deadline.signal,
      });
      if (!response.ok) {
        const text = await boundedText(response, 1024 * 1024, deadline.signal);
        let message = `Borealis API request failed (${response.status}).`;
        let traceId: string | undefined;
        try {
          const problem = JSON.parse(text) as {
            title?: string;
            detail?: string;
            traceId?: string;
          };
          message = problem.detail ?? problem.title ?? message;
          traceId = problem.traceId;
        } catch {
          /* use the stable status message */
        }
        throw new ApiError(response.status, message, traceId);
      }
      if (response.status === 204) return { success: true };
      const mediaType = response.headers.get("content-type") ?? "";
      if (mediaType.includes("application/json") || mediaType.includes("+json"))
        return JSON.parse(
          await boundedText(response, undefined, deadline.signal),
        );
      const bytes = await boundedBytes(
        response,
        10 * 1024 * 1024,
        deadline.signal,
      );
      if (response.status === 202 && bytes.byteLength === 0)
        return { accepted: true };
      return bytes;
    } finally {
      deadline.dispose();
    }
  }
}

export function validateWorkspaceImportCompletion(
  value: unknown,
  uploadId: string,
  sandboxId: string,
  uploadUrl: URL,
): Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new Error(
      "The API returned an invalid workspace import completion result.",
    );
  const result = value as Record<string, unknown>;
  if (result.uploadId !== uploadId || result.sandboxId !== sandboxId)
    throw new Error(
      "The API returned a workspace import result for a different handle.",
    );
  if (typeof result.status !== "string")
    throw new Error(
      "The API returned an invalid workspace import completion result.",
    );
  const status = result.status;
  const completedAtValid =
    typeof result.completedAt === "string" &&
    Number.isFinite(Date.parse(result.completedAt));
  const pending = status === "queued" || status === "processing";
  if (!(
    (status === "completed" && result.imported === true && completedAtValid) ||
    (pending &&
      result.imported === false &&
      result.completedAt == null &&
      typeof result.statusUri === "string")
  ))
    throw new Error(
      "The API returned an invalid workspace import completion result.",
    );
  if (result.statusUri != null) {
    if (typeof result.statusUri !== "string")
      throw new Error(
        "The API returned an invalid workspace import status URI.",
      );
    let statusUri: URL;
    try {
      statusUri = new URL(result.statusUri);
    } catch {
      throw new Error(
        "The API returned an invalid workspace import status URI.",
      );
    }
    if (
      statusUri.origin !== uploadUrl.origin ||
      statusUri.username ||
      statusUri.password ||
      statusUri.search ||
      statusUri.hash ||
      statusUri.pathname !== `${uploadUrl.pathname}/status`
    )
      throw new Error(
        "The API returned an invalid workspace import status URI.",
      );
  }
  return result;
}

function workspaceImportResultFromStatus(
  value: unknown,
  uploadId: string,
  sandboxId: string,
  statusUri: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new Error("The API returned an invalid workspace import status.");
  const status = value as Record<string, unknown>;
  const importStatus =
    typeof status.importStatus === "string" ? status.importStatus : "";
  const totalLength = status.totalLength;
  const nextOffset = status.nextOffset;
  const completedAtValid =
    typeof status.importCompletedAt === "string" &&
    Number.isFinite(Date.parse(status.importCompletedAt));
  const progressValid =
    typeof totalLength === "number" &&
    Number.isSafeInteger(totalLength) &&
    totalLength > 0 &&
    typeof nextOffset === "number" &&
    Number.isSafeInteger(nextOffset) &&
    nextOffset >= 0 &&
    nextOffset <= totalLength;
  const stateValid =
    ((importStatus === "queued" || importStatus === "processing") &&
      status.importCompletedAt == null) ||
    (importStatus === "completed" &&
      completedAtValid &&
      status.committed === true &&
      nextOffset === totalLength) ||
    (importStatus === "failed" && status.importCompletedAt == null);
  if (status.uploadId !== uploadId || !progressValid || !stateValid)
    throw new Error("The API returned an invalid workspace import status.");
  return {
    uploadId,
    sandboxId,
    imported: importStatus === "completed",
    completedAt: importStatus === "completed" ? status.importCompletedAt : null,
    status: importStatus,
    statusUri,
    ...(typeof status.importErrorCode === "string"
      ? { importErrorCode: status.importErrorCode }
      : {}),
  };
}

export async function publishStagedWorkspaceExport(
  staged: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const copy = async (
    source: NodeJS.ReadableStream,
    target: NodeJS.WritableStream,
  ): Promise<void> => {
    if (signal) await pipeline(source, target, { signal });
    else await pipeline(source, target);
  };
  if (destination === "-") {
    await copy(createReadStream(staged), process.stdout);
    return;
  }
  const temporaryDestination = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    await copy(
      createReadStream(staged),
      createWriteStream(temporaryDestination, { flags: "wx", mode: 0o600 }),
    );
    signal?.throwIfAborted();
    await link(temporaryDestination, destination);
    await rm(temporaryDestination);
  } catch (error) {
    await rm(temporaryDestination, { force: true });
    throw error;
  }
}

function isAmbiguousDispatchFailure(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  if (error instanceof TypeError) return true;
  if (
    error instanceof DOMException &&
    ["AbortError", "TimeoutError"].includes(error.name)
  )
    return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return Boolean(
    code &&
    (code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code.startsWith("UND_ERR_")),
  );
}

const operationForImport: Operation = {
  operationId: "sandbox.workspace.import",
  method: "POST",
  path: "/api/v1/sandboxes/{sandboxId}/workspace/import-uploads",
  scope: "borealis.sandboxes.write",
  risk: "destructive",
  clientMethod: "ImportWorkspaceAsync",
  command: "sandbox workspace import",
  mcpName: "sandbox_workspace_import",
  ownership: "organization",
  idempotency: "idempotency-key",
  retry: "safe",
  paging: "none",
  requiresPreflight: true,
};
