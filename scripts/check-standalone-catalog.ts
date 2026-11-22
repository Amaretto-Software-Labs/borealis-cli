import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { commandOperations } from "../src/catalog.js";
import { prepareRequest } from "../src/invocation.js";
import { prepareLocalBuild } from "../src/supervisor-client.js";
import type { Operation } from "../src/types.js";

const source =
  process.argv.find((arg) => arg.startsWith("--source="))?.slice(9) ??
  process.env.BOREALIS_SOURCE_ROOT;
if (!source)
  throw new Error(
    "Set BOREALIS_SOURCE_ROOT or specify --source=/path/to/borealis.",
  );

const backend = resolve(source, "backend");
const supervisor = join(backend, "Borealis.MicroVm.Supervisor", "Standalone");
const readSupervisor = (file: string) =>
  readFile(join(supervisor, file), "utf8");

const entries = [
  { file: "StandaloneEndpoints.cs", scopes: { app: "" } },
  {
    file: "StandaloneEndpoints.Guest.cs",
    scopes: { routes: "/api/v1/sandboxes" },
  },
  {
    file: "StandaloneEndpoints.Interactive.cs",
    scopes: { api: "/api/v1", sandboxes: "/api/v1/sandboxes" },
  },
  { file: "StandaloneEndpoints.Templates.cs", scopes: { api: "/api/v1" } },
  { file: "Images/LocalImageEndpoints.cs", scopes: { endpoints: "" } },
];
const documents = await Promise.all(
  entries.map(({ file }) => readSupervisor(file)),
);

const declaration = documents[0]?.match(
  /string\[\]\s+Operations\s*=\s*\[([\s\S]*?)\];/,
)?.[1];
if (!declaration)
  throw new Error("Cannot read standalone capability declarations.");
const advertised = [...declaration.matchAll(/"([^"]+)"/g)].map(
  (match) => match[1]!,
);
if (new Set(advertised).size !== advertised.length)
  throw new Error("Duplicate standalone capability IDs.");

function signature(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}").replace(/\/$/, "")}`;
}

const mapped = new Set<string>();
for (const [index, { file, scopes }] of entries.entries()) {
  const routes = new Map(Object.entries(scopes) as [string, string][]);
  const text = documents[index]!;
  for (const match of text.matchAll(
    /var\s+(\w+)\s*=\s*(\w+)\.MapGroup\("([^"]*)"\)/g,
  )) {
    const parent = routes.get(match[2]!);
    if (parent === undefined)
      throw new Error(`Undeclared route scope ${match[2]} in ${file}.`);
    routes.set(match[1]!, parent + match[3]);
  }
  for (const match of text.matchAll(
    /(\w+)\.Map(Get|Post|Put|Patch|Delete)\("([^"]*)"/g,
  )) {
    const prefix = routes.get(match[1]!);
    if (prefix === undefined)
      throw new Error(`Unknown endpoint scope ${match[1]} in ${file}.`);
    mapped.add(signature(match[2]!, prefix + match[3]));
  }
  for (const match of text.matchAll(
    /MapLifecycle\((\w+),\s*"([A-Z]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g,
  )) {
    const prefix = routes.get(match[1]!);
    if (prefix === undefined || !advertised.includes(match[4]!))
      throw new Error(`Unadvertised lifecycle route in ${file}.`);
    mapped.add(signature(match[2]!, prefix + match[3]));
  }
}

const transport: Partial<Record<string, [string, string]>> = {
  "preflight.create": ["POST", "/api/v1/preflights"],
  "supervisor.artifacts.upload": [
    "PUT",
    "/api/v1/supervisor/artifacts/{sha256}",
  ],
};
for (const id of Object.keys(transport))
  if (!advertised.includes(id))
    throw new Error(`Supervisor omitted required transport ${id}.`);

