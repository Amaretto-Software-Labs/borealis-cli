import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configDirectory } from "./config.js";
import { sessionSchema, type Session } from "./types.js";

const service = "com.amarettosoftwarelabs.borealis-cli";
const profilePattern = /^[A-Za-z0-9._-]{1,64}$/;
const insecureFileOptIn = "BOREALIS_CLI_ALLOW_INSECURE_FILE_SESSION";

export interface NativeCommandOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type NativeCommandExecutor = (
  file: string,
  arguments_: readonly string[],
  options?: NativeCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }
  if (platform === "win32") {
    const killer = spawn(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", () => child.kill("SIGKILL"));
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export const executeBoundedNativeCommand: NativeCommandExecutor = async (
  file,
  arguments_,
  options = {},
) => {
  options.signal?.throwIfAborted();
  return await new Promise<{ stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(file, arguments_, {
        detached: true,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let settled = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const cleanup = (): void => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error, terminate = true): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          if (terminate) terminateProcessTree(child);
          reject(error);
        } else {
          resolvePromise({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        }
      };
      const onAbort = (): void =>
        finish(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new DOMException("Aborted", "AbortError"),
        );
      const timeout = setTimeout(
        () => finish(new DOMException(`'${file}' timed out.`, "TimeoutError")),
        options.timeoutMs ?? 15_000,
      );
      timeout.unref();
      const trackOutput = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 1024 * 1024)
          finish(new Error(`'${file}' produced too much output.`));
        else target.push(chunk);
      };
      child.stdout?.on("data", trackOutput(stdout));
      child.stderr?.on("data", trackOutput(stderr));
      child.stdin?.once("error", (error) => finish(error));
      child.once("error", (error) => finish(error, false));
      child.once("close", (code) => {
        if (code === 0) {
          finish();
          return;
        }
        const error = new Error(
          `'${file}' exited with status ${code ?? -1}.`,
        ) as Error & { code?: number | string; stderr?: string };
        error.code = code ?? -1;
        error.stderr = Buffer.concat(stderr).toString("utf8");
        finish(error, false);
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      child.stdin?.end(options.input ?? "");
    },
  );
};

export type CredentialFileDescriptorExecutor = (
  file: string,
  arguments_: readonly string[],
  program: string,
  secret: string,
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;

const macOSCredentialProgram = String.raw`ObjC.import("Foundation");
ObjC.import("Security");

function run(argv) {
  if (argv.length !== 3) throw new Error("Expected operation, service, and account.");
  const operation = argv[0];
  const value = (item) => $.NSString.stringWithString(item);
  const constant = (item) => ObjC.castRefToObject(item);
  const query = $.NSMutableDictionary.alloc.init;
  query.setObjectForKey(constant($.kSecClassGenericPassword), constant($.kSecClass));
  query.setObjectForKey(value(argv[1]), constant($.kSecAttrService));
  query.setObjectForKey(value(argv[2]), constant($.kSecAttrAccount));

  if (operation === "get") {
    query.setObjectForKey($.NSNumber.numberWithBool(true), constant($.kSecReturnData));
    query.setObjectForKey(constant($.kSecMatchLimitOne), constant($.kSecMatchLimit));
    const result = Ref();
    const status = Number($.SecItemCopyMatching(query, result));
    if (status === Number($.errSecItemNotFound)) return "missing";
    if (status !== Number($.errSecSuccess))
      throw new Error("Keychain read failed with status " + status + ".");
    const secretData = ObjC.castRefToObject(result[0]);
    return "value:" + ObjC.unwrap(secretData.base64EncodedStringWithOptions(0));
  }

  if (operation === "delete") {
    const status = Number($.SecItemDelete(query));
    if (status !== Number($.errSecSuccess) && status !== Number($.errSecItemNotFound))
      throw new Error("Keychain deletion failed with status " + status + ".");
    return "deleted";
  }

  if (operation !== "set") throw new Error("Unsupported Keychain operation.");
  const secretHandle = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, false);
  const secretData = secretHandle.readDataToEndOfFile;
  if (Number(secretData.length) === 0) throw new Error("Credential data is empty.");
  const attributes = $.NSMutableDictionary.alloc.init;
  attributes.setObjectForKey(secretData, constant($.kSecValueData));
  let status = Number($.SecItemUpdate(query, attributes));
  if (status === Number($.errSecItemNotFound)) {
    query.setObjectForKey(secretData, constant($.kSecValueData));
    status = Number($.SecItemAdd(query, null));
  }
  if (status !== Number($.errSecSuccess))
    throw new Error("Keychain write failed with status " + status + ".");
  return "stored";
}
`;

const executeCredentialFileDescriptorCommand: CredentialFileDescriptorExecutor =
  async (file, arguments_, program, secret, signal) => {
    signal?.throwIfAborted();
    return await new Promise<{ stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        const child = spawn(file, arguments_, {
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        let settled = false;
        let outputBytes = 0;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          if (error) {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
            reject(error);
          } else {
            resolvePromise({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            });
          }
        };
        const timeout = setTimeout(
          () => finish(new Error(`'${file}' timed out.`)),
          15_000,
        );
        timeout.unref();
        const onAbort = (): void =>
          finish(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"),
          );
        const trackOutput = (target: Buffer[]) => (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > 64 * 1024)
            finish(new Error(`'${file}' produced too much output.`));
          else target.push(chunk);
        };
        child.stdout?.on("data", trackOutput(stdout));
        child.stderr?.on("data", trackOutput(stderr));
        child.once("error", finish);
        child.once("close", (code) =>
          code === 0
            ? finish()
            : finish(new Error(`'${file}' exited with status ${code ?? -1}.`)),
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        const secretPipe = child.stdio[3] as
          (NodeJS.WritableStream & { end(value: string): void }) | null;
        if (!child.stdin || !secretPipe) {
          finish(new Error("Unable to open credential process pipes."));
          return;
        }
        child.stdin.once("error", finish);
        secretPipe.once("error", finish);
        child.stdin.end(program);
        secretPipe.end(secret);
      },
    );
  };

export interface SessionSecretStore {
  read(signal?: AbortSignal): Promise<string | undefined>;
  write(value: string, signal?: AbortSignal): Promise<void>;
  clear(signal?: AbortSignal): Promise<void>;
}

export class NativeSessionSecretStore implements SessionSecretStore {
  constructor(
    private readonly account: string,
    private readonly platform = process.platform,
    private readonly encryptedPath = join(
      configDirectory,
      `${account.replace(/[^A-Za-z0-9._-]/g, "_")}.session.dpapi`,
    ),
    private readonly execute: NativeCommandExecutor = executeBoundedNativeCommand,
  ) {}

  async read(signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    try {
      if (this.platform === "darwin") {
        return (
          (await readMacOSKeychainCredential(
            service,
            this.account,
            executeCredentialFileDescriptorCommand,
            signal,
          )) ?? undefined
        );
      }
      if (this.platform === "linux") {
        const { stdout } = await this.execute(
          "secret-tool",
          ["lookup", "service", service, "account", this.account],
          { ...(signal ? { signal } : {}) },
        );
        return stdout.replace(/\r?\n$/, "") || undefined;
      }
      if (this.platform === "win32") {
        const { stdout } = await this.powerShell(
          `
Add-Type -AssemblyName System.Security
if (-not [IO.File]::Exists($env:BOREALIS_CLI_SECRET_PATH)) { exit 44 }
$raw = [IO.File]::ReadAllText($env:BOREALIS_CLI_SECRET_PATH)
$protected = [Convert]::FromBase64String($raw)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`,
          {},
          signal,
        );
        return stdout || undefined;
      }
      return undefined;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (this.platform === "linux" && isMissingLinuxSecret(error))
        return undefined;
      if (this.platform === "win32" && isMissingWindowsSecret(error))
        return undefined;
      throw error;
    }
  }

  async write(value: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      if (this.platform === "darwin") {
        await writeMacOSKeychainCredential(
          service,
          this.account,
          value,
          executeCredentialFileDescriptorCommand,
          signal,
        );
        return;
      }
      if (this.platform === "linux") {
        await this.execute(
          "secret-tool",
          [
            "store",
            "--label",
            "Borealis CLI auth session",
            "service",
            service,
            "account",
            this.account,
          ],
          { input: value, ...(signal ? { signal } : {}) },
        );
        return;
      }
      if (this.platform === "win32") {
        await mkdir(configDirectory, { recursive: true });
        await this.powerShell(
          `
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($env:BOREALIS_CLI_SECRET_VALUE)
$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllText($env:BOREALIS_CLI_SECRET_PATH, [Convert]::ToBase64String($protected))
          `,
          { BOREALIS_CLI_SECRET_VALUE: value },
          signal,
        );
        return;
      }
      throw new Error(`Unsupported platform '${this.platform}'.`);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(
        `Native Borealis CLI credential storage is unavailable.${error instanceof Error && error.message ? ` ${error.message}` : ""}`,
      );
    }
  }

  async clear(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      if (this.platform === "darwin")
        await deleteMacOSKeychainCredential(
          service,
          this.account,
          executeCredentialFileDescriptorCommand,
          signal,
        );
      else if (this.platform === "linux")
        await this.execute(
          "secret-tool",
          ["clear", "service", service, "account", this.account],
          { ...(signal ? { signal } : {}) },
        );
      else if (this.platform === "win32") {
        await rm(this.encryptedPath, { force: true });
        signal?.throwIfAborted();
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (this.platform === "linux" && isMissingLinuxSecret(error)) return;
      throw error;
    }
  }

  private async powerShell(
    script: string,
    environment: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<{ stdout: string }> {
    return await this.execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        env: {
          ...process.env,
          BOREALIS_CLI_SECRET_PATH: resolve(this.encryptedPath),
          ...environment,
        },
        ...(signal ? { signal } : {}),
      },
    );
  }
}

function isMissingLinuxSecret(error: unknown): boolean {
  const failure = error as { code?: number | string; stderr?: string };
  return failure.code === 1 && !failure.stderr?.trim();
}

function isMissingWindowsSecret(error: unknown): boolean {
  return (error as { code?: number | string }).code === 44;
}

export class FileSessionSecretStore implements SessionSecretStore {
  constructor(private readonly path: string) {}

  async read(signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const value = await readFile(this.path, "utf8").catch(() => undefined);
    signal?.throwIfAborted();
    return value;
  }

  async write(value: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(configDirectory, 0o700);
    await writeFile(this.path, value, { mode: 0o600, flag: "w" });
    if (process.platform !== "win32") await chmod(this.path, 0o600);
    signal?.throwIfAborted();
  }

  async clear(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await rm(this.path, { force: true });
    signal?.throwIfAborted();
  }
}

export class SecureFallbackSessionSecretStore implements SessionSecretStore {
  constructor(
    private readonly secure: SessionSecretStore,
    private readonly insecure: SessionSecretStore,
    private readonly allowInsecure = () =>
      process.env[insecureFileOptIn] === "1",
  ) {}

  async read(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const value = await this.secure.read(signal);
      if (value) return value;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw error;
      // A missing platform keychain is treated as no stored session.
    }
    return this.allowInsecure() ? await this.insecure.read(signal) : undefined;
  }

  async write(value: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.secure.write(value, signal);
      await this.insecure.clear(signal);
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!this.allowInsecure())
        throw new Error(
          `Secure Borealis CLI credential storage is unavailable. Install platform keychain support, or explicitly set ${insecureFileOptIn}=1 to opt in to plaintext local session storage.`,
          { cause: error },
        );
    }
    await this.insecure.write(value, signal);
  }

  async clear(signal?: AbortSignal): Promise<void> {
    let secureFailure: unknown;
    try {
      await this.secure.clear(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      secureFailure = error;
    }
    let insecureFailure: unknown;
    try {
      await this.insecure.clear(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      insecureFailure = error;
    }
    if (secureFailure && insecureFailure)
      throw new AggregateError(
        [secureFailure, insecureFailure],
        "Secure and fallback session deletion both failed.",
      );
    if (secureFailure) throw secureFailure;
    if (insecureFailure) throw insecureFailure;
  }
}

function validateProfile(profile: string): void {
  if (!profilePattern.test(profile))
    throw new Error(
      "Profile names may contain only 1-64 letters, digits, dots, underscores, or hyphens.",
    );
}

function sessionStore(profile: string): SessionSecretStore {
  const account = `auth-session:${profile}`;
  return new SecureFallbackSessionSecretStore(
    new NativeSessionSecretStore(account),
    new FileSessionSecretStore(join(configDirectory, `${profile}.json`)),
  );
}

export async function loadSession(
  profile: string,
  signal?: AbortSignal,
): Promise<Session | undefined> {
  validateProfile(profile);
  const stored = await sessionStore(profile).read(signal);
  return stored ? sessionSchema.parse(JSON.parse(stored)) : undefined;
}

export async function saveSession(
  profile: string,
  session: Session,
  signal?: AbortSignal,
): Promise<void> {
  validateProfile(profile);
  await sessionStore(profile).write(JSON.stringify(session), signal);
}

export async function deleteSession(
  profile: string,
  signal?: AbortSignal,
): Promise<void> {
  validateProfile(profile);
  await sessionStore(profile).clear(signal);
}

export async function writeMacOSKeychainCredential(
  serviceName: string,
  account: string,
  secret: string,
  execute: CredentialFileDescriptorExecutor = executeCredentialFileDescriptorCommand,
  signal?: AbortSignal,
): Promise<void> {
  await executeMacOSKeychainCredential(
    "set",
    serviceName,
    account,
    secret,
    execute,
    signal,
  );
}

export async function readMacOSKeychainCredential(
  serviceName: string,
  account: string,
  execute: CredentialFileDescriptorExecutor = executeCredentialFileDescriptorCommand,
  signal?: AbortSignal,
): Promise<string | null> {
  const value = await executeMacOSKeychainCredential(
    "get",
    serviceName,
    account,
    "",
    execute,
    signal,
  );
  if (value === "missing") return null;
  if (!value.startsWith("value:"))
    throw new Error("Keychain returned an invalid response.");
  return Buffer.from(value.slice("value:".length), "base64").toString("utf8");
}

export async function deleteMacOSKeychainCredential(
  serviceName: string,
  account: string,
  execute: CredentialFileDescriptorExecutor = executeCredentialFileDescriptorCommand,
  signal?: AbortSignal,
): Promise<void> {
  await executeMacOSKeychainCredential(
    "delete",
    serviceName,
    account,
    "",
    execute,
    signal,
  );
}

async function executeMacOSKeychainCredential(
  operation: "get" | "set" | "delete",
  serviceName: string,
  account: string,
  secret: string,
  execute: CredentialFileDescriptorExecutor,
  signal?: AbortSignal,
): Promise<string> {
  const result = await execute(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-", operation, serviceName, account],
    macOSCredentialProgram,
    secret,
    signal,
  );
  return result.stdout.replace(/\r?\n$/, "");
}
