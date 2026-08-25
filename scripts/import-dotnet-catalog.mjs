#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const sourceArgument =
  process.argv.find((value) => value.startsWith("--source="))?.slice(9) ??
  process.env.BOREALIS_SOURCE_ROOT;
if (!sourceArgument) {
  throw new Error(
    "Set BOREALIS_SOURCE_ROOT or pass --source=/path/to/aurora-proto.",
  );
}
const sourceRoot = resolve(sourceArgument);
const source = resolve(
  sourceRoot,
  "backend/Borealis.Api.Contracts/V1/BorealisOperationCatalog.cs",
);
const registrySource = resolve(
  sourceRoot,
  "backend/Borealis.SaaS.Cli/CommandLine/BorealisSaaSCliCommandRegistry.cs",
);
const clientSource = resolve(
  sourceRoot,
  "backend/Borealis.Client/BorealisClient.cs",
);
const destination = resolve(import.meta.dirname, "../src/operations.json");
const text = await readFile(source, "utf8");
const expression =
  /Op\("([^"]+)",\s*"([A-Z]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g;
const allOperations = [...text.matchAll(expression)].map((match) => ({
  operationId: match[1],
  method: match[2],
  path: match[3],
  scope: match[4],
  risk: match[5],
  clientMethod: match[6],
  command: match[7],
  mcpName: match[8],
}));
const operations = allOperations.filter(
  (operation) => !operation.operationId.startsWith("admin."),
);
const keyed = new Set([
  "sandbox.create",
  "sandbox.exec.start",
  "sandbox.exec.transient",
  "sandbox.port.register",
  "sandbox.workspace.import",
  "snapshot.create",
  "host_pool.create",
  "host_enrollment.create",
  "registry.create",
  "template.create",
  "interactive.create",
  "interactive.stdin",
  "service_principal.create",
  "billing.checkout.create",
  "billing.top_up.create",
]);
const targetStatePost = new Set([
  "sandbox.start",
  "sandbox.stop",
  "sandbox.resume",
  "registry.validate",
  "sandbox.exec.cancel",
  "interactive.stop",
  "interactive.resize",
  "snapshot.delete",
  "host.drain",
  "host.resume",
  "host.disable",
  "host.enable",
  "host.evict",
]);
const paged = new Set([
  "sandbox.list",
  "snapshot.list",
  "registry.list",
  "template.list",
  "host_pool.list",
  "host.list",
  "service_principal.list",
  "interactive.list",
  "billing.usage.list",
  "billing.consumers.list",
  "billing.invoices.list",
]);
for (const operation of operations) {
  operation.ownership = operation.operationId.startsWith("profile.")
    ? "subject"
    : operation.operationId === "context.get"
      ? "subject-and-organization"
      : operation.operationId === "organization.list"
        ? "subject"
        : "organization";
  operation.idempotency = keyed.has(operation.operationId)
    ? "idempotency-key"
    : operation.method === "GET"
      ? "safe"
      : ["PUT", "PATCH", "DELETE"].includes(operation.method) ||
          targetStatePost.has(operation.operationId)
        ? "target-state"
        : "none";
  operation.retry =
    operation.idempotency === "none" ? "never-after-dispatch" : "safe";
  operation.paging = paged.has(operation.operationId) ? "page" : "none";
  operation.requiresPreflight = operation.risk === "destructive";
}

if (allOperations.length !== 119 || operations.length !== 75) {
  throw new Error(
    `Expected 119 canonical and 75 public non-admin operations; parsed ${allOperations.length} and ${operations.length}.`,
  );
}
const [registry, client, typescriptClient, typescriptClientTests] =
  await Promise.all([
    readFile(registrySource, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }),
    readFile(clientSource, "utf8"),
    readFile(resolve(import.meta.dirname, "../src/api-client.ts"), "utf8"),
    readFile(resolve(import.meta.dirname, "../src/api-client.test.ts"), "utf8"),
  ]);
const transportSection = text.match(
  /TransportOperations \{ get; \} =\s*\[(.*?)\];/s,
)?.[1];
const transportOperations = transportSection
  ? [
      ...transportSection.matchAll(/new\("([^"]+)",[^\n]+?"([A-Za-z]+Async)"/g),
    ].map((match) => ({ operationId: match[1], method: match[2] }))
  : [];
const transportMethods = transportOperations.map(({ method }) => method);
if (
  transportMethods.length !== 10 ||
  transportMethods.some((method) => !client.includes(`${method}(`))
) {
  throw new Error(
    `Expected all 10 transport operations to map to Borealis.Client; found ${transportMethods.length}.`,
  );
}
if (
  transportOperations.some(
    ({ operationId }) =>
      !typescriptClient.includes(`"${operationId}"`) ||
      !typescriptClientTests.includes(`"${operationId}"`),
  )
) {
  throw new Error(
    "Every canonical transport operation must be mapped in the TypeScript client and its tests.",
  );
}
for (const operation of operations) {
  if (
    registry &&
    !registry.includes(
      `("${operation.command}", nameof(BorealisClient.${operation.clientMethod}))`,
    )
  ) {
    throw new Error(
      `The .NET CLI registry does not map ${operation.command} to ${operation.clientMethod}.`,
    );
  }
  if (!client.includes(`${operation.clientMethod}(`)) {
    throw new Error(
      `Borealis.Client does not implement ${operation.clientMethod}.`,
    );
  }
}

const serialized = `${JSON.stringify(operations, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(destination, "utf8");
  if (current !== serialized) {
    throw new Error(
      "The checked-in operation catalog differs from Borealis.Api.Contracts. Run pnpm parity:update.",
    );
  }
  process.stdout.write(
    `Verified ${operations.length} public operations and ${transportMethods.length} bounded transport operations against the .NET catalog and client${registry ? ", including the legacy CLI registry" : ""}.\n`,
  );
} else {
  await writeFile(destination, serialized, "utf8");
  process.stdout.write(
    `Imported ${operations.length} Borealis operations into ${destination}.\n`,
  );
}
