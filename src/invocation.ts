import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Operation } from "./types.js";
import { readOwnerOnlySecretFile } from "./secret-file.js";

const valueOptions = new Set([
  "--account",
  "--arg",
  "--api",
  "--app",
  "--body",
  "--cancel-url",
  "--client-id",
  "--cols",
  "--command",
  "--container-port",
  "--cpu",
  "--cursor",
  "--data",
  "--display-name",
  "--entitlement",
  "--env",
  "--external-id",
  "--host",
  "--host-id",
  "--identity",
  "--id",
  "--idempotency-key",
  "--idle-timeout",
  "--image",
  "--kind",
  "--limit",
  "--login-hint",
  "--memory",
  "--microcredits",
  "--name",
  "--namespace",
  "--organization",
  "--output",
  "--page",
  "--page-size",
  "--placement",
  "--plan",
  "--pool",
  "--port",
  "--price",
  "--profile",
  "--protocol",
  "--reason",
  "--redirect-port",
  "--repository",
  "--region",
  "--request-id",
  "--role",
  "--rows",
  "--sandbox",
  "--sandbox-name",
  "--scope",
  "--search",
  "--secret",
  "--secret-file",
  "--set",
  "--slots",
  "--slug",
  "--status",
  "--stripe-price",
  "--subject-id",
  "--subject-type",
  "--success-url",
  "--tail",
  "--target",
  "--threshold",
  "--timeout",
  "--token",
  "--token-file",
  "--type",
  "--username",
  "--window-minutes",
  "--workdir",
  "--working-directory",
]);
const globalOptions = new Set([
  "--api",
  "--app",
  "--identity",
  "--organization",
  "--profile",
  "--token",
  "--token-file",
]);
const repeated = new Set([
  "arg",
  "entitlement",
  "env",
  "port",
  "repository",
  "role",
  "scope",
]);
const numericOptions = new Set([
  "cols",
  "containerPort",
  "cpu",
  "idleTimeout",
  "limit",
  "memory",
  "microcredits",
  "page",
  "pageSize",
  "rows",
  "slots",
  "tail",
  "target",
  "threshold",
  "timeout",
  "windowMinutes",
]);
const booleanOptionKeys = new Set([
  "clearWorkspace",
  "default",
  "disable",
  "enable",
  "inactive",
  "keep",
  "newline",
  "noAutoProvision",
  "noStart",
  "secretStdin",
]);

export interface PreparedRequest {
  path: string;
  query: URLSearchParams;
  body?: unknown;
  idempotencyKey?: string;
  output?: string;
  waitTimeoutSeconds?: number;
}

function camelCase(option: string): string {
  return option
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  try {
    if (value.startsWith("{") || value.startsWith("["))
      return JSON.parse(value);
  } catch {
    // Leave non-JSON values as strings.
  }
  return value;
}

function assign(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (repeated.has(key)) {
    const values = (target[key] as unknown[] | undefined) ?? [];
    values.push(value);
    target[key] = values;
  } else {
    target[key] = value;
  }
}

function isTemplateConvenienceKey(operation: Operation, key: string): boolean {
  return (
    operation.operationId.startsWith("template.") &&
    [
      "displayName",
      "name",
      "sandboxName",
      "image",
      "command",
      "idleTimeout",
    ].includes(key)
  );
}

function parsePortBinding(value: unknown): Record<string, unknown> {
  const text = String(value).trim();
  const slash = text.lastIndexOf("/");
  const protocol = (slash >= 0 ? text.slice(slash + 1) : "tcp").toLowerCase();
  const endpoint = slash >= 0 ? text.slice(0, slash) : text;
  if (protocol !== "tcp" && protocol !== "udp")
    throw new Error("--port protocol must be tcp or udp.");
  const pieces = endpoint.split(":");
  if (pieces.length < 1 || pieces.length > 2)
    throw new Error(
      "--port values must use <container-port> or <host-port>:<container-port> format.",
    );
  const ports = pieces.map(Number);
  if (
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
  )
    throw new Error("--port values must be between 1 and 65535.");
  return {
    containerPort: ports.at(-1)!,
    protocol,
    expose: true,
    ...(ports.length === 2 ? { hostPort: ports[0] } : {}),
  };
}

