import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  deleteMacOSKeychainCredential,
  executeBoundedNativeCommand,
  NativeSessionSecretStore,
  readMacOSKeychainCredential,
  SecureFallbackSessionSecretStore,
  type SessionSecretStore,
  writeMacOSKeychainCredential,
} from "./session-store.js";

const failingStore = (): SessionSecretStore => ({
  read: vi.fn(async () => {
    throw new Error("unavailable");
  }),
  write: vi.fn(async () => {
    throw new Error("unavailable");
  }),
  clear: vi.fn(async () => undefined),
});

const memoryStore = (): SessionSecretStore & { value?: string } => ({
  value: undefined,
  async read() {
    return this.value;
  },
  async write(value) {
    this.value = value;
  },
  async clear() {
    this.value = undefined;
  },
});

describe("secure session storage fallback", () => {
  it("passes macOS keychain secrets through a dedicated file descriptor", async () => {
    const runner = vi.fn(async () => ({ stdout: "stored\n", stderr: "" }));

    await writeMacOSKeychainCredential(
      "test.borealis.cli",
      "auth-session:test",
      "top-secret",
      runner,
    );

    expect(runner).toHaveBeenCalledOnce();
    const [command, args, program, secret] = runner.mock.calls[0]!;
    expect(command).toBe("/usr/bin/osascript");
    expect(args).toEqual([
      "-l",
      "JavaScript",
      "-",
      "set",
      "test.borealis.cli",
      "auth-session:test",
    ]);
    expect(args).not.toContain("top-secret");
    expect(program).toContain('ObjC.import("Security")');
    expect(program).not.toContain("top-secret");
    expect(secret).toBe("top-secret");
  });

  it("reads and deletes macOS keychain credentials through the native bridge", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: `value:${Buffer.from("saved-session").toString("base64")}\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "deleted\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "missing\n", stderr: "" });

    await expect(
      readMacOSKeychainCredential(
        "test.borealis.cli",
        "auth-session:test",
        runner,
      ),
    ).resolves.toBe("saved-session");
    await deleteMacOSKeychainCredential(
      "test.borealis.cli",
      "auth-session:test",
      runner,
    );
    await expect(
      readMacOSKeychainCredential(
        "test.borealis.cli",
        "auth-session:test",
        runner,
      ),
    ).resolves.toBeNull();

    expect(runner.mock.calls.map((call) => call[1][3])).toEqual([
      "get",
      "delete",
      "get",
    ]);
  });

  it("fails closed without silently writing a plaintext session", async () => {
    const insecure = memoryStore();
    const store = new SecureFallbackSessionSecretStore(
      failingStore(),
      insecure,
      () => false,
    );
    await expect(store.write("session-token")).rejects.toThrow(
      "Secure Borealis CLI credential storage is unavailable",
    );
    expect(insecure.value).toBeUndefined();
  });

  it("uses plaintext only after explicit opt-in", async () => {
    const insecure = memoryStore();
    const store = new SecureFallbackSessionSecretStore(
      failingStore(),
      insecure,
      () => true,
    );
    await store.write("session-token");
    expect(await store.read()).toBe("session-token");
  });

  it("prefers native secure storage over the insecure opt-in store", async () => {
    const native = memoryStore();
    const insecure = memoryStore();
    const store = new SecureFallbackSessionSecretStore(
      native,
      insecure,
      () => false,
    );
    await store.write("session-token");
    expect(native.value).toBe("session-token");
    expect(insecure.value).toBeUndefined();
  });

  it("surfaces secure deletion failures after still clearing the fallback", async () => {
    const secure = memoryStore();
    secure.clear = vi.fn(async () => {
      throw new Error("keychain delete failed");
    });
    const insecure = memoryStore();
    insecure.value = "fallback";
    const store = new SecureFallbackSessionSecretStore(
      secure,
      insecure,
      () => true,
    );

    await expect(store.clear()).rejects.toThrow("keychain delete failed");
    expect(insecure.value).toBeUndefined();
  });

  it("treats only a verified missing Linux secret as idempotent deletion", async () => {
    const missing = Object.assign(new Error("missing"), {
      code: 1,
      stderr: "",
    });
    const failure = Object.assign(new Error("backend failed"), {
      code: 1,
      stderr: "D-Bus unavailable",
    });
    await expect(
      new NativeSessionSecretStore(
        "auth-session:test",
        "linux",
        "/unused",
        vi.fn(async () => {
          throw missing;
        }),
      ).clear(),
    ).resolves.toBeUndefined();
    await expect(
      new NativeSessionSecretStore(
        "auth-session:test",
        "linux",
        "/unused",
        vi.fn(async () => {
          throw failure;
        }),
      ).clear(),
    ).rejects.toThrow("backend failed");
  });

  it.each(["linux", "win32"] as const)(
    "threads cancellation through %s secure-store commands",
    async (platform) => {
      const controller = new AbortController();
      const execute = vi.fn(async () => ({
        stdout: "saved-session",
        stderr: "",
      }));
      const store = new NativeSessionSecretStore(
        "auth-session:test",
        platform,
        "/unused",
        execute,
      );

      await store.read(controller.signal);

      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]![2]).toMatchObject({
        signal: controller.signal,
      });
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "bounded native command execution",
  () => {
    async function waitForPid(path: string): Promise<number> {
      for (let attempt = 0; attempt < 50; attempt++) {
        const value = await readFile(path, "utf8").catch(() => undefined);
        if (value) return Number(value.trim());
        await delay(10);
      }
      throw new Error("Child PID was not recorded.");
    }

    async function expectProcessExited(pid: number): Promise<void> {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await delay(10);
      }
      throw new Error(`Child process ${pid} was not terminated.`);
    }

    it("times out and terminates the spawned process tree", async () => {
      const temporary = await mkdtemp(join(tmpdir(), "borealis-process-test-"));
      const pidPath = join(temporary, "child.pid");
      try {
        const execution = executeBoundedNativeCommand(
          "/bin/sh",
          ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidPath],
          { timeoutMs: 100 },
        );
        const pid = await waitForPid(pidPath);
        await expect(execution).rejects.toMatchObject({ name: "TimeoutError" });
        await expectProcessExited(pid);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });

    it("cancels and terminates the spawned process tree", async () => {
      const temporary = await mkdtemp(join(tmpdir(), "borealis-process-test-"));
      const pidPath = join(temporary, "child.pid");
      const controller = new AbortController();
      try {
        const execution = executeBoundedNativeCommand(
          "/bin/sh",
          ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidPath],
          { signal: controller.signal, timeoutMs: 5_000 },
        );
        const pid = await waitForPid(pidPath);
        controller.abort(new DOMException("cancelled", "AbortError"));
        await expect(execution).rejects.toMatchObject({ name: "AbortError" });
        await expectProcessExited(pid);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  },
);
