import type { Readable, Writable } from "node:stream";
import WebSocket, { type RawData } from "ws";

const maximumBufferedBytes = 4 * 1024 * 1024;

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer)
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  return data.toString("utf8");
}

export async function bridgeInteractiveStreams(
  socket: WebSocket,
  input: Readable,
  output: Writable,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let sendPending = false;
    let outputPaused = false;
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onInputError);
      output.off("drain", onDrain);
      output.off("error", onOutputError);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onSocketError);
      signal?.removeEventListener("abort", onAbort);
      input.pause();
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const closeForFailure = (error: unknown): void => {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      )
        socket.terminate();
      finish(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.byteLength(chunk);
      if (
        bytes > maximumBufferedBytes ||
        socket.bufferedAmount + bytes > maximumBufferedBytes ||
        sendPending
      ) {
        closeForFailure(
          new Error("Interactive input exceeded the bounded send buffer."),
        );
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      sendPending = true;
      input.pause();
      socket.send(chunk, (error) => {
        sendPending = false;
        if (settled) return;
        if (error) {
          closeForFailure(error);
          return;
        }
        if (socket.readyState === WebSocket.OPEN) input.resume();
      });
    };
    const onMessage = (data: RawData): void => {
      try {
        if (outputPaused) {
          closeForFailure(
            new Error(
              "Interactive output exceeded the bounded receive buffer.",
            ),
          );
          return;
        }
        if (!output.write(messageText(data))) {
          outputPaused = true;
          socket.pause();
        }
      } catch (error) {
        closeForFailure(error);
      }
    };
    const onDrain = (): void => {
      outputPaused = false;
      if (socket.readyState === WebSocket.OPEN) socket.resume();
    };
    const onEnd = (): void => {
      if (socket.readyState === WebSocket.OPEN)
        socket.close(1000, "stdin closed");
    };
    const onInputError = (error: Error): void => closeForFailure(error);
    const onOutputError = (error: Error): void => closeForFailure(error);
    const onSocketError = (): void =>
      finish(new Error("Interactive session connection failed."));
    const onClose = (): void => finish();
    const onAbort = (): void => {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      )
        socket.terminate();
      finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onInputError);
    output.on("drain", onDrain);
    output.once("error", onOutputError);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onSocketError);
    signal?.addEventListener("abort", onAbort, { once: true });
    input.resume();
  });
}

export async function attach(
  url: string,
  token: string,
  organization?: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const websocketUrl = new URL(url);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(websocketUrl, {
    maxPayload: maximumBufferedBytes,
    handshakeTimeout: 30_000,
    ...(signal ? { signal } : {}),
    headers: {
      authorization: `Bearer ${token}`,
      ...(organization ? { "x-organization-id": organization } : {}),
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const fail = (): void => {
        cleanup();
        reject(new Error("Interactive session connection failed."));
      };
      const onError = (): void => fail();
      const onClose = (): void => fail();
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    await bridgeInteractiveStreams(
      socket,
      process.stdin,
      process.stdout,
      signal,
    );
    signal?.throwIfAborted();
  } finally {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "completed");
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }
}
