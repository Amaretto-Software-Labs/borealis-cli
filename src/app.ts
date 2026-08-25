import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import {
  AmbiguousDispatchError,
  ApiError,
  BorealisApiClient,
} from "./api-client.js";
import { deleteSession } from "./session-store.js";
import { login, resolveAccessToken } from "./auth.js";
import { operations, resolveOperation } from "./catalog.js";
import { completion } from "./completion.js";
import { validateCommandGrammar } from "./command-grammar.js";
import { defaults, validateOrigin } from "./config.js";
import { writeCredentialFile } from "./credential-file.js";
import { prepareRequest } from "./invocation.js";
import { attach } from "./interactive.js";
import { writeResult } from "./output.js";
import type { GlobalOptions } from "./types.js";

const packageJson = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

function parseGlobals(argv: readonly string[]): {
  options: GlobalOptions;
  command: string[];
  apiExplicit: boolean;
} {
  const options: GlobalOptions = {
    api: defaults.api,
    identity: defaults.identity,
    app: defaults.app,
    profile: "default",
    json: false,
    yes: false,
  };
  const command: string[] = [];
  let apiExplicit = false;
  const names = new Map<string, keyof GlobalOptions>([
    ["--api", "api"],
    ["--identity", "identity"],
    ["--app", "app"],
    ["--profile", "profile"],
    ["--organization", "organization"],
    ["--token-file", "tokenFile"],
    ["--token", "token"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--json") options.json = true;
    else if (value === "--yes") options.yes = true;
    else {
      const separator = value.indexOf("=");
      const name = separator >= 0 ? value.slice(0, separator) : value;
      if (!names.has(name)) {
        command.push(value);
        continue;
      }
      const next = separator >= 0 ? value.slice(separator + 1) : argv[++index];
      if (!next) throw new Error(`Missing value for ${value}.`);
      (options as unknown as Record<string, unknown>)[names.get(name)!] = next;
      if (name === "--api") apiExplicit = true;
    }
  }
  options.api = validateOrigin(options.api, "API URL");
  options.identity = validateOrigin(options.identity, "Identity URL");
  options.app = validateOrigin(options.app, "Application URL");
  return { options, command, apiExplicit };
}

export function resolveApiBase(
  configuredApi: string,
  sessionApi: string | undefined,
  explicit: boolean,
): string {
  if (explicit && sessionApi && configuredApi !== sessionApi)
    throw new Error(
      "An explicit API origin cannot reuse credentials from a different saved session. Supply an explicit token or log in to a separate profile for that API.",
    );
  return explicit ? configuredApi : (sessionApi ?? configuredApi);
}

function optionValue(
  args: readonly string[],
  option: string,
): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const current = args[index]!;
    let value: string | undefined;
    if (current === option) value = args[++index];
    else if (current.startsWith(`${option}=`))
      value = current.slice(option.length + 1);
    else continue;
    if (!value) throw new Error(`Missing value for ${option}.`);
    if (result !== undefined)
      throw new Error(`${option} may only be specified once.`);
    result = value;
  }
  return result;
}

export function parseAuthLoginOptions(command: readonly string[]): {
  loginHint?: string;
  scope?: string;
} {
  const loginHint = optionValue(command, "--login-hint");
  const clientId = optionValue(command, "--client-id");
  if (clientId !== undefined && clientId !== defaults.clientId)
    throw new Error(
      `The Borealis CLI OAuth client ID is fixed to '${defaults.clientId}'.`,
    );
  const redirectPort = optionValue(command, "--redirect-port");
  if (redirectPort !== undefined && redirectPort !== "17890")
    throw new Error(
      "--redirect-port must be 17890, the registered Borealis CLI OAuth callback port.",
    );
  const scope = optionValue(command, "--scope");
  return {
    ...(loginHint ? { loginHint } : {}),
    ...(scope ? { scope } : {}),
  };
}

async function confirm(operationId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return (
      (
        await terminal.question(
          `Confirm destructive operation ${operationId}? [y/N] `,
        )
      )
        .trim()
        .toLowerCase() === "y"
    );
  } finally {
    terminal.close();
  }
}

function help(): string {
  const groups = operations.reduce<Record<string, string[]>>(
    (result, operation) => {
      const group = operation.command.split(" ")[0]!;
      (result[group] ??= []).push(operation.command);
      return result;
    },
    {},
  );
  return `Borealis CLI\n\nUsage: borealis [global options] <command> [arguments] [options]\n\nGlobal options:\n  --api <origin>  --identity <origin>  --app <origin>\n  --profile <name>  --organization <id>  --token-file <path>\n  --json  --yes\n\nCommands:\n${Object.entries(
    groups,
  )
    .map(
      ([group, commands]) =>
        `  ${group.padEnd(18)}${commands.length} API operations`,
    )
    .join(
      "\n",
    )}\n  auth login|whoami|logout\n  completion bash|zsh|fish\n\nUse --set key=value or --body '{...}' for operation request fields. Path identifiers are positional.\n`;
}

