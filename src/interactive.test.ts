import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bridgeInteractiveStreams } from "./interactive.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sendCallbacks: Array<(error?: Error) => void> = [];
  readonly sent: Array<Buffer | string> = [];
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });
  readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSING;
  });

  send(data: Buffer | string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    this.sendCallbacks.push(callback);
  }

  finishSend(error?: Error): void {
    this.sendCallbacks.shift()?.(error);
  }

  finishClose(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }
}

describe("interactive stream bridge", () => {
  it("applies input and output backpressure", async () => {
    const socket = new FakeSocket();
    const input = new PassThrough();
    let releaseOutput: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        releaseOutput = callback;
      },
    });
    const bridge = bridgeInteractiveStreams(
      socket as unknown as WebSocket,
      input,
      output,
    );

    input.write("command");
    expect(socket.sent).toEqual([Buffer.from("command")]);
    expect(input.isPaused()).toBe(true);
    socket.finishSend();
    await nextTurn();
    expect(input.isPaused()).toBe(false);

    socket.emit("message", Buffer.from("response"), false);
    expect(socket.pause).toHaveBeenCalledOnce();
    releaseOutput?.();
    await nextTurn();
    expect(socket.resume).toHaveBeenCalledOnce();

    socket.finishClose();
    await expect(bridge).resolves.toBeUndefined();
  });

  it("rejects oversized input instead of buffering it", async () => {
    const socket = new FakeSocket();
    const input = new PassThrough();
    const output = new PassThrough();
    const bridge = bridgeInteractiveStreams(
      socket as unknown as WebSocket,
      input,
      output,
    );

    input.write(Buffer.alloc(4 * 1024 * 1024 + 1));

    await expect(bridge).rejects.toThrow("bounded send buffer");
    expect(socket.sent).toHaveLength(0);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("terminates if output arrives while the destination remains backpressured", async () => {
    const socket = new FakeSocket();
    const input = new PassThrough();
    const output = new Writable({
      highWaterMark: 1,
      write() {
        // Keep the destination backpressured for the duration of the test.
      },
    });
    const bridge = bridgeInteractiveStreams(
      socket as unknown as WebSocket,
      input,
      output,
    );

    socket.emit("message", Buffer.from("first"), false);
    socket.emit("message", Buffer.from("second"), false);

    await expect(bridge).rejects.toThrow("bounded receive buffer");
    expect(socket.pause).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("cancels without leaking stream, socket, or signal listeners", async () => {
    const socket = new FakeSocket();
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const bridge = bridgeInteractiveStreams(
      socket as unknown as WebSocket,
      input,
      output,
      controller.signal,
    );

    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(bridge).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.terminate).toHaveBeenCalledOnce();
    for (const event of ["data", "end", "error"])
      expect(input.listenerCount(event)).toBe(0);
    for (const event of ["drain", "error"])
      expect(output.listenerCount(event)).toBe(0);
    for (const event of ["message", "close", "error"])
      expect(socket.listenerCount(event)).toBe(0);
  });
});
