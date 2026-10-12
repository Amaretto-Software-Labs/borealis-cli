#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const operations = JSON.parse(
  await readFile(
    resolve(import.meta.dirname, "../src/operations.json"),
    "utf8",
  ),
);
const operationIds = new Set(operations.map(({ operationId }) => operationId));
const commands = new Set(operations.map(({ command }) => command));
if (
  operations.length !== 86 ||
  operationIds.size !== 86 ||
  commands.size !== 86 ||
  operations.some(
    ({ operationId, path }) =>
      operationId.startsWith("admin.") || !path.startsWith("/api/v1/"),
  )
) {
  throw new Error(
    "The committed public catalog must contain exactly 86 unique, non-admin v1 operations and commands.",
  );
}
process.stdout.write(
  "Verified 86 committed public operations with no admin surface.\n",
);

const runtime = JSON.parse(
  await readFile(
    resolve(import.meta.dirname, "../src/runtime-operations.json"),
    "utf8",
  ),
);
const all = [...operations, ...runtime];
if (
  runtime.length !== 60 ||
  new Set(all.map((item) => item.operationId)).size !== 146 ||
  new Set(all.map((item) => item.command)).size !== 146 ||
  runtime.some(
    (item) =>
      !/^(logical_machine|runtime_template|vnet|vnet_attachment|network_service|vm_network_configuration|private_network|managed_service|background_lease)\./.test(
        item.operationId,
      ) ||
      !item.path.startsWith("/api/v1/") ||
      item.ownership !== "organization",
  )
)
  throw new Error(
    "The committed conditional catalog must contain exactly 60 unique organization-scoped Runtime v2 operations without colliding with public commands.",
  );
process.stdout.write(
  "Verified 60 conditional operations and 146 unique public commands.\n",
);
