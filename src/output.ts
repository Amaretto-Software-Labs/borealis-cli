import { formatPublicResult } from "./public-output.js";
import type { Operation } from "./types.js";

export const writesExecutionStreams = (operation: Operation): boolean =>
  ["sandbox.exec.transient", "sandbox.exec.get"].includes(
    operation.operationId,
  );

export function writeOperationResult(
  operation: Operation,
  result: unknown,
  json: boolean,
  target?: unknown,
): void {
  if (json) {
    writeResult(target ? { target, result } : result, true);
    return;
  }
  if (
    writesExecutionStreams(operation) &&
    result &&
    typeof result === "object" &&
    "stdout" in result &&
    "stderr" in result
  ) {
    if (typeof result.stdout === "string" && result.stdout)
      process.stdout.write(result.stdout);
    if (typeof result.stderr === "string" && result.stderr)
      process.stderr.write(result.stderr);
    if (
      !result.stdout &&
      !result.stderr &&
      operation.operationId === "sandbox.exec.get" &&
      "status" in result
    )
      process.stderr.write(`Command ${String(result.status)}.\n`);
    return;
  }
  writeResult(formatPublicResult(operation, result), false);
}

export function commandExitCode(
  operation: Operation,
  result: unknown,
): number | undefined {
  if (
    operation.operationId !== "sandbox.exec.transient" ||
    !result ||
    typeof result !== "object"
  )
    return undefined;
  if (
    "exitCode" in result &&
    Number.isInteger(result.exitCode) &&
    Number(result.exitCode) >= 0 &&
    Number(result.exitCode) <= 255
  )
    return Number(result.exitCode);
  if ("status" in result && result.status !== "succeeded") return 3;
  return undefined;
}

export function writeResult(result: unknown, json: boolean): void {
  if (result instanceof Uint8Array) {
    process.stdout.write(Buffer.from(result));
    return;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (Array.isArray(result)) {
    for (const item of result) process.stdout.write(`${formatItem(item)}\n`);
    return;
  }
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { items?: unknown[] }).items)
  ) {
    for (const item of (result as { items: unknown[] }).items)
      process.stdout.write(`${formatItem(item)}\n`);
    return;
  }
  process.stdout.write(
    `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
  );
}

function formatItem(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  return Object.values(value as Record<string, unknown>)
    .filter((item) => typeof item !== "object")
    .slice(0, 5)
    .join("\t");
}
