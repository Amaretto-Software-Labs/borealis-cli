#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import {
  createProvenance,
  validateProvenance,
  validateCanonicalSource,
} from "./catalog-source.mjs";

const directory = resolve(import.meta.dirname, "../src");
const destination = resolve(directory, "catalog-provenance.json");
const source =
  process.argv.find((value) => value.startsWith("--source="))?.slice(9) ??
  process.env.BOREALIS_SOURCE_ROOT;
if (process.argv.includes("--update")) {
  if (!source)
    throw new Error(
      "Set BOREALIS_SOURCE_ROOT to the canonical Borealis checkout.",
    );
  await writeFile(
    destination,
    JSON.stringify(
      await createProvenance(resolve(source), directory),
      null,
      2,
    ) + "\n",
  );
} else {
  const proof = JSON.parse(await readFile(destination, "utf8"));
  if (process.argv.includes("--revision")) {
    process.stdout.write(
      (await validateProvenance(proof, directory, true)) + "\n",
    );
  } else if (process.argv.includes("--check-source")) {
    if (!source)
      throw new Error(
        "Set BOREALIS_SOURCE_ROOT to the pinned canonical checkout.",
      );
    await validateCanonicalSource(resolve(source), proof, directory);
    process.stdout.write(
      "Verified the clean immutable canonical source revision and content.\n",
    );
  } else {
    await validateProvenance(proof, directory);
    process.stdout.write(
      `Verified catalog content provenance${proof.sourceDirty ? " (dirty source: publication blocked)" : ""}.\n`,
    );
  }
}
