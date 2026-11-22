import { X509Certificate } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import * as tls from "node:tls";

export function parseRouteName(name: string): string {
  if (
    name.trim() !== name ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
  ) {
    throw new Error(
      "Tunnel names must be lowercase DNS labels of 1–63 characters.",
    );
  }
  return name;
}

export function parseName(name: string): string {
  parseRouteName(name);
  if (name === "xn") throw new Error("The tunnel name xn is reserved.");
  if (name.includes("--"))
    throw new Error("Tunnel names cannot contain consecutive hyphens.");
  return name;
}

export function parseTarget(
  value: string,
  ipv6 = false,
  protocol: "http" | "tcp" = "http",
) {
  const bare = /^[0-9]+$/.test(value) && value === value.trim();
  if (protocol === "tcp" && !bare) {
    throw new Error("Use a bare loopback TCP port.");
  }
  if (value.trim() !== value)
    throw new Error("Use a port or a loopback HTTP(S) origin.");
  const origin =
    /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?\/?$/i.exec(
      value,
    );
  if (!bare && !origin)
    throw new Error("Use a port or a loopback HTTP(S) origin.");

  const secure = origin?.[1]?.toLowerCase() === "https";
  const scheme = secure ? "https" : protocol;
  const host = origin?.[2]?.toLowerCase() ?? (ipv6 ? "[::1]" : "127.0.0.1");
  const port = Number(bare ? value : (origin?.[3] ?? (secure ? 443 : 80)));
  if (port < 1 || port > 65535)
    throw new Error("The local port must be between 1 and 65535.");
  if (ipv6 && host === "127.0.0.1")
    throw new Error("--ipv6 conflicts with 127.0.0.1.");

  const address = ipv6 || host === "[::1]" ? "::1" : "127.0.0.1";
  const authority = `${host}:${port}`;
  return {
    protocol,
    secure,
    authority,
    address,
    host: host === "[::1]" ? "::1" : host,
    port,
    url: `${scheme}://${authority}`,
  };
}

export type Target = ReturnType<typeof parseTarget>;

export async function upstreamTrust(target: Target, path?: string) {
  if (!target.secure) {
    if (path) throw new Error("--upstream-ca requires a local HTTPS origin.");
    return undefined;
  }

  const trust =
    typeof tls.getCACertificates === "function"
      ? [
          ...new Set([
            ...tls.getCACertificates("default"),
            ...tls.getCACertificates("system"),
          ]),
        ]
      : path
        ? [...tls.rootCertificates]
        : undefined;
  if (path) {
    const file = await readFile(path, "utf8");
    // Validate the PEM before reserving the address.
    const certificates = file.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    if (!certificates?.length)
      throw new Error("The upstream CA file contains no PEM certificates.");
    trust!.push(
      ...certificates.map((pem) => new X509Certificate(pem).toString()),
    );
  }
  return trust;
}

export function dialTarget(
  target: Target,
  ca: string[] | undefined,
  signal: AbortSignal,
): Promise<Socket> {
  const options = { host: target.address, port: target.port };
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = target.secure
      ? tls.connect({
          ...options,
          ca,
          rejectUnauthorized: true,
          servername: target.host === "localhost" ? target.host : undefined,
          checkServerIdentity: (_, certificate) => {
            const identity = new X509Certificate(certificate.raw);
            const match =
              target.host === "localhost"
                ? identity.checkHost(target.host, { subject: "never" })
                : identity.checkIP(target.host);
            if (!match)
              return new Error(
                `The certificate does not match the subject alternative name for ${target.host}.`,
              );
          },
        })
      : connectTcp({ ...options, allowHalfOpen: target.protocol === "tcp" });
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => socket.destroy(new Error("Local connection timed out.")),
      5000,
    );
    socket.on("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Local connection closed."));
    });
    socket.once(target.secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}
