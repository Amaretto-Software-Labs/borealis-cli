import { commandOperations } from "./catalog.js";
import type { Operation } from "./types.js";

const commands = [
  [
    "auth whoami",
    "context show",
    "Show the current local, SSH, or Cloud identity",
  ],
  ["vm list", "sandbox list", "List VMs"],
  ["vm create", "sandbox create", "Create a VM from an image"],
  ["vm inspect", "sandbox get", "Show a VM's state, image, and resources"],
  ["vm start", "sandbox start", "Start a stopped VM"],
  ["vm stop", "sandbox stop", "Stop a running VM"],
  ["vm pause", "sandbox pause", "Pause a VM on the standalone supervisor"],
  ["vm resume", "sandbox resume", "Resume a paused VM"],
  [
    "vm resume status",
    "logical-machine wake get",
    "Check a Cloud VM resume request",
  ],
  [
    "vm operation status",
    "logical-machine operation get",
    "Check a Cloud VM operation",
  ],
  ["vm delete", "sandbox delete", "Delete a VM"],
  [
    "vm exec",
    "sandbox exec transient",
    "Run a short command and show its output",
  ],
  [
    "vm exec start",
    "sandbox exec",
    "Start a command and return its execution ID",
  ],
  ["vm exec status", "sandbox exec get", "Show a command's state and output"],
  ["vm exec cancel", "sandbox exec cancel", "Cancel a running command"],
  ["vm logs", "sandbox logs", "Show VM logs"],
  [
    "vm capabilities",
    "sandbox capabilities",
    "Show features supported by a VM",
  ],
  ["vm usage", "sandbox usage", "Show VM resource usage"],
  [
    "vm workspace export",
    "sandbox workspace export",
    "Download a VM workspace as a tar archive",
  ],
  [
    "vm workspace import",
    "sandbox workspace import",
    "Upload a tar archive into a VM workspace",
  ],
  [
    "vm port register",
    "sandbox port register",
    "Expose a guest port on the host's loopback interface",
  ],
  ["vm snapshot create", "snapshot create", "Capture a VM snapshot"],
  ["vm snapshot list", "snapshot list", "List VM snapshots"],
  ["vm snapshot inspect", "snapshot get", "Show a snapshot's details"],
  ["vm snapshot delete", "snapshot delete", "Delete a snapshot"],
  [
    "vm snapshot status",
    "snapshot operation get",
    "Show the progress of a snapshot operation",
  ],
  [
    "vm session create",
    "interactive create",
    "Open an interactive terminal session",
  ],
  ["vm session list", "interactive list", "List interactive terminal sessions"],
  [
    "vm session inspect",
    "interactive get",
    "Show the details of an interactive session",
  ],
  [
    "vm session attach",
    "interactive attach",
    "Attach your terminal to a session",
  ],
  [
    "vm session stop",
    "interactive stop",
    "Close an interactive terminal session",
  ],
  [
    "vm session input",
    "interactive stdin",
    "Send input to an interactive session",
  ],
  [
    "vm session output",
    "interactive output",
    "Read an interactive session's recent output",
  ],
  [
    "vm session resize",
    "interactive resize",
    "Change an interactive session's terminal size",
  ],
  [
    "vm network inspect",
    "vm network get",
    "Show a Cloud VM's network configuration",
  ],
  [
    "vm network attachments",
    "vnet attachment vm list",
    "List the private networks connected to a VM",
  ],
  [
    "vm network update",
    "vm network update",
    "Update a Cloud VM's network configuration",
  ],
  ["image list", "runtime-image template list", "List prepared VM images"],
  ["image inspect", "runtime-image template get", "Show a prepared VM image"],
  [
    "image prepare",
    "runtime-image template stage",
    "Prepare an image for a VM resource size",
  ],
  [
    "image build",
    "runtime-image build",
    "Build a VM image from an OCI image or a Dockerfile",
  ],
  ["image build list", "runtime-image list", "List standalone image builds"],
  [
    "image build status",
    "runtime-image get",
    "Show the progress and outcome of an image build",
  ],
  ["image build cancel", "runtime-image cancel", "Cancel an image build"],
  [
    "image build approve",
    "runtime-image approve",
    "Approve a Cloud image build for publication",
  ],
  ["image registry list", "registry list", "List image registry connections"],
  [
    "image registry inspect",
    "registry get",
    "Show an image registry connection",
  ],
  [
    "image registry create",
    "registry create",
    "Add an image registry connection",
  ],
  [
    "image registry update",
    "registry update",
    "Update an image registry connection",
  ],
  [
    "image registry validate",
    "registry validate",
    "Check a Cloud image registry connection",
  ],
  [
    "image registry delete",
    "registry delete",
    "Delete an image registry connection",
  ],
  ["network list", "vnet list", "List Cloud private networks"],
  ["network inspect", "vnet get", "Show a private network"],
  ["network create", "vnet create", "Create a private network"],
  ["network delete", "vnet delete", "Delete a private network"],
  [
    "network attachment list",
    "vnet attachment list",
    "List VM attachments for a network",
  ],
  [
    "network attachment inspect",
    "vnet attachment get",
    "Show a network attachment",
  ],
  [
    "network attachment create",
    "vnet attachment create",
    "Attach a VM to a network",
  ],
  [
    "network attachment delete",
    "vnet attachment delete",
    "Detach a VM from a network",
  ],
  [
    "network service list",
    "network service list",
    "List services on a private network",
  ],
  [
    "network service create",
    "network service create",
    "Register a private network service",
  ],
  [
    "network service update",
    "network service update",
    "Update a private network service",
  ],
  [
    "network service delete",
    "network service delete",
    "Remove a private network service",
  ],
  [
    "network operation status",
    "private-network operation get",
    "Show the progress of a network change",
  ],
  ["cloud account show", "profile show", "Show your Cloud account profile"],
  [
    "cloud account password",
    "profile password",
    "Start a Cloud account password change",
  ],
  ["cloud capacity", "capacity show", "Show Cloud VM capacity"],
  [
    "cloud organization list",
    "organization list",
    "List your Cloud organizations",
  ],
  [
    "cloud service-principal list",
    "service-principal list",
    "List Cloud service principals",
  ],
  [
    "cloud service-principal scopes",
    "service-principal scopes",
    "List Cloud service principal permissions",
  ],
  [
    "cloud service-principal create",
    "service-principal create",
    "Create a Cloud service principal",
  ],
  [
    "cloud service-principal revoke",
    "service-principal revoke",
    "Revoke a Cloud service principal",
  ],
  ["cloud pool list", "host-pool list", "List Cloud host pools"],
  ["cloud pool inspect", "host-pool get", "Show a Cloud host pool"],
  ["cloud pool create", "host-pool create", "Create a Cloud host pool"],
  ["cloud pool update", "host-pool update", "Update a Cloud host pool"],
  ["cloud pool delete", "host-pool delete", "Delete a Cloud host pool"],
  ["cloud host list", "host list", "List hosts in a Cloud pool"],
  ["cloud host inspect", "host get", "Show a Cloud host"],
  ["cloud host drain", "host drain", "Drain a Cloud host before maintenance"],
  ["cloud host resume", "host resume", "Resume scheduling on a Cloud host"],
  ["cloud host disable", "host disable", "Disable a Cloud host"],
  ["cloud host enable", "host enable", "Enable a Cloud host"],
  ["cloud host evict", "host evict", "Evict workloads from a Cloud host"],
  ["cloud host retire", "host retire", "Retire a Cloud host"],
  [
    "cloud host enrollment create",
    "host enrollment create",
    "Create Cloud host enrollment credentials",
  ],
  [
    "cloud host enrollment inspect",
    "host enrollment get",
    "Read Cloud host enrollment details",
  ],
  [
    "cloud host enrollment cancel",
    "host enrollment cancel",
    "Cancel a Cloud host enrollment",
  ],
  [
    "cloud billing account",
    "billing account",
    "Show the Cloud billing account",
  ],
  [
    "cloud billing summary",
    "billing summary",
    "Show the Cloud billing summary",
  ],
  ["cloud billing usage", "billing usage", "List billed Cloud usage"],
  [
    "cloud billing usage summary",
    "billing usage summary",
    "Summarize billed Cloud usage",
  ],
  [
    "cloud billing consumer list",
    "billing consumer list",
    "List Cloud billing consumers",
  ],
  ["cloud billing invoice list", "billing invoice list", "List Cloud invoices"],
  [
    "cloud billing checkout",
    "billing checkout",
    "Start Cloud billing checkout",
  ],
  ["cloud billing top-up", "billing top-up", "Buy additional Cloud credits"],
  [
    "cloud billing auto-top-up",
    "billing auto-top-up",
    "Configure automatic Cloud credit purchases",
  ],
  [
    "supervisor status",
    "supervisor status",
    "Show the selected supervisor's health and capabilities",
  ],
  [
    "status",
    "supervisor status",
    "Show the selected host, running VMs, and image builds",
  ],
  [
    "doctor",
    "supervisor doctor",
    "Diagnose supervisor installation, socket access, and image builder health",
  ],
  [
    "supervisor events",
    "supervisor events",
    "List recent supervisor operations",
  ],
  ["supervisor logs", "supervisor logs", "Read the supervisor service journal"],
  [
    "operation status",
    "operation get",
    "Show a standalone operation's progress",
  ],
  [
    "operation wait",
    "operation wait",
    "Wait for a standalone operation to finish",
  ],
] as const;

