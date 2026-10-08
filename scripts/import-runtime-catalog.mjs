#!/usr/bin/env node
import process from "node:process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot =
  process.argv.find((value) => value.startsWith("--source="))?.slice(9) ??
  process.env.BOREALIS_SOURCE_ROOT;
if (!sourceRoot)
  throw new Error("Set BOREALIS_SOURCE_ROOT or --source=/path/to/borealis.");
const operations = [];
for (const [file, root] of [
  [
    "BorealisRuntimeV2OperationCatalog.cs",
    "/api/v1/sandboxes/{sandboxId}/runtime",
  ],
  ["BorealisRuntimeTemplateOperationCatalog.cs", "/api/v1/runtime-templates"],
]) {
  const text = await readFile(
    resolve(sourceRoot, "backend/Borealis.Api.Contracts/V1", file),
    "utf8",
  );
  for (const match of text.matchAll(
    /(Read|Write)\("([^"]+)", "([^"]*)", "([^"]+)"(?:, "([^"]+)")?\)/g,
  )) {
    const [, mode, operationId, path, clientMethod, scope] = match;
    operations.push({
      operationId,
      method: mode === "Read" ? "GET" : "POST",
      path: root + path,
      scope:
        (file.startsWith("BorealisRuntimeTemplate")
          ? "borealis.templates."
          : "borealis.sandboxes.") +
        (mode === "Read" ? "read" : (scope ?? "write")),
      risk: mode === "Read" ? "read" : "write",
      clientMethod,
    });
  }
  for (const match of text.matchAll(
    /new\("([^"]+)", (?:null|"sandbox.delete"), "([A-Z]+)", ("[^"]+"|Root(?: \+ "[^"]+")?),\s*"([^"]+)",\s*"organization",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g,
  )) {
    const [, operationId, method, route, scope, idempotency, , clientMethod] =
      match;
    const path = route.startsWith("Root")
      ? root + route.replace(/^Root(?: \+ )?/, "").replaceAll('"', "")
      : route.replaceAll('"', "");
    operations.push({
      operationId,
      method,
      path,
      scope,
      risk:
        operationId === "logical_machine.checkpoint.unpin"
          ? "write"
          : method === "DELETE"
            ? "destructive"
            : method === "GET"
              ? "read"
              : "write",
      clientMethod,
      idempotency,
    });
  }
}
for (const operation of operations)
  Object.assign(operation, {
    command: operation.operationId
      .replace("logical_machine", "logical-machine")
      .replace("runtime_template", "runtime-template")
      .replaceAll(".", " "),
    mcpName: operation.operationId.replaceAll(".", "_"),
    ownership: "organization",
    idempotency:
      operation.method === "GET"
        ? "safe"
        : operation.idempotency === "target-state"
          ? "target-state"
          : operation.idempotency === "lease-renewal"
            ? "none"
            : "idempotency-key",
    retry: operation.method === "GET" ? "safe" : "never-after-dispatch",
    paging: "none",
    requiresPreflight: operation.risk === "destructive",
  });
operations.sort((left, right) =>
  left.operationId.localeCompare(right.operationId, "en"),
);
if (
  operations.length !== 34 ||
  new Set(operations.map((operation) => operation.operationId)).size !== 34
)
  throw new Error(
    "Expected 34 conditional non-stream Runtime v2 operations; review catalog changes before import.",
  );
const sdkDirectory = resolve(sourceRoot, "backend/Borealis.Client");
const sdkSource = (
  await Promise.all(
    (await readdir(sdkDirectory))
      .filter(
        (file) => file.startsWith("BorealisClient") && file.endsWith(".cs"),
      )
      .map((file) => readFile(resolve(sdkDirectory, file), "utf8")),
  )
).join("\n");
for (const operation of operations)
  if (!sdkSource.includes(`${operation.clientMethod}(`))
    throw new Error(
      `Borealis.Client does not implement conditional operation ${operation.clientMethod}.`,
    );
const destination = resolve(
  import.meta.dirname,
  "../src/runtime-operations.json",
);
if (process.argv.includes("--check")) {
  const committed = JSON.parse(await readFile(destination, "utf8"));
  if (JSON.stringify(committed) !== JSON.stringify(operations))
    throw new Error(
      "Runtime v2 catalog drift; run pnpm parity:runtime:update.",
    );
  process.stdout.write(
    "Verified 34 conditional Runtime v2 catalog operations.\n",
  );
} else await writeFile(destination, JSON.stringify(operations, null, 2) + "\n");
