import { Command, Option } from "commander";
import { operations } from "./catalog.js";
import type { Operation } from "./types.js";

const valueOptions = [
  "account",
  "arg",
  "body",
  "cancel-url",
  "client-id",
  "cols",
  "command",
  "container-port",
  "cpu",
  "cursor",
  "data",
  "display-name",
  "entitlement",
  "env",
  "external-id",
  "host",
  "host-id",
  "id",
  "idempotency-key",
  "idle-timeout",
  "image",
  "kind",
  "limit",
  "memory",
  "microcredits",
  "name",
  "namespace",
  "output",
  "page",
  "page-size",
  "placement",
  "plan",
  "pool",
  "port",
  "price",
  "protocol",
  "reason",
  "region",
  "repository",
  "request-id",
  "role",
  "rows",
  "sandbox",
  "sandbox-name",
  "scope",
  "search",
  "secret",
  "secret-file",
  "set",
  "slots",
  "slug",
  "status",
  "stripe-price",
  "subject-id",
  "subject-type",
  "success-url",
  "tail",
  "target",
  "threshold",
  "timeout",
  "type",
  "username",
  "window-minutes",
  "workdir",
  "working-directory",
] as const;

const booleanOptions = [
  "default",
  "disable",
  "enable",
  "include-secret",
  "inactive",
  "keep",
  "newline",
  "no-auto-provision",
  "no-start",
  "secret-stdin",
  "wait",
] as const;

type ValueOption = (typeof valueOptions)[number];
type BooleanOption = (typeof booleanOptions)[number];

const operationOptions: Readonly<
  Record<string, readonly (ValueOption | BooleanOption)[]>
> = {
  "sandbox.create": [
    "name",
    "image",
    "command",
    "arg",
    "env",
    "port",
    "workdir",
    "working-directory",
    "idle-timeout",
    "cpu",
    "memory",
    "no-start",
  ],
  "sandbox.port.register": ["container-port", "protocol"],
  "sandbox.exec.start": ["command", "timeout"],
  "sandbox.exec.transient": ["command"],
  "sandbox.logs.get": ["tail"],
  "sandbox.workspace.export": ["output"],
  "sandbox.workspace.import": ["keep", "wait", "timeout"],
  "snapshot.create": ["sandbox", "request-id", "wait", "timeout"],
  "snapshot.operation.get": ["sandbox"],
  "registry.create": [
    "name",
    "host",
    "type",
    "username",
    "secret",
    "secret-file",
    "secret-stdin",
    "repository",
    "default",
  ],
  "registry.update": [
    "name",
    "host",
    "type",
    "username",
    "secret",
    "secret-file",
    "secret-stdin",
    "repository",
    "default",
  ],
  "template.create": [
    "display-name",
    "name",
    "sandbox-name",
    "image",
    "command",
    "idle-timeout",
  ],
  "template.update": [
    "display-name",
    "name",
    "sandbox-name",
    "image",
    "command",
    "idle-timeout",
  ],
  "host_pool.create": ["name", "slug", "region", "placement"],
  "host_pool.update": ["name", "status", "placement"],
  "host.list": ["pool"],
  "host.get": ["pool", "host-id"],
  "host.drain": ["pool", "host-id"],
  "host.resume": ["pool", "host-id"],
  "host.disable": ["pool", "host-id"],
  "host.enable": ["pool", "host-id"],
  "host.evict": ["pool", "host-id"],
  "host.retire": ["pool", "host-id"],
  "host_enrollment.create": [
    "pool",
    "host-id",
    "name",
    "slots",
    "output",
    "include-secret",
  ],
  "host_enrollment.get": ["pool", "output", "include-secret"],
  "host_enrollment.cancel": ["pool"],
  "service_principal.create": ["name", "scope", "output", "include-secret"],
  "interactive.create": ["sandbox", "cols", "rows"],
  "interactive.list": ["sandbox"],
  "interactive.stdin": ["data", "newline"],
  "interactive.resize": ["cols", "rows"],
  "interactive.output": ["cursor", "limit"],
  "billing.checkout.create": [
    "account",
    "price",
    "plan",
    "success-url",
    "cancel-url",
  ],
  "billing.top_up.create": ["microcredits", "success-url", "cancel-url"],
  "billing.auto_top_up.configure": ["enable", "disable", "threshold", "target"],
};

function addOperationOptions(command: Command, operation: Operation): void {
  const names = new Set<ValueOption | BooleanOption>(
    operationOptions[operation.operationId] ?? [],
  );
  if (operation.paging === "page") {
    names.add("page");
    names.add("page-size");
  }
  if (operation.idempotency === "idempotency-key") names.add("idempotency-key");
  if (operation.method !== "GET") {
    names.add("body");
    names.add("set");
  }
  for (const name of valueOptions.filter((candidate) => names.has(candidate))) {
    const option = new Option(`--${name} <value>`);
    if (
      [
        "arg",
        "entitlement",
        "env",
        "port",
        "repository",
        "role",
        "scope",
        "set",
      ].includes(name)
    ) {
      option
        .argParser((value: string, previous: string[] = []) => [
          ...previous,
          value,
        ])
        .default([]);
    }
    command.addOption(option);
  }
  for (const name of booleanOptions.filter((candidate) => names.has(candidate)))
    command.option(`--${name}`);
}

export function createCommandGrammar(): Command {
  const program = new Command()
    .name("borealis")
    .description("Official command-line client for the Borealis public API")
    .helpOption(false)
    .option("-h, --help")
    .option("-V, --version")
    .option("--api <origin>")
    .option("--identity <origin>")
    .option("--app <origin>")
    .option("--profile <name>")
    .option("--organization <id>")
    .option("--token-file <path>")
    .option("--token <token>")
    .option("--json")
    .option("--yes");

  const nodes = new Map<string, Command>();
  for (const operation of [...operations].sort(
    (left, right) =>
      left.command.split(" ").length - right.command.split(" ").length,
  )) {
    let parent = program;
    let path = "";
    for (const token of operation.command.split(" ")) {
      path = path ? `${path} ${token}` : token;
      let node = nodes.get(path);
      if (!node) {
        node = new Command(token);
        parent.addCommand(node);
        nodes.set(path, node);
      }
      parent = node;
    }
    parent.description(`${operation.operationId} (${operation.scope})`);
    parent.argument("[identifiers...]");
    addOperationOptions(parent, operation);
    parent.action(() => undefined);
  }

  const auth = program.command("auth");
  auth
    .command("login")
    .option("--client-id <id>")
    .option("--scope <scopes>")
    .option("--redirect-port <port>")
    .option("--login-hint <email>")
    .action(() => undefined);
  auth.command("whoami").action(() => undefined);
  auth.command("logout").action(() => undefined);
  program.command("completion <shell>").action(() => undefined);
  program.command("version").action(() => undefined);
  program.command("help").action(() => undefined);
  program.action(() => undefined);
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  for (const node of nodes.values())
    node.configureOutput({ writeErr: () => undefined });
  return program;
}

export function validateCommandGrammar(argv: readonly string[]): void {
  createCommandGrammar().parse(["node", "borealis", ...argv]);
}
