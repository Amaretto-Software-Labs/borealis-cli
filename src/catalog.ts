import runtimeOperationData from "./runtime-operations.json" with { type: "json" };
import operationData from "./operations.json" with { type: "json" };
import { operationSchema, type Operation } from "./types.js";

export const operations: readonly Operation[] = Object.freeze(
  [...operationData, ...runtimeOperationData].map((operation) =>
    operationSchema.parse(operation),
  ),
);

export function resolveOperation(
  args: readonly string[],
): { operation: Operation; rest: string[] } | undefined {
  return operations
    .map((operation) => ({ operation, tokens: operation.command.split(" ") }))
    .filter(({ tokens }) =>
      tokens.every((token, index) => args[index]?.toLowerCase() === token),
    )
    .sort((left, right) => right.tokens.length - left.tokens.length)
    .map(({ operation, tokens }) => ({
      operation,
      rest: args.slice(tokens.length),
    }))
    .at(0);
}

/** Conditional dispatch after observing the resource's actual runtime kind and logical binding. */
export const runtimeLifecycleMappings: Readonly<Record<string, string>> =
  Object.freeze({
    "sandbox.start": "logical_machine.start",
    "sandbox.resume": "logical_machine.wake",
    "sandbox.stop": "logical_machine.stop",
    "sandbox.delete": "logical_machine.delete",
  });
