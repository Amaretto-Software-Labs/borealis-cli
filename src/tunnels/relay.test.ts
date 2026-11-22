import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { relayControl } from "./relay.js";
import { parseTarget } from "./target.js";

const fixtures = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("ws", () => ({
  default: class {
    static OPEN = 1;
    constructor(...args: unknown[]) {
      return fixtures.connect(...args);
    }
  },
}));

const attachment = {
  name: "sandbox",
  routeName: "sandbox--example",
  url: "https://sandbox.public.example.test",
  relayUrl: "https://relay.example.test:8443/",
  session: "a563e5bb-e4b1-42b6-bf72-9b99a1bf6872",
  ticket: "only-the-attachment-ticket",
  resumeToken: "cloud-only-resume-secret",
};

afterEach(() => {
  fixtures.connect.mockReset();
});

it("uses the relay's WSS origin and sends only ticket, generation, and loopback authority", async () => {
  const socket = new EventEmitter();
  fixtures.connect.mockReturnValueOnce(socket);
  const online = vi.fn();
  const running = relayControl(
    attachment,
    parseTarget("https://localhost:3000", true),
    undefined,
    new AbortController().signal,
    online,
  );
  expect(fixtures.connect).toHaveBeenCalledOnce();
  const [url, options] = fixtures.connect.mock.calls[0]!;
  expect(String(url)).toBe(
    "wss://relay.example.test:8443/v1/tunnels/sandbox--example/control",
  );
  expect(options).toMatchObject({
    headers: {
      authorization: `Bearer ${attachment.ticket}`,
      "x-tunnel-session": attachment.session,
      "x-tunnel-authority": "localhost:3000",
    },
    followRedirects: false,
    rejectUnauthorized: true,
  });
  expect(JSON.stringify(options)).not.toContain(attachment.resumeToken);
  socket.emit("open");
  socket.emit("close");
  expect(online).toHaveBeenCalledOnce();
  expect(await running).toBe(true);
});

it("surfaces a denied relay upgrade and closes the socket", async () => {
  const socket = Object.assign(new EventEmitter(), {
    terminate: vi.fn(() => socket.emit("close")),
  });
  fixtures.connect.mockReturnValueOnce(socket);
  const online = vi.fn();
  const running = relayControl(
    attachment,
    parseTarget("3000"),
    undefined,
    new AbortController().signal,
    online,
  );
  const rejected = expect(running).rejects.toMatchObject({ status: 410 });
  const destroy = vi.fn();
  socket.emit("unexpected-response", { destroy }, { statusCode: 410 });
  await rejected;
  expect(destroy).toHaveBeenCalledOnce();
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(online).not.toHaveBeenCalled();
});
