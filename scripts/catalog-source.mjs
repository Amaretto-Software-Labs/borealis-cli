import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export const repository = "Amaretto-Software-Labs/borealis";
export const catalogNames = ["operations.json", "runtime-operations.json"];
const sourceCatalogs = [
  "backend/Borealis.Api.Contracts/V1/BorealisOperationCatalog.cs",
  "backend/Borealis.Api.Contracts/V1/BorealisRuntimeV2OperationCatalog.cs",
  "backend/Borealis.Api.Contracts/V1/BorealisRuntimeTemplateOperationCatalog.cs",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export async function catalogHashes(directory) {
  return Object.fromEntries(
    await Promise.all(
      catalogNames.map(async (name) => [
        name,
        sha256(await readFile(resolve(directory, name))),
      ]),
    ),
  );
}

export async function sourceSnapshot(root) {
  const clientFiles = (await readdir(resolve(root, "backend/Borealis.Client")))
    .filter((name) => name.startsWith("BorealisClient") && name.endsWith(".cs"))
    .map((name) => `backend/Borealis.Client/${name}`);
  if (!clientFiles.length)
    throw new Error("The canonical Borealis SDK source is missing.");
  const paths = [...sourceCatalogs, ...clientFiles].sort();
  const files = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        sha256(await readFile(resolve(root, path))),
      ]),
    ),
  );
  return {
    sourceCommit: git(root, "rev-parse", "HEAD"),
    sourceDirty: git(root, "status", "--porcelain=v1").length > 0,
    sourceContentSha256: sha256(JSON.stringify(files)),
    sourceFiles: files,
  };
}

export async function createProvenance(root, directory) {
  return {
    schemaVersion: 1,
    repository,
    ...(await sourceSnapshot(root)),
    catalogSha256: await catalogHashes(directory),
  };
}

export async function validateProvenance(proof, directory, immutable = false) {
  if (
    proof.schemaVersion !== 1 ||
    proof.repository !== repository ||
    !/^[0-9a-f]{40}$/.test(proof.sourceCommit) ||
    typeof proof.sourceDirty !== "boolean" ||
    !/^[0-9a-f]{64}$/.test(proof.sourceContentSha256) ||
    !proof.sourceFiles ||
    !Object.keys(proof.sourceFiles).length ||
    Object.values(proof.sourceFiles).some(
      (hash) => !/^[0-9a-f]{64}$/.test(hash),
    ) ||
    proof.sourceContentSha256 !== sha256(JSON.stringify(proof.sourceFiles))
  )
    throw new Error(
      "Catalog provenance is invalid; regenerate it from the reviewed canonical Borealis source.",
    );
  if (
    JSON.stringify(proof.catalogSha256) !==
    JSON.stringify(await catalogHashes(directory))
  )
    throw new Error(
      "Committed CLI catalog content differs from its provenance; re-run both importers and regenerate provenance.",
    );
  if (immutable && proof.sourceDirty)
    throw new Error(
      "Catalog provenance records uncommitted Borealis source. Publishing requires a reviewed immutable revision; do not relabel this dirty snapshot as HEAD.",
    );
  return proof.sourceCommit;
}

export async function validateCanonicalSource(root, proof, directory) {
  await validateProvenance(proof, directory, true);
  try {
    git(
      root,
      "merge-base",
      "--is-ancestor",
      proof.sourceCommit,
      "refs/remotes/origin/main",
    );
  } catch {
    throw new Error(
      "The canonical revision must be contained in reviewed origin/main; fetch canonical main before verification.",
    );
  }
  const current = await sourceSnapshot(root);
  if (
    current.sourceDirty ||
    current.sourceCommit !== proof.sourceCommit ||
    current.sourceContentSha256 !== proof.sourceContentSha256 ||
    JSON.stringify(current.sourceFiles) !== JSON.stringify(proof.sourceFiles)
  )
    throw new Error(
      "Canonical checkout must be clean and match the exact recorded revision and source content hashes.",
    );
}
