import { z } from "zod";
import type { BorealisApiClient } from "./api-client.js";
import { resolvePublicOperation } from "./public-commands.js";
import { writeResult } from "./output.js";
import type {
  DirectTargetMetadata,
  SupervisorDiscovery,
} from "./supervisor-client.js";

const vmPageSize = 100;
const maxVmPages = 5;
const inventoryTimeoutMs = 8_000;
const displayLimit = 10;
const recentBuildLimit = 5;
const terminalBuilds = new Set(["ready", "failed", "canceled"]);
const vmList = resolvePublicOperation(["vm", "list"])!.operation;
const buildList = resolvePublicOperation(["image", "build", "list"])!.operation;
const text = z.string().min(1);
const count = z.number().int().nonnegative();
const vmSchema = z.object({
  sandboxId: text,
  name: z.string(),
  status: text,
  image: z.string().nullish(),
  runtimeTemplateId: z.string().nullish(),
  runtimeTemplateRevision: count.nullish(),
});
const vmPageSchema = z.object({
  page: count.positive(),
  pageSize: count.positive(),
  totalCount: count,
  items: z.array(vmSchema).max(vmPageSize),
});
const buildSchema = z.object({
  buildId: text,
  status: text,
  phase: z.string().nullish(),
  resolvedImage: z.string().nullish(),
  imageReference: z.string().nullish(),
  sourceKind: z.string().nullish(),
  failureCode: z.string().nullish(),
  failureMessage: z.string().nullish(),
  publishedTemplateId: z.string().nullish(),
  publishedTemplateRevision: count.nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
});
const buildListSchema = z.object({ items: z.array(buildSchema) });
const capacitySchema = z.object({
  totalVcpu: count.nullish(),
  totalMemoryMiB: count.nullish(),
  availableDiskMiB: count.nullish(),
});
const runtimeSchema = z.object({
  provider: z.string().nullish(),
  capacity: capacitySchema.nullish(),
});

type HostReader = Pick<BorealisApiClient, "supervisorRequest">;
type Vm = z.infer<typeof vmSchema>;
type Build = z.infer<typeof buildSchema>;

function hostSummary(discovery: SupervisorDiscovery) {
  const runtime = runtimeSchema.safeParse(discovery.runtime).data;
  return {
    hostId: discovery.hostId,
    architecture: discovery.architecture ?? null,
    releaseRevision:
      typeof discovery.releaseRevision === "string"
        ? discovery.releaseRevision
        : null,
    healthy: typeof discovery.healthy === "boolean" ? discovery.healthy : null,
    acceptingNewWork:
      typeof discovery.admissionClosed === "boolean"
        ? !discovery.admissionClosed
        : null,
    activeOperations: count.safeParse(discovery.activeOperations).data ?? null,
    provider: runtime?.provider ?? null,
    capacity: {
      totalVcpu: runtime?.capacity?.totalVcpu ?? null,
      totalMemoryMiB: runtime?.capacity?.totalMemoryMiB ?? null,
      availableDiskMiB: runtime?.capacity?.availableDiskMiB ?? null,
    },
  };
}

function errorText(error: unknown): string {
  if (error instanceof z.ZodError)
    return "The supervisor returned an invalid inventory response.";
  return error instanceof Error
    ? error.message
    : "Could not read the inventory.";
}

