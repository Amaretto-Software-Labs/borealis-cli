import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { run } from "../app.js";
import { ProfileStore } from "../profiles.js";
import type { Attachment } from "./relay.js";
import { parseTarget } from "./target.js";

const relayControl = vi.hoisted(() => vi.fn());
vi.mock("./relay.js", () => ({ relayControl }));

const api = "https://api.example.test";
const first: Attachment = {
  name: "sandbox",
  url: "https://sandbox.tunnel.example.test",
  relayUrl: "https://relay.example.test",
  session: "a563e5bb-e4b1-42b6-bf72-9b99a1bf6872",
  ticket: "ticket-initial-test-secret",
  resumeToken: "resume-test-secret",
};
const next: Attachment = {
  ...first,
  session: "9234943a-3ca4-46da-89e5-869815220b4f",
  ticket: "ticket-next-test-secret",
};

function capture() {
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const fetcher = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>();
  vi.stubGlobal("fetch", fetcher);
  return { stdout, stderr, fetcher };
}

beforeEach(() => {
  relayControl.mockReset();
  vi.spyOn(ProfileStore.prototype, "selected").mockResolvedValue(undefined);
  vi.stubEnv("BOREALIS_ACCESS_TOKEN", "test-borealis-access-token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("resumes a named attachment with its prior generation and ends the replacement on Ctrl+C", async () => {
  const { stdout, stderr, fetcher } = capture();
  const controller = new AbortController();
  fetcher
    .mockResolvedValueOnce(Response.json(first))
    .mockResolvedValueOnce(Response.json(next))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  relayControl
    .mockImplementationOnce(
      async (_attachment, _target, _ca, _signal, online: () => void) => {
        online();
        return true;
      },
    )
    .mockImplementationOnce(async () => {
      controller.abort();
      return true;
    });

  expect(
    await run(
      [
        "--api",
        api,
        "--organization",
        "org-guid",
        "--json",
        "tunnel",
        "http",
        "3000",
        "--name",
        first.name,
      ],
      controller.signal,
    ),
  ).toBe(130);
  expect(
    fetcher.mock.calls.map(([url, init]) => [
      url.pathname,
      JSON.parse(String(init.body)),
    ]),
  ).toEqual([
    ["/api/v1/tunnels/sandbox/attachments", { protocol: "http" }],
    [
      "/api/v1/tunnels/sandbox/attachments",
      {
        protocol: "http",
        session: first.session,
        resumeToken: first.resumeToken,
      },
    ],
    [
      `/api/v1/tunnels/sandbox/attachments/${next.session}/end`,
      { resumeToken: next.resumeToken },
    ],
  ]);
  for (const [, init] of fetcher.mock.calls) {
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(
      "Bearer test-borealis-access-token",
    );
    expect(headers.get("x-organization-id")).toBe("org-guid");
    expect(init.redirect).toBe("error");
  }
  expect(
    relayControl.mock.calls.map(([attachment]) => attachment.ticket),
  ).toEqual([first.ticket, next.ticket]);
  expect(stdout).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      name: first.name,
      protocol: "http",
      url: first.url,
      local: "http://127.0.0.1:3000",
      guest: false,
    }) + "\n",
  );
  const logs = [...stdout.mock.calls, ...stderr.mock.calls].flat().join("");
  for (const secret of [
    first.ticket,
    next.ticket,
    first.resumeToken,
    "test-borealis-access-token",
  ])
    expect(logs).not.toContain(secret);
});

it("never sends Cloud credentials or organization headers for anonymous publication", async () => {
  const { fetcher } = capture();
  const controller = new AbortController();
  fetcher
    .mockResolvedValueOnce(Response.json(first))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  relayControl.mockImplementationOnce(async () => {
    controller.abort();
    return false;
  });
  expect(
    await run(
      ["--api", api, "--organization", "private-org", "tunnel", "http", "8080"],
      controller.signal,
    ),
  ).toBe(130);
  expect(fetcher.mock.calls[0]?.[0].pathname).toBe(
    "/api/v1/tunnels/guest/attachments",
  );
  expect(fetcher.mock.calls[0]?.[1].body).toBe("{}");
  for (const [, init] of fetcher.mock.calls) {
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-organization-id")).toBe(false);
  }
});

