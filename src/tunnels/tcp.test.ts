import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { bridgeTcp } from "./tcp.js";

it.each(["visitor", "local"])(
  "preserves binary bytes when %s half-closes first",
  async (first) => {
    const listener = createServer({ allowHalfOpen: true });
    const websocket = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const request = Buffer.alloc(250_000, 0xad);
    const response = Buffer.alloc(250_001, 0x7f);
    const control = new AbortController();
    let local: Socket | undefined;
    let upstream: Socket | undefined;
    try {
      listener.listen(0, "127.0.0.1");
      await Promise.all([
        once(listener, "listening"),
        once(websocket, "listening"),
      ]);

      const upstreamConnection = once(listener, "connection") as Promise<
        [Socket]
      >;
      local = connect({
        host: "127.0.0.1",
        port: (listener.address() as AddressInfo).port,
        allowHalfOpen: true,
      });
      [upstream] = await upstreamConnection;
      const frameData: Buffer[] = [];
      upstream.on("data", (chunk: Buffer) => frameData.push(chunk));
      const upstreamFin = once(upstream, "end");

      const connected = once(websocket, "connection") as Promise<[WebSocket]>;
      const publisher = new WebSocket(
        `ws://127.0.0.1:${(websocket.address() as AddressInfo).port}`,
      );
      bridgeTcp(local, publisher, control.signal);
      const [visitor] = await connected;
      const relayData: Buffer[] = [];
      const relayFin = new Promise<string>((resolve) => {
        visitor.on("message", (chunk: Buffer, binary) => {
          if (binary) relayData.push(chunk);
          else resolve(chunk.toString("utf8"));
        });
      });

      if (first === "local") {
        upstream.end(response);
        expect(await relayFin).toBe("fin");
      }
      for (let offset = 0; offset < request.length; offset += 64 * 1024)
        visitor.send(request.subarray(offset, offset + 64 * 1024));
      visitor.send("fin");
      await upstreamFin;

      if (first === "visitor") upstream.end(response);
      expect(await relayFin).toBe("fin");
      expect(relayData.every((chunk) => chunk.length <= 64 * 1024)).toBe(true);
      expect(Buffer.concat(relayData)).toEqual(response);
      expect(Buffer.concat(frameData)).toEqual(request);
      visitor.close(1000);
      await once(publisher, "close");
    } finally {
      control.abort();
      local?.destroy();
      upstream?.destroy();
      for (const socket of websocket.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => websocket.close(() => resolve())),
        new Promise<void>((resolve) => listener.close(() => resolve())),
      ]);
    }
  },
);
