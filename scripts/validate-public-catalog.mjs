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
  operations.length !== 75 ||
  operationIds.size !== 75 ||
  commands.size !== 75 ||
  operations.some(
    ({ operationId, path }) =>
      operationId.startsWith("admin.") || !path.startsWith("/api/v1/"),
  )
) {
  throw new Error(
    "The committed public catalog must contain exactly 75 unique, non-admin v1 operations and commands.",
  );
}
process.stdout.write(
  "Verified 75 committed public operations with no admin surface.\n",
);
