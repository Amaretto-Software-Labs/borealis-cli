import { describe, expect, it } from "vitest";
import { operations } from "./catalog.js";
import { standaloneOperations } from "./standalone-catalog.js";
import { formatPublicResult } from "./public-output.js";
import type { Operation } from "./types.js";

function operation(id: string): Operation {
  const item = [...operations, ...standaloneOperations].find(
    (op) => op.operationId === id,
  );
  if (!item) throw new Error(`Missing catalog operation ${id}`);
  return item;
}

describe("human public output", () => {
  it("labels VM inventory and reports empty lists", () => {
    const op = operation("sandbox.list");
    expect(formatPublicResult(op, { items: [] })).toBe("No VMs found.");
    expect(
      formatPublicResult(op, {
        items: [
          {
            sandboxId: "vm-1",
            name: "dev",
            status: "running",
            image: "debian:stable",
          },
        ],
      }),
    ).toBe("ID\tNAME\tSTATUS\tIMAGE\nvm-1\tdev\trunning\tdebian:stable");
  });

  it("shows a durable VM receipt without leaking the internal operation name", () => {
    const result = formatPublicResult(operation("sandbox.create"), {
      operationId: "op-1",
      operation: "sandbox.create",
      resourceId: "vm-1",
      status: "succeeded",
      result: { sandboxId: "vm-1", name: "dev", runtimeKind: "microvm" },
    });
    expect(result).toBe(
      "Operation: op-1\nStatus: succeeded\nVM: vm-1\nName: dev",
    );
  });

  it("shows actual VM resources without internal runtime metadata", () => {
    expect(
      formatPublicResult(operation("sandbox.get"), {
        sandboxId: "vm-1",
        name: "dev",
        status: "running",
        guestArchitecture: "x86_64",
        microVmResources: { vcpu: 2, memoryMiB: 4096, rootDiskGiB: 20 },
        runtimeKind: "microvm",
      }),
    ).toBe(
      "VM: vm-1\nName: dev\nStatus: running\nArchitecture: x86_64\nvCPUs: 2\nMemory: 4096 MiB\nRoot disk: 20 GiB",
    );
  });

  it("shows a prepared image revision when a VM has no OCI source", () => {
    const vm = {
      sandboxId: "vm-1",
      name: "dev",
      status: "running",
      image: null,
      runtimeTemplateId: "native-image-builder",
      runtimeTemplateRevision: 1,
    };
    expect(
      formatPublicResult(operation("sandbox.list"), { items: [vm] }),
    ).toContain("native-image-builder (revision 1)");
    expect(formatPublicResult(operation("sandbox.get"), vm)).toContain(
      "Image: native-image-builder (revision 1)",
    );
  });

  it("shows real image build failures and source, without internal phase names", () => {
    const result = formatPublicResult(operation("runtime_image_build.get"), {
      buildId: "build-1",
      status: "failed",
      phase: "runtime_image_source_pull_failed",
      resolvedImage: "docker.io/library/debian@sha256:abc",
      failureMessage: "Could not pull source image.",
    });
    expect(result).toBe(
      "Build: build-1\nStatus: failed\nSource: docker.io/library/debian@sha256:abc\nError: Could not pull source image.",
    );
  });

  it("renders prepared images and the published build revision", () => {
    expect(
      formatPublicResult(operation("runtime_image_template.list"), {
        items: [],
      }),
    ).toBe("No images found.");
    expect(
      formatPublicResult(operation("runtime_image_template.list"), {
        items: [
          {
            templateId: "native-image-builder",
            revision: 1,
            architecture: "x86_64",
            ready: true,
          },
        ],
      }),
    ).toBe(
      "IMAGE\tREVISION\tARCHITECTURE\tSTATUS\nnative-image-builder\t1\tx86_64\tready",
    );
    expect(
      formatPublicResult(operation("runtime_image_build.get"), {
        buildId: "build-1",
        status: "ready",
        publishedTemplateId: "image-1",
        publishedTemplateRevision: 2,
      }),
    ).toBe("Build: build-1\nStatus: ready\nImage: image-1\nRevision: 2");
  });

  it("uses the actual supervisor discovery health fields", () => {
    expect(
      formatPublicResult(operation("supervisor.status"), {
        hostId: "host-1",
        healthy: true,
        architecture: "x86_64",
        builderEnabled: true,
      }),
    ).toBe(
      "Status: healthy\nHost: host-1\nArchitecture: x86_64\nImage builder: enabled",
    );
  });

  it("leaves unknown payloads and execution streams untouched", () => {
    const unknown = { unusual: "shape" };
    expect(formatPublicResult(operation("sandbox.get"), unknown)).toBe(unknown);
    const exec = {
      status: "succeeded",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "warning\n",
    };
    expect(formatPublicResult(operation("sandbox.exec.transient"), exec)).toBe(
      exec,
    );
  });
});
