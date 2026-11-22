import { IdentityTokenError } from "../auth.js";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ApiError, type BorealisApiClient } from "../api-client.js";
import { isGuid, sameGuid } from "../guid.js";
import { optionValue } from "../invocation.js";
import { writeResult } from "../output.js";
import { relayControl, type Attachment } from "./relay.js";
import {
  parseName,
  parseRouteName,
  parseTarget,
  upstreamTrust,
  type Target,
} from "./target.js";

const token = z
  .string()
  .regex(/^[\x21-\x7e]+$/)
  .refine((value) => value === value.trim());
const attachmentSchema = z.object({
  name: z.string(),
  routeName: z.string(),
  url: z.string(),
  relayUrl: z.string(),
  session: z.string().refine((value) => isGuid(value) && value.length === 36),
  ticket: token,
  resumeToken: token,
});
const listSchema = z.array(
  z.object({
    name: z.string(),
    protocol: z.enum(["http", "tcp"]),
    url: z.string(),
    online: z.boolean().nullable(),
  }),
);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function publicUrl(value: string, protocol: Target["protocol"]): boolean {
  const url = parseUrl(value);
  return Boolean(
    url?.hostname &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.pathname === "/" || url.pathname === "") &&
    !/[\p{Cc}\s]/u.test(value) &&
    (protocol === "http"
      ? url.protocol === "https:"
      : url.protocol === "tcp:" && Number(url.port) > 0),
  );
}