it("does not retry the initial claim after an ambiguous response loss", async () => {
  const { fetcher } = capture();
  fetcher.mockRejectedValueOnce(new TypeError("fetch failed"));
  expect(await run(["--api", api, "tunnel", "http", "3000"])).toBe(1);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(relayControl).not.toHaveBeenCalled();
});

it("stops reconnecting when the API revokes the attachment", async () => {
  const { fetcher } = capture();
  fetcher
    .mockResolvedValueOnce(Response.json(first))
    .mockResolvedValueOnce(
      Response.json({ title: "Tunnel attachment ended." }, { status: 410 }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  relayControl.mockResolvedValueOnce(true);
  expect(
    await run(["--api", api, "tunnel", "http", "3000", "--name", first.name]),
  ).toBe(3);
  expect(relayControl).toHaveBeenCalledOnce();
  expect(
    fetcher.mock.calls.filter(([url]) => url.pathname.endsWith("/attachments")),
  ).toHaveLength(2);
});

it.each([
  { name: "other-name" },
  { relayUrl: "http://relay.example.test" },
  { relayUrl: "https://relay.example.test/token" },
  { url: "tcp://sandbox.tunnel.example.test:30123" },
])("rejects mismatched or unsafe attachment fields %j", async (changes) => {
  const { fetcher } = capture();
  fetcher.mockResolvedValueOnce(Response.json({ ...first, ...changes }));
  expect(
    await run(["--api", api, "tunnel", "http", "3000", "--name", first.name]),
  ).toBe(1);
  expect(relayControl).not.toHaveBeenCalled();
});

it("uses the destructive preflight issued for the exact reservation", async () => {
  const { fetcher } = capture();
  fetcher
    .mockResolvedValueOnce(
      Response.json({ preflightToken: "preflight-secret" }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(
    await run(["--api", api, "--yes", "tunnel", "release", first.name]),
  ).toBe(0);
  expect(
    fetcher.mock.calls.map(([url, init]) => [url.pathname, init.method]),
  ).toEqual([
    ["/api/v1/preflights", "POST"],
    ["/api/v1/tunnels/sandbox", "DELETE"],
  ]);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
    operationId: "tunnel.release",
    target: { name: first.name },
  });
  expect(
    new Headers(fetcher.mock.calls[1]?.[1].headers).get("x-borealis-preflight"),
  ).toBe("preflight-secret");
});

it("does not use a selected standalone profile to connect to Cloud", async () => {
  const { fetcher } = capture();
  vi.mocked(ProfileStore.prototype.selected).mockResolvedValue("direct");
  vi.spyOn(ProfileStore.prototype, "find").mockResolvedValue({
    type: "ssh",
    alias: "local",
    socket: "/run/fixture.sock",
  });
  expect(await run(["tunnel", "list"])).toBe(3);
  expect(fetcher).not.toHaveBeenCalled();
});

it("pins upstream targets and rejects origins for TCP", () => {
  expect(parseTarget("https://localhost:8443", true)).toMatchObject({
    secure: true,
    address: "::1",
    authority: "localhost:8443",
  });
  expect(parseTarget("2222", false, "tcp").url).toBe("tcp://127.0.0.1:2222");
  expect(() => parseTarget("tcp://127.0.0.1:2222", false, "tcp")).toThrow(
    "bare loopback",
  );
  expect(() => parseTarget("http://non-loopback.test:8080")).toThrow(
    "loopback",
  );
});

it("reports an accepted disconnect as pending until the relay lease ends", async () => {
  const { fetcher, stdout } = capture();
  fetcher
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(
      Response.json([
        { name: first.name, protocol: "http", url: first.url, online: null },
      ]),
    );
  expect(await run(["--api", api, "tunnel", "disconnect", first.name])).toBe(0);
  expect(await run(["--api", api, "tunnel", "list"])).toBe(0);
  expect(stdout).toHaveBeenCalledWith(
    `Disconnect requested for ${first.name}.\n`,
  );
  expect(stdout).toHaveBeenCalledWith(
    expect.stringContaining("\tdisconnecting\t"),
  );
});

it("rejects a TCP tunnel without a name before issuing a guest attachment", async () => {
  const { fetcher } = capture();
  expect(await run(["--api", api, "tunnel", "tcp", "3000"])).not.toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