async function vmSummary(
  client: HostReader,
  discovery: SupervisorDiscovery,
  signal?: AbortSignal,
) {
  const rows = new Map<string, Vm>();
  let totalCount: number | null = null;
  let pageSize = vmPageSize;
  let coverage: "complete" | "partial" | "unavailable" = "unavailable";
  let limitReached = false;
  let error: string | null = null;
  const deadline = Date.now() + inventoryTimeoutMs;
  try {
    if (!discovery.operations.includes(vmList.operationId))
      throw new Error("VM inventory is unavailable on this supervisor.");
    for (let page = 1; page <= maxVmPages; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("Reading the VM inventory timed out.");
      const path = `${vmList.path}?${new URLSearchParams({ page: String(page), pageSize: String(vmPageSize) })}`;
      const current = vmPageSchema.parse(
        await client.supervisorRequest("GET", path, remaining),
      );
      if (page === 1) {
        totalCount = current.totalCount;
        pageSize = current.pageSize;
      }
      coverage = "partial";
      const expected = Math.min(
        pageSize,
        Math.max(0, current.totalCount - (page - 1) * pageSize),
      );
      if (
        current.page !== page ||
        current.pageSize !== pageSize ||
        current.pageSize > vmPageSize ||
        current.items.length !== expected ||
        current.totalCount !== totalCount
      )
        throw new Error(
          "The VM inventory changed during the scan. Retry for an updated count.",
        );
      for (const vm of current.items) rows.set(vm.sandboxId, vm);
      if (rows.size !== Math.min(page * pageSize, current.totalCount))
        throw new Error(
          "The VM inventory returned duplicate rows. Retry for an updated count.",
        );
      if (page * pageSize >= current.totalCount) {
        coverage = "complete";
        break;
      }
      limitReached = page === maxVmPages;
    }
  } catch (failure) {
    signal?.throwIfAborted();
    error = errorText(failure);
  }
  const stateCounts: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  const running: {
    vmId: string;
    name: string;
    image: string | null;
    imageRevision: number | null;
  }[] = [];
  for (const vm of rows.values()) {
    stateCounts[vm.status] = (stateCounts[vm.status] ?? 0) + 1;
    if (vm.status === "running" && running.length < displayLimit)
      running.push({
        vmId: vm.sandboxId,
        name: vm.name,
        image: vm.image ?? vm.runtimeTemplateId ?? null,
        imageRevision: vm.image ? null : (vm.runtimeTemplateRevision ?? null),
      });
  }
  return {
    coverage,
    totalCount,
    observedCount: rows.size,
    stateCounts,
    running,
    runningOmittedCount: (stateCounts.running ?? 0) - running.length,
    limitReached,
    error,
  };
}

function buildRow(build: Build) {
  return {
    buildId: build.buildId,
    status: build.status,
    phase: build.phase ?? null,
    source:
      build.resolvedImage ?? build.imageReference ?? build.sourceKind ?? null,
    publishedTemplateId: build.publishedTemplateId ?? null,
    publishedTemplateRevision: build.publishedTemplateRevision ?? null,
    failureCode: build.failureCode ?? null,
    failureMessage: build.failureMessage ?? null,
    updatedAt: build.updatedAt ?? build.createdAt ?? null,
  };
}

async function buildSummary(
  client: HostReader,
  discovery: SupervisorDiscovery,
  signal?: AbortSignal,
) {
  const enabled =
    typeof discovery.builderEnabled === "boolean"
      ? discovery.builderEnabled
      : null;
  const unavailable = {
    enabled,
    totalCount: null,
    activeCount: null,
    active: [],
    activeOmittedCount: 0,
    recent: [],
    recentOmittedCount: 0,
  };
  if (enabled === false)
    return { ...unavailable, coverage: "disabled" as const, error: null };
  try {
    if (!discovery.operations.includes(buildList.operationId))
      throw new Error(
        "Image build inventory is unavailable on this supervisor.",
      );
    const { items } = buildListSchema.parse(
      await client.supervisorRequest("GET", buildList.path, inventoryTimeoutMs),
    );
    if (new Set(items.map(({ buildId }) => buildId)).size !== items.length)
      throw new Error("Image build inventory returned duplicate rows.");
    const active: Build[] = [];
    const terminal: Build[] = [];
    for (const build of items) {
      const pending =
        !terminalBuilds.has(build.status) ||
        build.failureCode === "cleanup_unconfirmed";
      (pending ? active : terminal).push(build);
    }
    terminal.sort((left, right) => buildTime(right) - buildTime(left));
    return {
      enabled,
      coverage: "complete" as const,
      totalCount: items.length,
      activeCount: active.length,
      active: active.slice(0, displayLimit).map(buildRow),
      activeOmittedCount: Math.max(0, active.length - displayLimit),
      recent: terminal.slice(0, recentBuildLimit).map(buildRow),
      recentOmittedCount: Math.max(0, terminal.length - recentBuildLimit),
      error: null,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ...unavailable,
      coverage: "unavailable" as const,
      error: errorText(error),
    };
  }
}

function buildTime(build: Build): number {
  const time = Date.parse(build.updatedAt ?? build.createdAt ?? "");
  return Number.isFinite(time) ? time : -1;
}

type Overview = {
  host: ReturnType<typeof hostSummary>;
  vms: Awaited<ReturnType<typeof vmSummary>>;
  imageBuilds: Awaited<ReturnType<typeof buildSummary>>;
};

