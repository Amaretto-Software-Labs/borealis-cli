import type { Command } from "commander";
import { createCommandGrammar } from "./command-grammar.js";

const optionsWithValues = [
  "--api",
  "--app",
  "--identity",
  "--organization",
  "--profile",
  "--token",
  "--token-file",
];

function commandChildren(): Map<string, Command[]> {
  const entries = new Map<string, Command[]>();
  function visit(path: string, command: Command): void {
    if (!command.commands.length) return;
    const children = [...command.commands].sort((a, b) =>
      a.name().localeCompare(b.name()),
    );
    entries.set(path, children);
    for (const child of children)
      visit([path, child.name()].filter(Boolean).join(" "), child);
  }
  visit("", createCommandGrammar());
  return entries;
}

function fishQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function completion(shell: string): string {
  const entries = commandChildren();
  const cases = (assign: (children: string) => string) =>
    [...entries]
      .map(
        ([path, children]) =>
          `    '${path}') ${assign(children.map((child) => child.name()).join(" "))} ;;`,
      )
      .join("\n");
  if (shell === "bash")
    return `_borealis() {
  local path='' word i skip=0 candidates=''
  for ((i=1; i<COMP_CWORD; i++)); do
    word=\${COMP_WORDS[i]}
    if ((skip)); then skip=0; continue; fi
    case "$word" in
      ${optionsWithValues.join("|")}) skip=1 ;;
      -*) ;;
      *) path=\${path:+"$path "}$word ;;
    esac
  done
  if ((skip)); then return; fi
  case "$path" in
${cases((children) => `candidates='${children}'`)}
  esac
  COMPREPLY=( $(compgen -W "$candidates" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _borealis borealis
`;
  if (shell === "zsh")
    return `#compdef borealis
_borealis() {
  local path='' word
  local -i i skip=0
  local -a candidates
  for ((i=2; i<CURRENT; i++)); do
    word=\${words[i]}
    if ((skip)); then skip=0; continue; fi
    case "$word" in
      ${optionsWithValues.join("|")}) skip=1 ;;
      -*) ;;
      *) path=\${path:+"$path "}$word ;;
    esac
  done
  if ((skip)); then return; fi
  case "$path" in
${cases((children) => `candidates=(${children})`)}
  esac
  compadd -- "\${candidates[@]}"
}
_borealis "$@"
`;
  if (shell === "fish")
    return `function __borealis_at_command
  set -l words (commandline -opc)
  set -e words[1]
  set -l path
  set -l skip 0
  for word in $words
    if test $skip -eq 1
      set skip 0
      continue
    end
    switch $word
      case ${optionsWithValues.join(" ")}
        set skip 1
      case '-*'
      case '*'
        set -a path $word
    end
  end
  set -l current (string join ' ' $path)
  test $skip -eq 0; and test "$current" = "$argv[1]"
end
${[...entries]
  .flatMap(([path, children]) =>
    children.map(
      (child) =>
        `complete -c borealis -f -n ${fishQuote(`__borealis_at_command "${path}"`)} -a ${fishQuote(child.name())} -d ${fishQuote(child.description())}`,
    ),
  )
  .join("\n")}
`;
  throw new Error("completion requires bash, zsh, or fish.");
}
