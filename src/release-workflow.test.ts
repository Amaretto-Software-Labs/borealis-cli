import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("passes dispatch inputs through the environment instead of shell source", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "RELEASE_REQUESTED_VERSION: ${{ github.event_name == 'workflow_dispatch' && inputs.version || '' }}",
    );
    expect(workflow).toContain(
      "RELEASE_CHANNEL: ${{ github.event_name == 'workflow_dispatch' && inputs.channel || 'dev' }}",
    );
    expect(workflow).toContain('requested="$RELEASE_REQUESTED_VERSION"');
    expect(workflow).toContain('channel="$RELEASE_CHANNEL"');
    expect(workflow).not.toMatch(/requested="\$\{\{/);
    expect(workflow).not.toMatch(/channel="\$\{\{/);
  });

  it("fails explicit publish intent instead of succeeding with disabled trusted publishing", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && vars.NPM_TRUSTED_PUBLISHING_ENABLED != 'true'",
    );
    expect(workflow).toContain("An explicit release requested publication");
    expect(workflow).toContain("exit 1");
    expect(workflow).toContain(
      "github.event_name != 'workflow_dispatch' && vars.NPM_TRUSTED_PUBLISHING_ENABLED != 'true'",
    );
  });

  it("validates the public package without private-source or Git ancestry requirements", async () => {
    for (const file of ["ci.yml", "release.yml"]) {
      const workflow = await readFile(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      expect(workflow).toContain("pnpm catalog:check");
      expect(workflow).toContain("pnpm test");
      expect(workflow).toContain("pnpm pack");
      expect(workflow).not.toContain("BOREALIS_CATALOG_READ_TOKEN");
      expect(workflow).not.toContain("catalog-provenance");
      expect(workflow).not.toContain("parity:canonical");
      expect(workflow).not.toContain(
        "repository: Amaretto-Software-Labs/borealis",
      );
    }
  });

  it("isolates packaging from the only provenance-enabled publish job", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const packageStart = workflow.indexOf("  package:\n");
    const publishStart = workflow.indexOf("  publish:\n");
    const packageJob = workflow.slice(packageStart, publishStart);
    const publishJob = workflow.slice(publishStart);

    expect(packageStart).toBeGreaterThan(0);
    expect(publishStart).toBeGreaterThan(packageStart);
    expect(packageJob).not.toContain("id-token: write");
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(publishJob).toContain("needs: package");
    expect(publishJob).toContain("actions/setup-node@v5");
    expect(publishJob).toContain('node-version: "24"');
    expect(publishJob).toContain("registry-url: https://registry.npmjs.org");
    expect(publishJob).toContain("package-manager-cache: false");
    expect(publishJob).not.toContain("npm install --global npm@");
    expect(publishJob).toContain("actions/download-artifact@v8");
    expect(publishJob).toContain("name: borealis-cli-npm-package");
    expect(publishJob).not.toMatch(
      /actions\/checkout|pnpm|npm (?:install|version|pack)|npm run/,
    );
    expect(publishJob).toContain(
      'npm publish "${tarballs[0]}" --ignore-scripts --access public --tag "${{ needs.package.outputs.tag }}"',
    );
    expect(publishJob).not.toContain("--provenance");
  });
});
