import { operations } from "./catalog.js";

export function completion(shell: string): string {
  const commands = [
    ...new Set(operations.map((operation) => operation.command)),
  ]
    .sort()
    .join(" ");
  if (shell === "bash")
    return `_borealis(){ COMPREPLY=( $(compgen -W '${commands}' -- "${"$"}{COMP_WORDS[*]:1}") ); }\ncomplete -F _borealis borealis\n`;
  if (shell === "zsh")
    return `#compdef borealis\n_arguments '*:command:(${commands})'\n`;
  if (shell === "fish")
    return (
      operations
        .map(
          (operation) =>
            `complete -c borealis -a '${operation.command}' -d '${operation.operationId}'`,
        )
        .join("\n") + "\n"
    );
  throw new Error("completion requires bash, zsh, or fish.");
}