const projected = new Set<string>();
for (const id of advertised) {
  if (id.startsWith("admin."))
    throw new Error(
      `Private admin route ${id} cannot enter the standalone catalog.`,
    );
  const commands = commandOperations.filter(
    (operation) => operation.operationId === id,
  );
  const internal = transport[id];
  if (!commands.length && !internal)
    throw new Error(
      `No client contract for advertised standalone operation ${id}.`,
    );
  const paths = commands.map((operation) =>
    signature(operation.method, operation.path),
  );
  if (internal) paths.push(signature(...internal));
  for (const path of paths) {
    if (!mapped.has(path))
      throw new Error(
        `${id} advertises ${path}, which the supervisor does not map.`,
      );
    projected.add(path);
  }
}
for (const path of mapped)
  if (!projected.has(path))
    throw new Error(
      `Supervisor maps ${path} without a discoverable client contract.`,
    );

function operation(id: string): Operation {
  const found = commandOperations.find(
    (candidate) => candidate.operationId === id,
  );
  if (!found) throw new Error(`Missing CLI operation ${id}.`);
  return found;
}

function recordContract(text: string, name: string): string {
  const fields = text.match(
    new RegExp(`record ${name}\\(([\\s\\S]*?)\\)\\s*[;{]`),
  )?.[1];
  if (!fields) throw new Error(`Cannot read constructor contract for ${name}.`);
  return fields + ")";
}

function matchesFields(body: unknown, contract: string, name: string): void {
  if (body === null || typeof body !== "object")
    throw new Error(`Missing request body for ${name}.`);
  for (const key of Object.keys(body)) {
    const field = key[0]!.toUpperCase() + key.slice(1);
    if (!new RegExp(`\\b${field}\\s*[=,)]`).test(contract))
      throw new Error(`CLI sends ${key}, which is absent from ${name}.`);
  }
}

const create = await prepareRequest(
  operation("sandbox.create"),
  [
    "--name",
    "contract-check",
    "--image",
    "ubuntu:24.04",
    "--checkpoint-policy",
    "AgentTurn",
    "--enable-nested-containers",
    "--vcpu",
    "2",
    "--memory-mib",
    "1024",
    "--root-disk",
    "8",
  ],
  undefined,
  true,
);
const createSource = await readSupervisor("StandaloneCreateRequest.cs");
const runtime = (create.body as { runtime: unknown }).runtime;
matchesFields(
  create.body,
  recordContract(createSource, "StandaloneCreateRequest"),
  "StandaloneCreateRequest",
);
matchesFields(
  runtime,
  recordContract(createSource, "StandaloneRuntimeRequest"),
  "StandaloneRuntimeRequest",
);

const plan = await prepareRequest(
  operation("runtime_image_build.create"),
  ["--image", "ubuntu:24.04"],
  undefined,
  true,
);
const build = await prepareLocalBuild(
  plan,
  {
    socket: "",
    fetch: async () => {
      throw new Error("OCI build preparation must skip context upload.");
    },
    close: async () => {},
  },
  {
    hostId: "contract-check",
    apiVersion: 1,
    operations: [],
    architecture: "aarch64",
  },
);
const buildSource = await readSupervisor("Images/LocalImageBuildStore.cs");
matchesFields(
  build.body,
  recordContract(buildSource, "LocalImageBuildRequest"),
  "LocalImageBuildRequest",
);

const stage = await prepareRequest(
  operation("runtime_image_template.stage"),
  ["template", "1", "--vcpu", "2", "--memory-mib", "1024", "--root-disk", "8"],
  undefined,
  true,
);
const stageSource = await readFile(
  join(
    backend,
    "Borealis.Api.Contracts",
    "V1",
    "RuntimeImageBuildContracts.cs",
  ),
  "utf8",
);
matchesFields(
  stage.body,
  recordContract(stageSource, "RuntimeImageStageRequest"),
  "RuntimeImageStageRequest",
);

process.stdout.write(
  `Verified ${advertised.length} standalone capability mappings, ${mapped.size} supervisor routes, and create/build/stage DTO fields.\n`,
);