export async function writeHostOverview(
  client: HostReader,
  discovery: SupervisorDiscovery,
  target: DirectTargetMetadata,
  json: boolean,
  signal?: AbortSignal,
): Promise<number> {
  const [vms, imageBuilds] = await Promise.all([
    vmSummary(client, discovery, signal),
    buildSummary(client, discovery, signal),
  ]);
  const result = { host: hostSummary(discovery), vms, imageBuilds };
  writeResult(
    json
      ? { schemaVersion: 1, target, result }
      : formatOverview(result, target),
    json,
  );
  return vms.error || imageBuilds.error || result.host.healthy === false
    ? 1
    : 0;
}

function oneLine(value: string) {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("");
}

function showBuild(build: ReturnType<typeof buildRow>): string {
  const source = build.source ? ` | ${oneLine(build.source)}` : "";
  const phase =
    build.phase && build.phase !== build.status
      ? ` (${oneLine(build.phase.replaceAll("_", " "))})`
      : "";
  const cleanup =
    build.failureCode === "cleanup_unconfirmed"
      ? " | cleanup needs attention"
      : "";
  const failureMessage = build.failureMessage
    ? ` | ${oneLine(build.failureMessage)}`
    : "";
  const image = build.publishedTemplateId
    ? ` | image ${oneLine(build.publishedTemplateId)}${build.publishedTemplateRevision === null ? "" : ` revision ${build.publishedTemplateRevision}`}`
    : "";
  return `  ${oneLine(build.buildId)}  ${oneLine(build.status)}${phase}${source}${image}${cleanup}${failureMessage}`;
}

function formatOverview(
  { host, vms, imageBuilds }: Overview,
  target: DirectTargetMetadata,
): string {
  const { totalVcpu, totalMemoryMiB, availableDiskMiB } = host.capacity;
  const lines = [
    `Host ${oneLine(host.hostId)} (${target.type} profile '${target.profile}')`,
    `Health: ${host.healthy === null ? "unknown" : host.healthy ? "healthy" : "unhealthy"}`,
    `Release: ${oneLine(host.releaseRevision ?? "unknown")} | Architecture: ${host.architecture ?? "unknown"}`,
    `Accepting new work: ${host.acceptingNewWork === null ? "unknown" : host.acceptingNewWork ? "yes" : "no"}`,
    `Host capacity: ${totalVcpu ?? "unknown"} vCPU, ${totalMemoryMiB ?? "unknown"} MiB RAM | Disk available: ${availableDiskMiB ?? "unknown"} MiB`,
  ];
  if (host.activeOperations !== null)
    lines.push(`Active operations: ${host.activeOperations}`);
  lines.push("");
  if (vms.coverage === "unavailable")
    lines.push(
      `VM inventory unavailable. ${oneLine(vms.error ?? "")}`.trimEnd(),
    );
  else {
    const counts = Object.entries(vms.stateCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([state, total]) => `${total} ${oneLine(state.replaceAll("_", " "))}`,
      )
      .join(", ");
    lines.push(
      vms.coverage === "complete"
        ? `VMs: ${vms.totalCount}${counts ? ` (${counts})` : ""}`
        : `VMs observed: ${vms.observedCount}${vms.totalCount === null ? "" : ` of ${vms.totalCount} reported`}${counts ? ` (${counts})` : ""}. Inventory incomplete.`,
    );
    for (const vm of vms.running) {
      const image = vm.image
        ? ` | ${oneLine(vm.image)}${vm.imageRevision === null ? "" : ` revision ${vm.imageRevision}`}`
        : "";
      lines.push(`  ${oneLine(vm.name)}  ${oneLine(vm.vmId)}${image}`);
    }
    if (vms.runningOmittedCount)
      lines.push(
        `  ${vms.runningOmittedCount} more running. Use 'borealis vm list' for additional VMs.`,
      );
    if (vms.error) lines.push(oneLine(vms.error));
  }
  lines.push("");
  if (imageBuilds.coverage === "disabled")
    lines.push("Image builder is disabled.");
  else if (imageBuilds.coverage === "unavailable")
    lines.push(
      `Image build inventory unavailable. ${oneLine(imageBuilds.error ?? "")}`.trimEnd(),
    );
  else {
    lines.push(
      `Image builds: ${imageBuilds.activeCount} active, ${imageBuilds.totalCount} total`,
    );
    for (const build of imageBuilds.active) lines.push(showBuild(build));
    if (imageBuilds.activeOmittedCount)
      lines.push(`  ${imageBuilds.activeOmittedCount} more active.`);
    if (imageBuilds.recent.length)
      lines.push("Recent results", ...imageBuilds.recent.map(showBuild));
    if (imageBuilds.activeOmittedCount || imageBuilds.recentOmittedCount)
      lines.push("Use 'borealis image build list' for the full build history.");
  }
  return lines.join("\n");
}
