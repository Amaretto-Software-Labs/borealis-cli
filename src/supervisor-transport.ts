import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as unixFetch } from "undici";
import { defaultSocket, type SupervisorTarget } from "./profiles.js";

export const supervisorOrigin = "http://borealis-supervisor";

export class LocalSocketPermissionError extends Error {
  readonly code = "supervisor_socket_permission_denied";

  constructor(
    readonly socket: string,
    cause: unknown,
    group?: string,
    processInGroup?: boolean,
  ) {
    const namedGroup =
      group ??
      (process.platform === "linux" && socket === defaultSocket
        ? "borealis"
        : undefined);
    const switchGroup =
      processInGroup === true
        ? " This shell has the socket's group. Check the socket and parent directory permissions."
        : namedGroup && /^[a-z_][a-z0-9_-]*$/i.test(namedGroup)
          ? ` If your user was just added to '${namedGroup}', run 'newgrp ${namedGroup}' or start a fresh login session.`
          : " If your group membership changed, start a fresh login session.";
    super(
      `Permission denied for the local supervisor socket at ${socket}. This terminal needs access through the socket's management group.${switchGroup}`,
      { cause },
    );
  }
}

export function localSocketError(
  error: unknown,
  socket: string,
  group?: string,
  processInGroup?: boolean,
): unknown {
  const seen = new Set<Error>();
  for (
    let current = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    if (current instanceof LocalSocketPermissionError) return current;
    if ((current as NodeJS.ErrnoException).code === "EACCES")
      return new LocalSocketPermissionError(
        socket,
        error,
        group,
        processInGroup,
      );
    seen.add(current);
  }
  return error;
}
const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ForkAfterAuthentication=no",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "ConnectTimeout=10",
];

export function directSubprocessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.BOREALIS_ACCESS_TOKEN;
  delete environment.BOREALIS_REGISTRY_SECRET;
  return environment;
}

export function verifiedSshOptions(): string[] {
  return [...sshOptions];
}

async function openSshForward(
  target: Extract<SupervisorTarget, { type: "ssh" }>,
  signal?: AbortSignal,
  destination: string = target.socket,
): Promise<{ socket: string; close(): Promise<void> }> {
  // Use a short private directory, including when macOS TMPDIR is very long.
  const directory = await mkdtemp("/tmp/borealis-");
  const socket = join(directory, "s.sock");
  const child = spawn(
    "ssh",
    [
      ...verifiedSshOptions(),
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StreamLocalBindUnlink=no",
      "-o",
      "RemoteCommand=none",
      "-L",
      `${socket}:${destination}`,
      "--",
      target.alias,
    ],
    { stdio: ["ignore", "ignore", "pipe"], env: directSubprocessEnvironment() },
  );
  let failure: Error | undefined;
  let diagnostics = "";
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, exitSignal) => {
      failure ??= new Error(
        diagnostics.trim() ||
          `OpenSSH stopped (${String(code ?? exitSignal)}).`,
      );
      resolve();
    });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (diagnostics.length < 8192)
      diagnostics += chunk.toString("utf8").slice(0, 8192 - diagnostics.length);
  });
  const close = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      const info = await lstat(socket).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info?.isSocket()) return { socket, close };
      await delay(40, undefined, { signal });
    }
    throw new Error(
      "OpenSSH did not establish the supervisor socket within 15 seconds.",
    );
  } catch (error) {
    await close();
    if (signal?.aborted) throw error;
    throw new Error(
      `SSH supervisor connection to '${target.alias}' failed. Verify the host key, SSH login, and Unix-socket forwarding access. ${error instanceof Error ? error.message : ""}`,
      { cause: error },
    );
  }
}

export interface SupervisorTransport {
  socket: string;
  fetch: typeof fetch;
  close(): Promise<void>;
}

export async function connectSupervisor(
  target: SupervisorTarget,
  signal?: AbortSignal,
): Promise<SupervisorTransport> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error(
      "Direct supervisor targets require a Linux or macOS CLI client with Unix-socket support.",
    );
  const forward =
    target.type === "ssh" ? await openSshForward(target, signal) : undefined;
  const socket = forward?.socket ?? target.socket;
  const dispatcher = new Agent({ connect: { socketPath: socket } });
  return {
    socket,
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== supervisorOrigin ||
        url.username ||
        url.password ||
        url.hash ||
        !url.pathname.startsWith("/api/v1/")
      )
        throw new Error("The supervisor returned an invalid API URI.");
      try {
        return (await unixFetch(url, {
          ...(init as Parameters<typeof unixFetch>[1]),
          redirect: "error",
          dispatcher,
        })) as unknown as Response;
      } catch (error) {
        throw target.type === "local" ? localSocketError(error, socket) : error;
      }
    }) as typeof fetch,
    async close() {
      try {
        await dispatcher.destroy();
      } finally {
        await forward?.close();
      }
    },
  };
}

export async function openSshPortForward(
  target: Extract<SupervisorTarget, { type: "ssh" }>,
  hostPort: number,
  localPort: number,
  signal?: AbortSignal,
): Promise<{ port: number; close(): Promise<void> }> {
  const forward = await openSshForward(target, signal, `127.0.0.1:${hostPort}`);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection(forward.socket);
    sockets.add(client);
    const disconnect = (): void => {
      sockets.delete(client);
      client.destroy();
      upstream.destroy();
    };
    client.once("error", disconnect);
    upstream.once("error", disconnect);
    client.once("close", disconnect);
    upstream.once("close", disconnect);
    client.pipe(upstream).pipe(client);
  });
  server.maxConnections = 128;
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await forward.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(localPort, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Could not establish the local loopback listener.");
    return { port: address.port, close };
  } catch (error) {
    await close();
    throw error;
  }
}