function parseAttachment(
  value: unknown,
  protocol: Target["protocol"],
  name?: string,
): Attachment {
  const parsed = attachmentSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("The API returned an invalid tunnel attachment.");
  const attachment = parsed.data;
  const returnedName = parseName(attachment.name);
  parseRouteName(attachment.routeName);
  if (name && returnedName !== name)
    throw new Error("The API returned an attachment for a different tunnel.");
  const suffix = name ? attachment.routeName.slice(name.length + 2) : "";
  if (
    name
      ? !attachment.routeName.startsWith(`${name}--`) ||
        suffix.length > 36 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(suffix) ||
        suffix.includes("--")
      : attachment.routeName !== returnedName
  )
    throw new Error("The API returned an invalid tunnel route name.");
  if (
    !publicUrl(attachment.url, protocol) ||
    (protocol === "http" &&
      parseUrl(attachment.url)?.hostname.split(".")[0] !==
        attachment.routeName) ||
    !/^https:\/\/[^/@?#\\\p{Cc}\s]+\/?$/u.test(attachment.relayUrl) ||
    parseUrl(attachment.relayUrl)?.protocol !== "https:"
  )
    throw new Error("The API returned an invalid tunnel address.");
  return attachment;
}

type Client = (
  anonymous: boolean,
  signal?: AbortSignal,
) => Promise<BorealisApiClient>;

export async function runTunnelCommand(
  command: readonly string[],
  client: Client,
  options: { json: boolean; yes: boolean },
  confirm: (action: string) => Promise<boolean>,
  signal = new AbortController().signal,
): Promise<number> {
  const [, action, ...args] = command;
  if (action === "http" || action === "tcp") {
    const raw = args.find(
      (word, index) =>
        !word.startsWith("-") &&
        !["--name", "--upstream-ca"].includes(args[index - 1] ?? ""),
    );
    if (!raw) throw new Error("A loopback service target is required.");
    const requestedName = optionValue(args, "--name");
    if (action === "tcp" && !requestedName)
      throw new Error("TCP tunnels require --name.");
    const name = requestedName ? parseName(requestedName) : undefined;
    const target = parseTarget(raw, args.includes("--ipv6"), action);
    const ca = await upstreamTrust(target, optionValue(args, "--upstream-ca"));
    await publish(client, name, target, ca, options.json, signal);
  } else if (action === "list") {
    const api = await client(false, signal);
    const parsed = listSchema.safeParse(await api.tunnelRequest("GET", ""));
    if (
      !parsed.success ||
      parsed.data.some(({ url, protocol }) => !publicUrl(url, protocol))
    )
      throw new Error("The API returned an invalid tunnel list.");
    if (options.json) writeResult(parsed.data, true);
    else if (!parsed.data.length)
      process.stdout.write("No reserved addresses.\n");
    else
      for (const { name, protocol, url, online } of parsed.data)
        process.stdout.write(
          `${parseName(name)}\t${protocol.toUpperCase()}\t${online === null ? "disconnecting" : online ? "online" : "offline"}\t${url}\n`,
        );
  } else if (action === "disconnect" || action === "release") {
    const name = parseName(args[0] ?? "");
    if (
      action === "release" &&
      !options.yes &&
      !(await confirm(`tunnel release ${name}`))
    )
      throw new Error(
        "Tunnel release cancelled. Pass --yes for non-interactive use.",
      );
    const api = await client(false, signal);
    if (action === "release") {
      await api.releaseTunnel(name);
      if (options.json) writeResult({ name, success: true }, true);
      else process.stdout.write(`Released ${name}.\n`);
    } else {
      const result = await api.tunnelRequest("POST", `/${name}/disconnect`);
      const disconnecting = Boolean(
        result &&
        typeof result === "object" &&
        "accepted" in result &&
        result.accepted === true,
      );
      if (options.json)
        writeResult({ name, success: true, disconnecting }, true);
      else
        process.stdout.write(
          disconnecting
            ? `Disconnect requested for ${name}.\n`
            : `Disconnected ${name}.\n`,
        );
    }
  } else {
    throw new Error(
      "Use 'borealis tunnel --help' to see the available commands.",
    );
  }
  return 0;
}

async function publish(
  client: Client,
  name: string | undefined,
  target: Target,
  ca: string[] | undefined,
  json: boolean,
  signal: AbortSignal,
): Promise<void> {
  const guest = name === undefined;
  const path = name ? `/${name}/attachments` : "/attachments";
  const parameters = guest ? {} : { protocol: target.protocol };
  const request = async (previous?: Attachment) => {
    const api = await client(guest, signal);
    try {
      return parseAttachment(
        await api.tunnelRequest("POST", path, {
          ...parameters,
          ...(previous
            ? { session: previous.session, resumeToken: previous.resumeToken }
            : {}),
        }),
        target.protocol,
        name,
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("The API returned invalid tunnel attachment JSON.");
      throw error;
    }
  };

  let current = await request();
  let announced = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const wasOnline = await relayControl(current, target, ca, signal, () => {
        if (announced) return;
        announced = true;
        if (json)
          writeResult(
            {
              name: current.name,
              protocol: target.protocol,
              url: current.url,
              local: target.url,
              guest,
            },
            true,
          );
        else
          process.stdout.write(
            `Public   ${current.url}\nLocal    ${target.url}\nOnline   Ctrl+C to disconnect.\n`,
          );
      });
      signal.throwIfAborted();
      if (wasOnline) {
        attempt = 0;
        process.stderr.write("Tunnel relay connection lost. Reconnecting…\n");
      }
      const next = await resumeWithBackoff(request, current, attempt, signal);
      current = next;
    }
  } finally {
    const cleanup = AbortSignal.timeout(2000);
    try {
      const api = await client(guest, cleanup);
      await api.tunnelRequest(
        "POST",
        `/${current.name}/attachments/${current.session}/end`,
        { resumeToken: current.resumeToken },
        2000,
      );
    } catch {
      // The relay can clean up an unreachable attachment when its lease expires.
    }
  }
}

async function resumeWithBackoff(
  request: (previous: Attachment) => Promise<Attachment>,
  previous: Attachment,
  attempt: number,
  signal: AbortSignal,
): Promise<Attachment> {
  for (; ; attempt++) {
    await delay(
      250 * 2 ** Math.min(attempt, 4) * (0.5 + Math.random() * 0.5),
      undefined,
      { signal },
    );
    let next: Attachment;
    try {
      next = await request(previous);
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof ApiError &&
        ([408, 409, 429].includes(error.status) || error.status >= 500)
      )
        continue;
      if (
        error instanceof IdentityTokenError &&
        ([408, 429].includes(error.status) || error.status >= 500)
      )
        continue;
      if (
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError")
      )
        continue;
      throw error;
    }
    if (
      next.name !== previous.name ||
      next.routeName !== previous.routeName ||
      next.url !== previous.url ||
      next.relayUrl !== previous.relayUrl ||
      sameGuid(next.session, previous.session) ||
      next.resumeToken !== previous.resumeToken
    )
      throw new Error("The API returned an unexpected tunnel resume result.");
    return next;
  }
}
