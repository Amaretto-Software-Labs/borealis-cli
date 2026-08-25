import operationData from "./operations.json" with { type: "json" };
import { operationSchema, type Operation } from "./types.js";

export const operations: readonly Operation[] = Object.freeze(
  operationData.map((operation) => operationSchema.parse(operation)),
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
