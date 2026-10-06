import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProvenance,
  validateProvenance,
  validateCanonicalSource,
} from "../scripts/catalog-source.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "borealis-catalog-proof-"));
  roots.push(root);
  const catalogs = join(root, "cli");
  await mkdir(catalogs);
  await mkdir(join(root, "backend/Borealis.Api.Contracts/V1"), {
    recursive: true,
  });
  await mkdir(join(root, "backend/Borealis.Client"), { recursive: true });
  for (const name of [
    "BorealisOperationCatalog.cs",
    "BorealisRuntimeV2OperationCatalog.cs",
    "BorealisRuntimeTemplateOperationCatalog.cs",
  ])
    await writeFile(
      join(root, "backend/Borealis.Api.Contracts/V1", name),
      name,
    );
  await writeFile(
    join(root, "backend/Borealis.Client/BorealisClient.cs"),
    "canonical SDK methods",
  );
  await writeFile(join(catalogs, "operations.json"), "[1]\n");
  await writeFile(join(catalogs, "runtime-operations.json"), "[2]\n");
  git(root, "init", "--quiet");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Catalog Fixture",
    "-c",
    "user.email=catalog@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  git(
    root,
    "update-ref",
    "refs/remotes/origin/main",
    git(root, "rev-parse", "HEAD"),
  );
  return { root, catalogs };
}

describe("catalog release provenance", () => {
  it("isolates a release-like canonical checkout from lint and formatter traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "borealis-canonical-layout-"));
    roots.push(root);
    await mkdir(join(root, "canonical-borealis"));
    await writeFile(
      join(root, "canonical-borealis/bad.js"),
      "const = ; this is deliberately invalid\n",
    );
    for (const name of ["eslint.config.js", ".prettierignore"])
      await writeFile(
        join(root, name),
        await readFile(new URL(`../${name}`, import.meta.url), "utf8"),
      );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }, null, 2) + "\n",
    );
    await symlink(
      new URL("../node_modules", import.meta.url).pathname,
      join(root, "node_modules"),
      "dir",
    );
    execFileSync(
      process.execPath,
      [
        new URL("../node_modules/eslint/bin/eslint.js", import.meta.url)
          .pathname,
        ".",
      ],
      { cwd: root, stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [
        new URL("../node_modules/prettier/bin/prettier.cjs", import.meta.url)
          .pathname,
        "--check",
        ".",
      ],
      { cwd: root, stdio: "pipe" },
    );
  });

  it("validates clean exact source content and canonical main ancestry", async () => {
    const { root, catalogs } = await fixture();
    const proof = await createProvenance(root, catalogs);
    expect(proof.sourceDirty).toBe(false);
    expect(proof.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    await expect(
      validateCanonicalSource(root, proof, catalogs),
    ).resolves.toBeUndefined();
  });
  it("records dirty source honestly and blocks publication even when hashes match", async () => {
    const { root, catalogs } = await fixture();
    await writeFile(
      join(root, "backend/Borealis.Client/BorealisClient.cs"),
      "uncommitted methods",
    );
    const proof = await createProvenance(root, catalogs);
    expect(proof.sourceDirty).toBe(true);
    await expect(validateProvenance(proof, catalogs)).resolves.toBe(
      proof.sourceCommit,
    );
    await expect(validateProvenance(proof, catalogs, true)).rejects.toThrow(
      "uncommitted",
    );
  });
  it("does not allow relabelling a dirty snapshot as a clean canonical revision", async () => {
    const { root, catalogs } = await fixture();
    await writeFile(
      join(root, "backend/Borealis.Client/BorealisClient.cs"),
      "changed methods",
    );
    const proof = {
      ...(await createProvenance(root, catalogs)),
      sourceDirty: false,
    };
    await expect(
      validateCanonicalSource(root, proof, catalogs),
    ).rejects.toThrow("clean and match");
  });
  it("detects modified conditional catalog content", async () => {
    const { root, catalogs } = await fixture();
    const proof = await createProvenance(root, catalogs);
    await writeFile(join(catalogs, "runtime-operations.json"), "[3]\n");
    await expect(validateProvenance(proof, catalogs)).rejects.toThrow(
      "catalog content differs",
    );
  });
  it("detects changed canonical revision and excludes unreviewed branch commits", async () => {
    const { root, catalogs } = await fixture();
    const proof = await createProvenance(root, catalogs);
    await writeFile(
      join(root, "backend/Borealis.Client/BorealisClient.cs"),
      "different methods",
    );
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=Catalog Fixture",
      "-c",
      "user.email=catalog@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "unreviewed",
    );
    const unreviewed = await createProvenance(root, catalogs);
    await expect(
      validateCanonicalSource(root, unreviewed, catalogs),
    ).rejects.toThrow("reviewed origin/main");
    await expect(
      validateCanonicalSource(root, proof, catalogs),
    ).rejects.toThrow("exact recorded revision");
  });
  it("rejects altered source-file hashes and injected source revisions", async () => {
    const { root, catalogs } = await fixture();
    const proof = await createProvenance(root, catalogs);
    await expect(
      validateProvenance(
        { ...proof, sourceCommit: "main; echo unsafe" },
        catalogs,
      ),
    ).rejects.toThrow("invalid");
    await expect(
      validateProvenance(
        { ...proof, sourceContentSha256: "0".repeat(64) },
        catalogs,
      ),
    ).rejects.toThrow("invalid");
  });
  it("checks all runtime operations and both provenance gates in CI and release workflows", async () => {
    for (const name of ["ci.yml", "release.yml"]) {
      const text = await readFile(
        new URL(`../.github/workflows/${name}`, import.meta.url),
        "utf8",
      );
      expect(text).toContain("catalog-provenance.mjs --revision");
      expect(text).toContain("repository: Amaretto-Software-Labs/borealis");
      expect(text).toContain("ref: ${{ steps.canonical.outputs.revision }}");
      expect(text).toContain("persist-credentials: false");
      expect(text).toContain("pnpm parity:canonical");
    }
  });
});
