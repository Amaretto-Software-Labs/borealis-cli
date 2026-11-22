export interface DurableReference {
  kind: "build" | "operation";
  id: string;
}

const terminalLabels: Readonly<Record<string, string>> = {
  ready: "Image is ready",
  succeeded: "Operation completed",
  completed: "Operation completed",
  failed: "Failed",
  canceled: "Canceled",
  cancelled: "Canceled",
  reconciliation_required: "Needs attention. The final state is uncertain",
  repair_required: "Needs repair",
  rolled_back: "Rolled back",
  awaiting_approval: "Build finished testing and is awaiting approval",
};

const phaseLabels: Readonly<Record<string, string>> = {
  queued: "Queued",
  scheduling: "Scheduling a builder",
  resolving: "Resolving build inputs",
  resolving_image: "Preparing the VM's source image",
  assembling: "Starting the isolated image builder",
  assembly_import: "Sending inputs to the isolated builder",
  assembly_execute: "Building and preparing the image",
  assembly_export: "Retrieving the assembled image",
  validating: "Validating the image",
  assessment_archive: "Packaging the image for testing",
  assessment_import: "Sending the image to the isolated assessment VM",
  assessment_execute: "Testing the image in isolation",
  assessment_filesystem_check: "Checking the image filesystem",
  assessment_filesystem_extract: "Extracting the filesystem for assessment",
  assessment_inventory: "Checking packages and files in the image",
  assessment_malware: "Scanning for malware",
  assessment_sbom: "Generating the software inventory",
  assessment_export: "Retrieving assessment results",
  assessment_verify: "Verifying assessment results",
  boot_qualification: "Testing that the image boots",
  uploading: "Storing the verified image artifacts",
  cloud_validation: "Validating the image for Cloud publication",
  cached: "Using a verified image already on the host",
  publishing: "Making the prepared image available",
  image_prepared: "Image prepared",
  starting: "Starting the VM",
  stopping: "Stopping the VM",
  deleting: "Deleting the VM",
  pausing: "Pausing the VM",
  resuming: "Resuming the VM",
  rehydrating: "Restoring the VM from a checkpoint",
  checkpointing_local: "Saving a VM checkpoint",
  cancelling: "Canceling the build",
  canceling: "Canceling the build",
};

export function isTerminalStatus(status: string): boolean {
  return Object.hasOwn(terminalLabels, status);
}

function progressInterval(): number {
  return process.stderr.isTTY ? 10_000 : 20_000;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}h ` : ""}${minutes || hours ? `${minutes}m ` : ""}${seconds % 60}s`;
}

function safeLine(value: string): string {
  return [...value.slice(0, 400)]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("")
    .trim();
}

function phaseLabel(
  stage: string,
  kind: DurableReference["kind"],
  assembly: "oci" | "build" | undefined,
): string {
  const phase = stage.toLowerCase().replace(/\s+/gu, "_");
  if (phase === "assembly_execute" && assembly === "oci")
    return "Pulling and preparing the registry image";
  if (phase === "starting" && kind === "build")
    return "Starting the image builder";
  if (Object.hasOwn(phaseLabels, phase)) return phaseLabels[phase]!;
  return `Supervisor phase: ${safeLine(stage.replaceAll("_", " "))}`;
}

export function followCommand(
  reference: DurableReference,
  profile?: string,
): string {
  const verb =
    reference.kind === "build" ? "image build status" : "operation wait";
  return `borealis${profile ? ` --profile ${profile}` : ""} ${verb} ${reference.id}${reference.kind === "build" ? " --wait" : ""}`;
}

export function observeProgress(
  reference: DurableReference,
  assembly?: "oci" | "build",
  now: () => number = () => performance.now(),
): (
  status: string,
  stage: string,
  detail?: string,
  observedAssembly?: "oci" | "build",
) => void {
  const start = now();
  let phaseStarted = start;
  let lastLine = start;
  let previousState: { status: string; stage: string } | undefined;
  const prefix = `${reference.kind === "build" ? "Build" : "Operation"} ${reference.id}`;
  return (status, stage, detail, observedAssembly) => {
    const time = now();
    const changed =
      status !== previousState?.status || stage !== previousState?.stage;
    if (!changed && time - lastLine < progressInterval()) return;
    if (changed) phaseStarted = time;
    const terminal = isTerminalStatus(status);
    const title = terminal
      ? terminalLabels[status]!
      : phaseLabel(stage, reference.kind, observedAssembly ?? assembly);
    const message = detail ? safeLine(detail) : "";
    const timer = changed
      ? `elapsed ${elapsed(time - start)}`
      : `elapsed ${elapsed(time - start)}, phase observed for ${elapsed(time - phaseStarted)}`;
    process.stderr.write(
      `${prefix}: ${changed ? "" : "Still reported by the supervisor — "}${title} (${timer})${terminal && message ? `. ${message}` : ""}\n`,
    );
    previousState = { status, stage };
    lastLine = time;
  };
}

export function formatInputBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function observeInput(label: string, totalBytes?: number) {
  const start = performance.now();
  let bytes = 0;
  const report = () => {
    const processed = formatInputBytes(bytes);
    const state =
      totalBytes === undefined
        ? `${processed} prepared`
        : bytes === totalBytes
          ? `${processed} read for upload, waiting for supervisor verification`
          : `${processed} of ${formatInputBytes(totalBytes)} read for upload`;
    process.stderr.write(
      `${label} (${elapsed(performance.now() - start)} elapsed, ${state}).\n`,
    );
  };
  process.stderr.write(
    `${label}${totalBytes === undefined ? "" : ` (${formatInputBytes(totalBytes)})`}.\n`,
  );
  const timer = setInterval(report, progressInterval()).unref();
  return {
    bytesProcessed(count: number) {
      bytes = count;
    },
    finish(message: string) {
      clearInterval(timer);
      process.stderr.write(
        `${message} (${elapsed(performance.now() - start)} elapsed).\n`,
      );
    },
    close() {
      clearInterval(timer);
    },
  };
}
