import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import { expect, it } from "vitest";
import { parseTarget, upstreamTrust } from "./target.js";

const target = parseTarget("https://localhost:8443");

it("lets Node select its default CA store when no upstream CA is supplied", async () => {
  await expect(upstreamTrust(target)).resolves.toBeUndefined();
});

it("adds only the supplied upstream CA to Node's effective defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "borealis-tunnel-ca-"));
  try {
    const file = join(directory, "upstream.pem");
    const ca = new X509Certificate(tls.rootCertificates[0]!).toString();
    await writeFile(file, ca);
    if (typeof tls.getCACertificates !== "function") {
      await expect(upstreamTrust(target, file)).rejects.toThrow("22.15.0");
      return;
    }
    await expect(upstreamTrust(target, file)).resolves.toEqual([
      ...tls.getCACertificates("default"),
      ca,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