export async function prepareRequest(
  operation: Operation,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<PreparedRequest> {
  const values: Record<string, unknown> = {};
  const positional: string[] = [];
  let body: Record<string, unknown> | undefined;
  let output: string | undefined;
  let wait = false;
  let templateConvenience = false;
  for (let index = 0; index < args.length; index++) {
    const current = args[index]!;
    if (!current.startsWith("--")) {
      positional.push(current);
      continue;
    }
    const inlineSeparator = current.indexOf("=");
    const option =
      inlineSeparator >= 0 ? current.slice(0, inlineSeparator) : current;
    const inline =
      inlineSeparator >= 0 ? current.slice(inlineSeparator + 1) : undefined;
    const needsValue = inline !== undefined || valueOptions.has(option!);
    const raw = inline ?? (needsValue ? args[++index] : "true");
    if (raw === undefined) throw new Error(`Missing value for ${option}.`);
    if (globalOptions.has(option!)) continue;
    const key = camelCase(option!);
    if (key === "body") {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`${option} must be a JSON object.`);
      body = { ...(body ?? {}), ...(parsed as Record<string, unknown>) };
    } else if (key === "set") {
      const separator = raw.indexOf("=");
      if (separator < 1) throw new Error("--set requires key=value.");
      const field = raw.slice(0, separator);
      if (isTemplateConvenienceKey(operation, field))
        templateConvenience = true;
      assign(values, field, coerce(raw.slice(separator + 1)));
    } else if (key === "output") {
      output = raw;
    } else if (key === "wait") {
      wait = raw === "true";
    } else if (!["yes", "json", "wait", "includeSecret"].includes(key)) {
      if (isTemplateConvenienceKey(operation, key)) templateConvenience = true;
      const value = numericOptions.has(key)
        ? Number(raw)
        : booleanOptionKeys.has(key)
          ? raw === "true"
          : raw;
      if (numericOptions.has(key) && !Number.isFinite(value))
        throw new Error(`${option} requires a number.`);
      assign(values, key, value);
    }
  }

  let position = 0;
  const targets: Record<string, string> = {};
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const alias =
      key === "sandboxId"
        ? values.sandbox
        : key === "poolId"
          ? values.pool
          : undefined;
    const explicit = values[key] ?? alias;
    const value = explicit ?? positional[position++];
    if (typeof value !== "string" || !value)
      throw new Error(`${operation.command} requires ${key}.`);
    delete values[key];
    if (key === "sandboxId") delete values.sandbox;
    if (key === "poolId") delete values.pool;
    targets[key] = value;
    return encodeURIComponent(value);
  });
  if (
    operation.command === "sandbox workspace export" &&
    positional[position]
  ) {
    output = positional[position];
    position++;
  }
  if (
    operation.command === "sandbox workspace import" &&
    positional[position]
  ) {
    values.archivePath = positional[position];
    position++;
  }
  if (positional.length > position) {
    throw new Error(
      `${operation.command} received unexpected positional argument '${positional[position]}'.`,
    );
  }

  if (
    operation.command === "registry create" ||
    operation.command === "registry update"
  ) {
    const direct =
      typeof values.secret === "string" ? values.secret : undefined;
    const environment = process.env.BOREALIS_REGISTRY_SECRET;
    const file =
      typeof values.secretFile === "string"
        ? await readOwnerOnlySecretFile(values.secretFile)
        : undefined;
    const sources = [direct, environment, file, values.secretStdin].filter(
      Boolean,
    );
    if (sources.length > 1)
      throw new Error("Specify only one registry secret source.");
    if (direct)
      process.stderr.write(
        "Warning: --secret may expose credentials in shell history; prefer BOREALIS_REGISTRY_SECRET, --secret-file, or --secret-stdin.\n",
      );
    let secret = direct ?? environment ?? file?.trim();
    if (values.secretStdin) {
      secret = await readBoundedSecretStdin(process.stdin, signal);
    }
    delete values.secret;
    delete values.secretFile;
    delete values.secretStdin;
    if (secret) values.secret = secret;
  }

  const remap = (from: string, to: string): void => {
    if (values[from] !== undefined && values[to] === undefined)
      values[to] = values[from];
    if (from !== to) delete values[from];
  };
  if (operation.operationId.startsWith("registry.")) {
    remap("name", "displayName");
    remap("host", "registryHost");
    remap("type", "registryType");
    remap("repository", "allowedRepositories");
    remap("default", "isDefault");
  }
  if (operation.operationId.startsWith("template.") && templateConvenience) {
    const displayName = values.displayName ?? values.name;
    if (operation.method !== "GET" && operation.method !== "DELETE") {
      values.displayName = displayName;
      values.defaults = {
        name: values.sandboxName ?? displayName,
        image: values.image,
        ...(values.command !== undefined ? { command: values.command } : {}),
        idleTimeoutMinutes: values.idleTimeout ?? 60,
      };
      for (const key of [
        "name",
        "sandboxName",
        "image",
        "command",
        "idleTimeout",
      ])
        delete values[key];
    }
  }
  if (operation.operationId.startsWith("host_pool.")) {
    remap("name", "displayName");
    remap("placement", "defaultPlacementPolicy");
    if (
      operation.operationId === "host_pool.create" &&
      values.slug === undefined &&
      typeof values.displayName === "string"
    ) {
      values.slug = values.displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    }
  }
  if (operation.operationId === "host_enrollment.create") {
    remap("name", "agentName");
    remap("slots", "capacitySlots");
  }
  if (operation.operationId === "sandbox.create") {
    remap("arg", "args");
    remap("workdir", "workingDirectory");
    remap("idleTimeout", "idleTimeoutMinutes");
    if (values.noStart === true) values.startImmediately = false;
    delete values.noStart;
    if (Array.isArray(values.env)) {
      values.environment = Object.fromEntries(
        values.env.map((entry) => {
          const text = String(entry);
          const separator = text.indexOf("=");
          if (separator < 1) throw new Error("--env requires NAME=value.");
          return [text.slice(0, separator), text.slice(separator + 1)];
        }),
      );
      delete values.env;
    }
    if (Array.isArray(values.port)) {
      values.exposedPorts = values.port.map(parsePortBinding);
      delete values.port;
    }
    if (values.cpu !== undefined || values.memory !== undefined) {
      values.resourceProfile = {
        cpuCores: values.cpu ?? 1,
        memoryGb: values.memory ?? 2,
      };
      delete values.cpu;
      delete values.memory;
    }
  }
  const waitTimeoutSeconds = wait
    ? values.timeout === undefined
      ? 900
      : Number(values.timeout)
    : undefined;
  if (
    waitTimeoutSeconds !== undefined &&
    (!Number.isInteger(waitTimeoutSeconds) ||
      waitTimeoutSeconds < 1 ||
      waitTimeoutSeconds > 21_600)
  )
    throw new Error("--timeout must be an integer from 1 to 21600 seconds.");
  if (operation.operationId === "sandbox.exec.start") {
    remap("timeout", "timeoutSeconds");
  } else if (operation.operationId === "interactive.stdin") {
    remap("newline", "addNewLine");
    remap("timeout", "timeoutSeconds");
  } else {
    delete values.timeout;
  }
  if (operation.operationId === "sandbox.workspace.import") {
    if (values.keep === true) values.clearWorkspace = false;
    delete values.keep;
  }
  if (operation.operationId === "service_principal.create") {
    remap("scope", "scopes");
  }
  if (operation.operationId === "billing.checkout.create") {
    remap("account", "accountId");
    remap("price", "priceId");
    remap("plan", "planId");
  }
  if (operation.operationId === "billing.auto_top_up.configure") {
    if (values.enable !== undefined || values.disable !== undefined || !body) {
      if ((values.enable === true) === (values.disable === true))
        throw new Error(
          "billing auto-top-up requires exactly one of --enable or --disable.",
        );
      const enabled = values.enable === true;
      const threshold = Number(values.threshold);
      const target = Number(values.target);
      if (
        enabled &&
        (!Number.isInteger(threshold) ||
          !Number.isInteger(target) ||
          threshold < 0 ||
          target <= 0 ||
          target <= threshold)
      )
        throw new Error(
          "billing auto-top-up --enable requires a non-negative --threshold and a positive --target greater than the threshold.",
        );
      values.enabled = enabled;
      values.thresholdMicrocredits = enabled ? threshold : 0;
      values.targetMicrocredits = enabled ? target : 0;
      for (const key of ["enable", "disable", "threshold", "target"])
        delete values[key];
    }
  }

  const query = new URLSearchParams();
  if (operation.method === "GET") {
    for (const [key, value] of Object.entries(values)) {
      for (const item of Array.isArray(value) ? value : [value])
        query.append(key, String(item));
    }
  } else {
    body = { ...(body ?? {}), ...values };
  }
  const explicit =
    typeof values.idempotencyKey === "string"
      ? values.idempotencyKey
      : operation.operationId === "snapshot.create" &&
          typeof values.requestId === "string"
        ? values.requestId
        : undefined;
  if (body) delete body.idempotencyKey;
  if (operation.operationId === "snapshot.create" && body)
    delete body.requestId;
  const resolvedIdempotencyKey =
    operation.idempotency === "idempotency-key"
      ? (explicit ?? randomUUID())
      : undefined;
  if (
    operation.operationId === "billing.top_up.create" &&
    body &&
    resolvedIdempotencyKey
  )
    body.idempotencyKey = resolvedIdempotencyKey;
  return {
    path,
    query,
    ...(body && Object.keys(body).length ? { body } : {}),
    ...(resolvedIdempotencyKey
      ? { idempotencyKey: resolvedIdempotencyKey }
      : {}),
    ...(output ? { output } : {}),
    ...(waitTimeoutSeconds !== undefined ? { waitTimeoutSeconds } : {}),
  };
}

export async function readBoundedSecretStdin(
  stream: Readable,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      stream.pause();
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      const secret = Buffer.concat(chunks).toString("utf8").trim();
      if (!secret) reject(new Error("Registry secret from stdin is empty."));
      else resolve(secret);
    };
    const onData = (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > 65_536) {
        finish(new Error("Registry secret from stdin exceeds 64 KiB."));
        return;
      }
      chunks.push(value);
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onAbort = (): void => finish(signal?.reason);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.resume();
  });
}

export function targetFromPath(
  operation: Operation,
  requestPath: string,
): Record<string, string> {
  const template = operation.path.split("/");
  const actual = requestPath.split("/");
  return Object.fromEntries(
    template.flatMap((part, index) =>
      part.startsWith("{")
        ? [[part.slice(1, -1), decodeURIComponent(actual[index]!)]]
        : [],
    ),
  );
}
