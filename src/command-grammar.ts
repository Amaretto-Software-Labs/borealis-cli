import { Command, Option } from "commander";
import { helperCommands } from "./host-helper.js";
import { commandGroups, publicOperations } from "./public-commands.js";
import type { Operation } from "./types.js";

const valueOptions = [
  "account",
  "arg",
  "architecture",
  "attachment",
  "body",
  "cancel-url",
  "checkpoint-policy",
  "client-id",
  "cols",
  "command",
  "context",
  "dockerfile",
  "archive",
  "container-port",
  "cpu",
  "cursor",
  "data",
  "display-name",
  "entitlement",
  "expected-generation",
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
  "label",
  "local-port",
  "memory",
  "memory-mib",
  "microcredits",
  "name",
  "namespace",
  "network",
  "output",
  "page",
  "page-size",
  "placement",
  "plan",
  "pool",
  "port",
  "price",
  "prepared-image",
  "protocol",
  "reason",
  "region",
  "registry",
  "repository",
  "root-disk",
  "root-disk-gib",
  "request-id",
  "role",
  "routing-domain",
  "runtime",
  "runtime-template",
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
  "template-revision",
  "revision",
  "threshold",
  "timeout",
  "type",
  "username",
  "vcpu",
  "window-minutes",
  "workdir",
  "working-directory",
] as const;

