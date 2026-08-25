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