async function runInternal(
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const { options, command, apiExplicit } = parseGlobals(argv);
  if (command.length === 0 || ["help", "-h", "--help"].includes(command[0]!)) {
    process.stdout.write(help());
    return 0;
  }
  if (
    command[0] === "version" ||
    command[0] === "--version" ||
    command[0] === "-V"
  ) {
    process.stdout.write(`${packageJson.version}\n`);
    return 0;
  }
  if (command[0] === "completion") {
    process.stdout.write(completion(command[1] ?? ""));
    return 0;
  }
  if (command[0] === "auth") {
    if (command[1] === "login") {
      const loginOptions = parseAuthLoginOptions(command);
      const session = await login(
        options,
        loginOptions.loginHint,
        loginOptions.scope,
        signal,
      );
      writeResult(
        {
          authenticated: true,
          profile: options.profile,
          expiresAt: session.expiresAt,
        },
        options.json,
      );
      return 0;
    }
    if (command[1] === "logout") {
      await deleteSession(options.profile, signal);
      writeResult(
        { authenticated: false, profile: options.profile },
        options.json,
      );
      return 0;
    }
    if (command[1] === "whoami") {
      command.splice(0, command.length, "context", "show");
    } else throw new Error("auth requires login, whoami, or logout.");
  }

  const resolved = resolveOperation(command);
  if (!resolved) throw new Error(`Unknown command '${command.join(" ")}'.`);
  const request = await prepareRequest(
    resolved.operation,
    resolved.rest,
    signal,
  );
  const requestBody =
    request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : undefined;
  const requiresConfirmation =
    (resolved.operation.risk === "destructive" &&
      !(
        resolved.operation.operationId === "sandbox.workspace.import" &&
        resolved.rest.includes("--keep")
      )) ||
    (resolved.operation.operationId === "billing.auto_top_up.configure" &&
      requestBody?.enabled === true);
  if (
    requiresConfirmation &&
    !options.yes &&
    !(await confirm(resolved.operation.operationId))
  ) {
    throw new Error(
      "Destructive operation cancelled. Pass --yes for non-interactive use.",
    );
  }
  const auth = await resolveAccessToken(options, signal);
  const api = resolveApiBase(options.api, auth.session?.api, apiExplicit);
  const organization = options.organization ?? auth.session?.organization;
  if (
    resolved.operation.operationId === "host_enrollment.get" &&
    !resolved.rest.includes("--include-secret") &&
    !request.output
  )
    throw new Error(
      "Credential-bearing commands require --output <path> or --include-secret before dispatch.",
    );
  if (resolved.operation.operationId === "interactive.stream") {
    await attach(
      new URL(
        `${request.path}${request.query.size ? `?${request.query}` : ""}`,
        api,
      ).toString(),
      auth.token,
      organization,
      signal,
    );
    return 0;
  }
  const client = new BorealisApiClient({
    api,
    token: auth.token,
    ...(organization ? { organization } : {}),
    ...(signal ? { signal } : {}),
  });
  const cleanupClient = (): BorealisApiClient =>
    new BorealisApiClient({
      api,
      token: auth.token,
      ...(organization ? { organization } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  const interactiveCredential =
    ["service_principal.create", "host_enrollment.create"].includes(
      resolved.operation.operationId,
    ) &&
    !resolved.rest.includes("--include-secret") &&
    !request.output
      ? true
      : resolved.operation.operationId === "registry.create" &&
        requestBody?.secret === undefined;
  let result = interactiveCredential
    ? await client.invokeInteractiveCredential(resolved.operation, request)
    : await client.invoke(resolved.operation, request);
  if (interactiveCredential) {
    const claimUri = (result as Record<string, unknown>)?.claimUri;
    process.stderr.write(
      `Complete credential delivery in your browser: ${String(claimUri)}\n`,
    );
  }
  if (request.waitTimeoutSeconds !== undefined)
    result = await client.waitFor(result, request.waitTimeoutSeconds);
  if (
    resolved.operation.operationId === "organization.list" &&
    result &&
    typeof result === "object" &&
    Array.isArray((result as Record<string, unknown>).organizations)
  ) {
    result = (result as Record<string, unknown>).organizations;
  }
  if (
    resolved.operation.operationId === "sandbox.workspace.export" &&
    request.output === "-"
  ) {
    return 0;
  }
  if (
    !interactiveCredential &&
    resolved.operation.operationId === "service_principal.create" &&
    result &&
    typeof result === "object"
  ) {
    const include = resolved.rest.includes("--include-secret");
    const destination = request.output;
    if (!include && !destination)
      throw new Error(
        "Credential creation requires --output <path> or --include-secret for the one-time secret.",
      );
    if (destination) {
      const credential = result as Record<string, unknown>;
      const clientSecret = credential.clientSecret;
      if (typeof clientSecret !== "string" || !clientSecret)
        throw new Error(
          "The API returned a credential without its one-time client secret.",
        );
      try {
        await writeCredentialFile(destination, clientSecret);
      } catch (deliveryError) {
        const clientId = (result as Record<string, unknown>).clientId;
        if (typeof clientId === "string") {
          const revoke = operations.find(
            (operation) => operation.operationId === "service_principal.revoke",
          )!;
          try {
            await cleanupClient().invoke(revoke, {
              path: revoke.path.replace(
                "{clientId}",
                encodeURIComponent(clientId),
              ),
              query: new URLSearchParams(),
            });
          } catch (revokeError) {
            throw new AggregateError(
              [deliveryError, revokeError],
              `Credential delivery failed and service principal '${clientId}' could not be confirmed revoked; it may remain active.`,
            );
          }
          throw new Error(
            `Credential delivery failed; service principal '${clientId}' was revoked.`,
            { cause: deliveryError },
          );
        }
        throw deliveryError;
      }
      const redacted = { ...(result as Record<string, unknown>) };
      for (const key of ["clientSecret", "secret", "accessToken"])
        if (key in redacted) redacted[key] = "[written to file]";
      result = redacted;
    }
  }
  if (
    !interactiveCredential &&
    ["host_enrollment.create", "host_enrollment.get"].includes(
      resolved.operation.operationId,
    ) &&
    result &&
    typeof result === "object"
  ) {
    const include = resolved.rest.includes("--include-secret");
    const destination = request.output;
    if (!include && !destination)
      throw new Error(
        "Host enrollment delivery requires --output <path> or --include-secret.",
      );
    if (destination) {
      const enrollment = result as Record<string, unknown>;
      const secret =
        typeof enrollment.command === "string" && enrollment.command
          ? enrollment.command
          : enrollment.code;
      if (typeof secret !== "string" || !secret)
        throw new Error(
          "The API returned an enrollment without its one-time credential.",
        );
      try {
        await writeCredentialFile(destination, secret);
      } catch (deliveryError) {
        const sessionId = (result as Record<string, unknown>).sessionId;
        const poolMatch = request.path.match(/\/host-pools\/([^/]+)/);
        if (typeof sessionId === "string" && poolMatch?.[1]) {
          const cancel = operations.find(
            (operation) => operation.operationId === "host_enrollment.cancel",
          )!;
          try {
            await cleanupClient().invoke(cancel, {
              path: cancel.path
                .replace("{poolId}", poolMatch[1])
                .replace("{sessionId}", encodeURIComponent(sessionId)),
              query: new URLSearchParams(),
            });
          } catch (cancelError) {
            throw new AggregateError(
              [deliveryError, cancelError],
              `Enrollment delivery failed and session '${sessionId}' could not be confirmed cancelled; it may remain active.`,
            );
          }
          throw new Error(
            `Enrollment delivery failed; session '${sessionId}' was cancelled.`,
            { cause: deliveryError },
          );
        }
        throw deliveryError;
      }
      const redacted = { ...(result as Record<string, unknown>) };
      for (const key of ["code", "command", "claimToken"])
        if (key in redacted) redacted[key] = "[written to file]";
      result = redacted;
    }
  }
  writeResult(result, options.json);
  return 0;
}

export async function run(
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<number> {
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(help());
      return 0;
    }
    validateCommandGrammar(argv);
    return await runInternal(argv, signal);
  } catch (error) {
    if (error instanceof AggregateError) {
      process.stderr.write(`Warning: ${error.message}\n`);
      return signal?.aborted ? 130 : 1;
    }
    if (signal?.aborted) {
      if (error instanceof AmbiguousDispatchError)
        process.stderr.write(`${error.message}\n`);
      return 130;
    }
    if (error instanceof ApiError) {
      process.stderr.write(
        `${error.message}${error.traceId ? `\nTrace: ${error.traceId}` : ""}\n`,
      );
      return error.status === 401 || error.status === 403 ? 2 : 3;
    }
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
