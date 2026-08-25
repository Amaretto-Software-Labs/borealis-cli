#!/usr/bin/env node
import { run } from "./app.js";

const controller = new AbortController();
const cancel = (): void => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  process.exitCode = await run(process.argv.slice(2), controller.signal);
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