const operationsByCommand = new Map(
  commandOperations.map((operation) => [operation.command, operation]),
);

export const publicOperations = commands.map(
  ([command, internal, description]) => {
    const operation = operationsByCommand.get(internal);
    if (!operation) throw new Error(`Unknown catalog command '${internal}'.`);
    return { operation: { ...operation, command }, description };
  },
);

export function resolvePublicOperation(
  args: readonly string[],
): { operation: Operation; rest: string[] } | undefined {
  for (let count = args.length; count > 0; count--) {
    const operation = byPublicCommand.get(args.slice(0, count).join(" "));
    if (operation) return { operation, rest: args.slice(count) };
  }
  return undefined;
}

const byPublicCommand: ReadonlyMap<string, Operation> = new Map(
  publicOperations.map(({ operation }) => [operation.command, operation]),
);

export const commandGroups: Readonly<Record<string, string>> = {
  auth: "Show your identity or sign in to Borealis Cloud",
  cloud: "Manage Borealis Cloud accounts, hosts, and billing",
  image: "Build and manage VM images",
  network: "Manage Cloud private networks and services",
  operation: "Check long-running standalone operations",
  profile: "Manage local, SSH, and Cloud targets",
  supervisor: "Install and manage a standalone host",
  vm: "Create and manage virtual machines",
  "image registry": "Manage credentials for image registries",
  "network attachment": "Connect VMs to private networks",
  "network operation": "Track private network changes",
  "network service": "Manage services on private networks",
  "supervisor builder": "Install the local image builder",
  "supervisor cloud": "Connect this host to Borealis Cloud",
  "supervisor config": "Manage standalone host configuration",
  "supervisor update": "Check, plan, and apply signed host updates",
  "vm network": "Manage a Cloud VM's network settings",
  "vm operation": "Track Cloud VM operations",
  "vm port": "Access a service running in a VM",
  "vm session": "Manage interactive terminal sessions",
  "vm snapshot": "Manage VM snapshots",
  "vm workspace": "Import and export VM workspace files",
};

export const helpExamples: Readonly<Record<string, readonly string[]>> = {
  "": [
    "borealis status",
    "borealis doctor",
    "borealis vm create --name dev --image debian:trixie-slim --wait",
    "borealis vm list",
    "borealis image build --context . --wait",
    "borealis profile add lab --ssh lab-linux",
    "borealis --profile lab vm list",
  ],
  vm: [
    "borealis vm create --name dev --image debian:trixie-slim --wait",
    "borealis vm list",
    "borealis vm exec VM_ID --command uname --arg=-m",
    "borealis vm stop VM_ID --wait",
    "borealis vm delete VM_ID --wait",
  ],
  image: [
    "borealis image build --context . --dockerfile Dockerfile --wait",
    "borealis image list",
    "borealis image build status BUILD_ID",
  ],
  network: ["borealis --profile cloud network list"],
  profile: [
    "borealis profile add lab --ssh lab-linux",
    "borealis --profile lab vm list",
    "borealis profile use lab",
  ],
  supervisor: ["borealis status", "borealis doctor"],
};
