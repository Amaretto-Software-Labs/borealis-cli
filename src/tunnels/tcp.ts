import type { Socket } from "node:net";
import type WebSocket from "ws";

const maxChunk = 64 * 1024;
const fin = Buffer.from("fin");

export function bridgeTcp(
  local: Socket,
  socket: WebSocket,
  signal: AbortSignal,
) {
  let inboundFin = false;
  let outboundFin = false;
  let localEnded = false;
  let sending = false;

  const abort = () => {
    local.destroy();
    socket.terminate();
  };
  signal.addEventListener("abort", abort, { once: true });
  local.once("error", abort);
  local.once("close", () => {
    if (!inboundFin || !outboundFin) socket.terminate();
  });
  socket.once("error", abort);
  socket.once("close", (code) => {
    signal.removeEventListener("abort", abort);
    // A normal close after both FINs leaves any final local writes to drain.
    if (code !== 1000 || !inboundFin || !outboundFin) local.destroy();
  });

  socket.on("message", (message, binary) => {
    if (inboundFin || !Buffer.isBuffer(message)) {
      abort();
    } else if (binary && message.length <= maxChunk) {
      if (!local.write(message)) socket.pause();
    } else if (!binary && message.equals(fin)) {
      inboundFin = true;
      local.end();
    } else {
      abort();
    }
  });
  local.on("drain", () => socket.resume());

  socket.once("open", () => {
    local.on("data", (data: Buffer) => {
      local.pause();
      sending = true;
      sendChunk(data, 0);
    });
    local.once("end", () => {
      localEnded = true;
      finish();
    });
  });

  function finish() {
    if (!localEnded || sending || outboundFin) return;
    outboundFin = true;
    socket.send("fin", (error) => {
      if (error) abort();
    });
  }

  function sendChunk(data: Buffer, offset: number) {
    if (offset >= data.length) {
      sending = false;
      finish();
      local.resume();
      return;
    }
    const next = Math.min(offset + maxChunk, data.length);
    socket.send(data.subarray(offset, next), { binary: true }, (error) => {
      if (error) abort();
      else sendChunk(data, next);
    });
  }
}
