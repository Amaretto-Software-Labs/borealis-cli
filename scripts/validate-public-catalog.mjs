#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { validateProvenance } from "./catalog-source.mjs";

const operations = JSON.parse(
  await readFile(
    resolve(import.meta.dirname, "../src/operations.json"),
    "utf8",
  ),
);
const operationIds = new Set(operations.map(({ operationId }) => operationId));
const commands = new Set(operations.map(({ command }) => command));
if (
  operations.length !== 85 ||
  operationIds.size !== 85 ||
  commands.size !== 85 ||
  operations.some(
    ({ operationId, path }) =>
      operationId.startsWith("admin.") || !path.startsWith("/api/v1/"),
  )
) {
  throw new Error(
    "The committed public catalog must contain exactly 85 unique, non-admin v1 operations and commands.",
  );
}
process.stdout.write(
  "Verified 85 committed public operations with no admin surface.\n",
);

const runtime = JSON.parse(
  await readFile(
    resolve(import.meta.dirname, "../src/runtime-operations.json"),
    "utf8",
  ),
);
const all = [...operations, ...runtime];
if (
  runtime.length !== 35 ||
  new Set(all.map((item) => item.operationId)).size !== 120 ||
  new Set(all.map((item) => item.command)).size !== 120 ||
  runtime.some(
    (item) =>
      !/^(logical_machine|runtime_template)\./.test(item.operationId) ||
      !item.path.startsWith("/api/v1/") ||
      item.ownership !== "organization",
  )
)
  throw new Error(
    "The committed conditional catalog must contain exactly 35 unique organization-scoped Runtime v2 operations without colliding with public commands.",
  );
await validateProvenance(
  JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "../src/catalog-provenance.json"),
      "utf8",
    ),
  ),
  resolve(import.meta.dirname, "../src"),
);
process.stdout.write(
  "Verified 35 conditional operations and provenance for all 120 commands.\n",
);
