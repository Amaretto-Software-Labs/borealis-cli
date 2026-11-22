import { setMaxListeners } from "node:events";
import WebSocket, { createWebSocketStream } from "ws";
import { isGuid } from "../guid.js";
import { dialTarget, type Target } from "./target.js";
import { bridgeTcp } from "./tcp.js";

export interface Attachment {
  name: string;
  url: string;
  relayUrl: string;
  session: string;
  ticket: string;
  resumeToken: string;
}

export class RelayConnectionError extends Error {
  constructor(readonly status: number) {
    super(`The tunnel relay rejected the attachment (HTTP ${status}).`);
  }
}

function relaySocket(
  attachment: Attachment,
  path: string,
  authority?: string,
): WebSocket {
  const url = new URL(path, attachment.relayUrl);
  url.protocol = "wss:";
  return new WebSocket(url, {
    headers: {
      authorization: `Bearer ${attachment.ticket}`,
      "x-tunnel-session": attachment.session,
      ...(authority ? { "x-tunnel-authority": authority } : {}),
    },
    followRedirects: false,
    handshakeTimeout: 8000,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    rejectUnauthorized: true,
  });
}

export function relayControl(
  attachment: Attachment,
  target: Target,
  ca: string[] | undefined,
  signal: AbortSignal,
  onOnline: () => void,
): Promise<boolean> {
  const streams = new AbortController();
  setMaxListeners(0, streams.signal);
  const path = `/v1/tunnels/${attachment.name}`;
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const control = relaySocket(
      attachment,
      `${path}/control`,
      target.authority,
    );
    const stop = () => control.terminate();
    signal.addEventListener("abort", stop, { once: true });
    let wasOnline = false;
    let pong = true;
    const heartbeat = setInterval(() => {
      if (control.readyState !== WebSocket.OPEN) return;
      if (!pong) {
        stop();
        return;
      }
      pong = false;
      control.ping();
    }, 9000);
    control.on("pong", () => {
      pong = true;
    });
    control.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code;
      if (
        code &&
        /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|INVALID_CA)/.test(
          code,
        )
      )
        reject(new Error(`The tunnel relay TLS connection failed (${code}).`));
    });
    control.on("unexpected-response", (request, response) => {
      const status = response.statusCode ?? 500;
      if (status < 500 && ![408, 409, 429].includes(status))
        reject(new RelayConnectionError(status));
      request.destroy();
      stop();
    });
    control.once("open", () => {
      wasOnline = true;
      onOnline();
    });
    control.once("close", () => {
      streams.abort();
      clearInterval(heartbeat);
      signal.removeEventListener("abort", stop);
      resolve(wasOnline);
    });
    control.on("message", (data, binary) => {
      if (binary) return;
      let stream: unknown;
      try {
        stream = (JSON.parse(data.toString()) as { stream?: unknown } | null)
          ?.stream;
      } catch {
        return;
      }
      if (isGuid(stream) && stream.length === 36)
        void forward(
          attachment,
          `${path}/streams/${stream}`,
          target,
          ca,
          streams.signal,
        );
    });
  });
}

async function forward(
  attachment: Attachment,
  path: string,
  target: Target,
  ca: string[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  let local: Awaited<ReturnType<typeof dialTarget>>;
  try {
    local = await dialTarget(target, ca, signal);
  } catch (error) {
    if (signal.aborted) return;
    process.stderr.write(
      `Local ${target.url}: ${error instanceof Error ? error.message : "connection failed"}\n`,
    );
    await fetch(new URL(path, attachment.relayUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${attachment.ticket}`,
        "x-tunnel-session": attachment.session,
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
    return;
  }
  if (local.destroyed || signal.aborted) return;

  const socket = relaySocket(attachment, path);
  if (target.protocol === "tcp") {
    bridgeTcp(local, socket, signal);
    return;
  }

  const remote = createWebSocketStream(socket);
  const close = () => {
    local.destroy();
    remote.destroy();
  };
  local.once("error", close);
  remote.once("error", close);
  remote.once("close", close);
  local.once("close", () => {
    if (!local.readableEnded) remote.destroy();
  });
  signal.addEventListener("abort", close, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", close));
  remote.pipe(local);
  local.pipe(remote);
}
