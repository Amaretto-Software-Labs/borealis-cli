import type { Operation } from "./types.js";

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = [...String(value)]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return result || undefined;
}

function list(value: unknown): unknown[] | undefined {
  return Array.isArray(value)
    ? value
    : Array.isArray(object(value)?.items)
      ? (object(value)?.items as unknown[])
      : undefined;
}

function table(headings: string[], rows: string[][]): string {
  return [headings.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n");
}

function vmImage(vm: ObjectValue): string | undefined {
  const image = text(vm.image);
  if (image) return image;
  const prepared = text(vm.runtimeTemplateId);
  const revision = text(vm.runtimeTemplateRevision);
  return prepared && revision ? `${prepared} (revision ${revision})` : prepared;
}

function vmList(value: unknown): string | undefined {
  const values = list(value);
  if (!values) return undefined;
  if (values.length === 0) return "No VMs found.";
  const rows: string[][] = [];
  for (const value of values) {
    const vm = object(value);
    const id = text(vm?.sandboxId);
    if (!id) return undefined;
    rows.push([
      id,
      text(vm?.name) ?? "-",
      text(vm?.status) ?? "-",
      vmImage(vm!) ?? "-",
    ]);
  }
  return table(["ID", "NAME", "STATUS", "IMAGE"], rows);
}

function vmDetails(value: unknown): string | undefined {
  const vm = object(value);
  const id = text(vm?.sandboxId);
  if (!id) return undefined;
  const lines = [`VM: ${id}`];
  for (const [label, field] of [
    ["Name", "name"],
    ["Status", "status"],
    ["Architecture", "guestArchitecture"],
  ]) {
    const value = text(vm?.[field!]);
    if (value) lines.push(`${label}: ${value}`);
  }
  const image = vmImage(vm!);
  if (image) lines.push(`Image: ${image}`);
  const resources = object(vm?.microVmResources);
  const vcpu = text(resources?.vcpu);
  const memory = text(resources?.memoryMiB);
  const disk = text(resources?.rootDiskGiB);
  if (vcpu) lines.push(`vCPUs: ${vcpu}`);
  if (memory) lines.push(`Memory: ${memory} MiB`);
  if (disk) lines.push(`Root disk: ${disk} GiB`);
  return lines.join("\n");
}

function operationReceipt(
  value: unknown,
  resourceLabel = "VM",
): string | undefined {
  const receipt = object(value);
  const id = text(receipt?.operationId);
  const status = text(receipt?.status);
  if (!id || !status) return undefined;
  const lines = [`Operation: ${id}`, `Status: ${status}`];
  const resource = text(receipt?.resourceId);
  if (resource) lines.push(`${resourceLabel}: ${resource}`);
  const vm = object(receipt?.result);
  const name = text(vm?.name);
  if (name) lines.push(`Name: ${name}`);
  const message = text(object(receipt?.error)?.message);
  if (message) lines.push(`Error: ${message}`);
  return lines.join("\n");
}

function imageList(value: unknown): string | undefined {
  const values = list(value);
  if (!values) return undefined;
  if (values.length === 0) return "No image builds found.";
  const rows: string[][] = [];
  for (const value of values) {
    const image = object(value);
    const id = text(image?.buildId);
    if (!id) return undefined;
    rows.push([
      id,
      text(image?.status) ?? "-",
      text(image?.resolvedImage) ?? text(image?.imageReference) ?? "-",
    ]);
  }
  return table(["BUILD ID", "STATUS", "SOURCE"], rows);
}

function imageBuild(value: unknown): string | undefined {
  const build = object(value);
  const id = text(build?.buildId);
  const status = text(build?.status);
  if (!id || !status) return undefined;
  const lines = [`Build: ${id}`, `Status: ${status}`];
  const source = text(build?.resolvedImage) ?? text(build?.imageReference);
  const image = text(build?.publishedTemplateId);
  const revision = text(build?.publishedTemplateRevision);
  const error = text(build?.failureMessage);
  if (source) lines.push(`Source: ${source}`);
  if (image) lines.push(`Image: ${image}`);
  if (revision) lines.push(`Revision: ${revision}`);
  if (error) lines.push(`Error: ${error}`);
  return lines.join("\n");
}

function preparedImages(value: unknown): string | undefined {
  const values = list(value);
  if (!values) return undefined;
  if (values.length === 0) return "No images found.";
  const rows: string[][] = [];
  for (const value of values) {
    const image = object(value);
    const id = text(image?.templateId);
    const revision = text(image?.revision);
    if (!id || !revision) return undefined;
    rows.push([
      id,
      revision,
      text(image?.architecture) ?? "-",
      typeof image?.ready === "boolean"
        ? image.ready
          ? "ready"
          : "not ready"
        : "-",
    ]);
  }
  return table(["IMAGE", "REVISION", "ARCHITECTURE", "STATUS"], rows);
}

function preparedImage(value: unknown): string | undefined {
  const image = object(value);
  const id = text(image?.templateId);
  const revision = text(image?.revision);
  if (!id || !revision) return undefined;
  const lines = [`Image: ${id}`, `Revision: ${revision}`];
  const architecture = text(image?.architecture);
  if (architecture) lines.push(`Architecture: ${architecture}`);
  if (typeof image?.ready === "boolean")
    lines.push(`Status: ${image.ready ? "ready" : "not ready"}`);
  return lines.join("\n");
}

function supervisorStatus(value: unknown): string | undefined {
  const status = object(value);
  if (typeof status?.healthy !== "boolean" || !text(status.hostId))
    return undefined;
  const lines = [
    `Status: ${status.healthy ? "healthy" : "unhealthy"}`,
    `Host: ${text(status.hostId)}`,
  ];
  const architecture =
    text(status.architecture) ?? text(object(status.runtime)?.architecture);
  if (architecture) lines.push(`Architecture: ${architecture}`);
  if (typeof status.builderEnabled === "boolean")
    lines.push(
      `Image builder: ${status.builderEnabled ? "enabled" : "disabled"}`,
    );
  return lines.join("\n");
}

/** Return a concise human view for known responses; unknown shapes remain untouched. */
export function formatPublicResult(
  operation: Operation,
  result: unknown,
): unknown {
  const id = operation.operationId;
  if (id === "sandbox.list") return vmList(result) ?? result;
  if (id === "sandbox.get") return vmDetails(result) ?? result;
  if (
    [
      "sandbox.create",
      "sandbox.start",
      "sandbox.stop",
      "sandbox.resume",
      "sandbox.pause",
      "sandbox.delete",
    ].includes(id)
  )
    return operationReceipt(result) ?? vmDetails(result) ?? result;
  if (id === "operation.get")
    return operationReceipt(result, "Resource") ?? result;
  if (id === "runtime_image_build.list") return imageList(result) ?? result;
  if (id === "runtime_image_template.list")
    return preparedImages(result) ?? result;
  if (
    id === "runtime_image_template.get" ||
    id === "runtime_image_template.stage"
  )
    return preparedImage(result) ?? result;
  if (
    [
      "runtime_image_build.create",
      "runtime_image_build.get",
      "runtime_image_build.cancel",
      "runtime_image_build.approve",
    ].includes(id)
  )
    return imageBuild(result) ?? operationReceipt(result, "Resource") ?? result;
  if (id === "supervisor.status") return supervisorStatus(result) ?? result;
  return result;
}