const booleanOptions = [
  "clear-default-dns",
  "default",
  "disable",
  "enable",
  "enable-nested-containers",
  "forward",
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
  "vnet.create": ["name", "routing-domain"],
  "vnet_attachment.create": ["network"],
  "network_service.create": ["network", "label", "attachment"],
  "network_service.update": ["network", "attachment"],
  "network_service.delete": ["network"],
  "vm_network_configuration.update": ["attachment", "clear-default-dns"],
  "sandbox.start": ["idempotency-key", "wait", "timeout"],
  "sandbox.resume": ["idempotency-key", "wait", "timeout"],
  "sandbox.stop": ["idempotency-key", "wait", "timeout"],
  "sandbox.delete": ["idempotency-key", "wait", "timeout"],
  "sandbox.pause": ["wait", "timeout"],
  "operation.get": ["timeout"],
  "supervisor.events": ["limit"],
  "supervisor.logs": ["limit"],
  "runtime_image_build.create": [
    "context",
    "dockerfile",
    "archive",
    "image",
    "architecture",
    "registry",
    "enable-nested-containers",
    "wait",
    "timeout",
  ],
  "runtime_image_build.cancel": ["idempotency-key", "wait", "timeout"],
  "runtime_image_build.get": ["wait", "timeout"],
  "runtime_image_template.stage": [
    "vcpu",
    "memory-mib",
    "root-disk-gib",
    "idempotency-key",
    "wait",
    "timeout",
  ],
  "sandbox.create": [
    "checkpoint-policy",
    "enable-nested-containers",
    "wait",
    "timeout",
    "name",
    "image",
    "command",
    "arg",
    "env",
    "workdir",
    "prepared-image",
    "revision",
    "architecture",
    "vcpu",
    "memory-mib",
    "root-disk-gib",
    "no-start",
  ],
  "sandbox.port.register": [
    "container-port",
    "protocol",
    "forward",
    "local-port",
  ],
  "sandbox.exec.start": ["command", "arg", "timeout"],
  "sandbox.exec.transient": ["command", "arg", "timeout"],
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

const optionDescriptions: Readonly<Record<string, string>> = {
  arg: "Pass one argument to the command. Repeat for more arguments.",
  architecture: "VM architecture (x86_64 or aarch64)",
  body: "Supply an advanced request as JSON",
  context: "Directory containing the Dockerfile and build context",
  image:
    "OCI image reference. VM creation from OCI is available on standalone hosts.",
  "memory-mib": "Guest memory in MiB",
  "prepared-image": "Prepared image ID from 'borealis image list'",
  revision: "Prepared image revision",
  "root-disk-gib": "Guest root disk capacity in GiB",
  timeout: "Maximum time in seconds",
  vcpu: "Number of guest vCPUs",
  wait: "Wait for the operation to finish",
};

const helperDescriptions: Readonly<Record<string, string>> = {
  apply: "Apply an approved update plan",
  "builder-install": "Install the image builder on this host",
  "cloud-connect": "Connect this host to Borealis Cloud",
  "cloud-disconnect": "Disconnect this host from Borealis Cloud",
  "cloud-status": "Show this host's Cloud connection state",
  "config-apply": "Apply reviewed standalone host settings",
  "config-show": "Show the current standalone configuration",
  "config-validate": "Validate a standalone configuration file",
  logs: "Read the supervisor service journal",
  plan: "Plan an update from a signed release bundle",
  repair: "Inspect or resume an interrupted host maintenance action",
  restart: "Restart the supervisor safely",
  start: "Start the supervisor",
  stop: "Stop the supervisor when the host is idle",
  uninstall: "Uninstall the supervisor and retain its data",
  "update-check": "Check a signed release bundle for updates",
  "update-status": "Show the state of a host update",
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
    const option = new Option(`--${name} <value>`, optionDescriptions[name]);
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
    command.option(`--${name}`, optionDescriptions[name]);
}

export function createCommandGrammar(): Command {
  const program = new Command()
    .name("borealis")
    .description(
      "Manage virtual machines on standalone hosts and Borealis Cloud",
    )
    .configureHelp({ sortSubcommands: true })
    .helpOption(false)
    .option("-h, --help", "Show usage and examples")
    .option("-V, --version", "Show the installed CLI version")
    .option("--api <origin>", "Override the Cloud API origin")
    .option("--identity <origin>", "Override the Cloud identity origin")
    .option("--app <origin>", "Override the Cloud application origin")
    .option("--profile <name>", "Use a named target for this command")
    .option("--organization <id>", "Use a Cloud organization")
    .option("--token-file <path>", "Read a Cloud access token from a file")
    .addOption(new Option("--token <token>").hideHelp())
    .option("--json", "Write machine-readable output")
    .option("--yes", "Confirm a destructive action without prompting");

  const nodes = new Map<string, Command>();
  function commandNode(command: string): Command {
    let parent = program;
    let path = "";
    for (const token of command.split(" ")) {
      path = path ? `${path} ${token}` : token;
      let node = nodes.get(path);
      if (!node) {
        node = new Command(token).configureHelp({ sortSubcommands: true });
        const description = commandGroups[path];
        if (description) node.description(description);
        parent.addCommand(node);
        nodes.set(path, node);
      }
      parent = node;
    }
    return parent;
  }
  for (const { operation, description } of publicOperations) {
    const node = commandNode(operation.command).description(description);
    for (const [, field] of operation.path.matchAll(/\{([^}]+)\}/g)) {
      const name =
        field === "sandboxId"
          ? "vm-id"
          : field!.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      node.argument(`[${name}]`);
    }
    if (
      ["sandbox.workspace.import", "sandbox.workspace.export"].includes(
        operation.operationId,
      )
    )
      node.argument("[archive]");
    addOperationOptions(node, operation);
    node.action(() => undefined);
  }

  const supervisor = commandNode("supervisor");
  supervisor
    .command("install")
    .description("Install a verified local host bundle")
    .requiredOption("--bundle <directory>")
    .option("--configuration <file>")
    .option("--without-builder")
    .option("--socket <path>")
    .action(() => undefined);
  for (const [command, helper] of Object.entries(helperCommands)) {
    const node = commandNode(command).action(() => undefined);
    node.description(helperDescriptions[helper.command]!);
    if (helper.acceptsBundle) node.requiredOption("--bundle <directory>");
    if (helper.command === "uninstall")
      node.option(
        "--bundle <directory>",
        "Resume cleanup with the exact signed release",
      );
    if (helper.command === "apply")
      node
        .requiredOption("--plan-id <digest>")
        .option("--wait")
        .option("--timeout <seconds>");
    if (helper.command === "update-status") node.argument("[attemptId]");
    if (helper.command === "repair") node.option("--resume");
    if (["config-validate", "config-apply"].includes(helper.command))
      node.requiredOption("--file <path>");
    if (helper.command === "config-apply")
      node.requiredOption("--revision <digest>");
    if (helper.command === "cloud-connect")
      node
        .requiredOption("--control-plane <https-origin>")
        .option("--enrollment-code-file <path>")
        .option("--enrollment-code-stdin")
        .option("--enable-control")
        .option("--pool <pool>");
  }

  const profile = commandNode("profile");
  profile
    .command("add <name>")
    .description("Register a local, SSH, or Cloud target")
    .option("--local")
    .option("--ssh <alias>")
    .option("--cloud")
    .option("--socket <path>")
    .action(() => undefined);
  profile
    .command("list")
    .description("List targets and show the selected target")
    .action(() => undefined);
  profile
    .command("use <name>")
    .description("Select the default target")
    .action(() => undefined);

  commandNode("tunnel").description(
    "Publish a loopback service through Borealis Cloud",
  );
  commandNode("tunnel http")
    .description("Publish a guest or named HTTP tunnel")
    .argument("<target>", "loopback port or HTTP(S) origin")
    .option("--name <name>", "stable tunnel name")
    .option("--ipv6", "dial IPv6 loopback")
    .option(
      "--upstream-ca <file>",
      "additional local HTTPS trust anchors in PEM format",
    )
    .action(() => undefined);
  commandNode("tunnel tcp")
    .description("Publish a named TCP tunnel")
    .argument("<port>", "loopback TCP port")
    .requiredOption("--name <name>", "stable tunnel name")
    .option("--ipv6", "dial IPv6 loopback")
    .action(() => undefined);
  commandNode("tunnel list")
    .description("List named tunnel reservations")
    .action(() => undefined);
  commandNode("tunnel disconnect")
    .description("Disconnect a publisher and keep its reservation")
    .argument("<name>")
    .action(() => undefined);
  commandNode("tunnel release")
    .description("Permanently retire an offline tunnel")
    .argument("<name>")
    .action(() => undefined);

  const auth = commandNode("auth");
  auth
    .command("login")
    .description("Sign in to Borealis Cloud")
    .option("--client-id <id>")
    .option("--scope <scopes>")
    .option("--redirect-port <port>")
    .option("--login-hint <email>")
    .action(() => undefined);
  auth
    .command("logout")
    .description("Sign out of Borealis Cloud")
    .action(() => undefined);
  program
    .command("completion <shell>")
    .description("Generate Bash, Fish, or Zsh completions")
    .action(() => undefined);
  program
    .command("version")
    .description("Show the installed CLI version")
    .action(() => undefined);
  program
    .command("help [command...]")
    .description("Show usage and examples")
    .action(() => undefined);
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
