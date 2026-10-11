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

  it("keeps local immutable proof unconditional and requires canonical proof for every actual publication", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const step = (name: string) =>
      workflow.split(`      - name: ${name}\n`)[1]!.split("      - ")[0]!;
    const local = step("Require immutable canonical catalog provenance");
    expect(local).toContain("catalog-provenance.mjs --revision");
    expect(local).not.toContain("if:");
    const gate =
      "if: ${{ vars.NPM_TRUSTED_PUBLISHING_ENABLED == 'true' || github.event_name == 'workflow_dispatch' }}";
    expect(step("Check out pinned canonical Borealis source")).toContain(gate);
    const source = step(
      "Verify both catalogs against the immutable canonical revision",
    );
    expect(source).toContain(gate);
    expect(source.indexOf("pnpm parity:canonical")).toBeLessThan(
      source.indexOf('echo "verified=true"'),
    );
    expect(workflow).toContain(
      "canonical_verified: ${{ steps.canonical_source.outputs.verified }}",
    );
    const publish = step("Publish with trusted provenance");
    expect(publish).toContain(
      "CANONICAL_SOURCE_VERIFIED: ${{ needs.package.outputs.canonical_verified }}",
    );
    expect(
      publish.indexOf('test "$CANONICAL_SOURCE_VERIFIED" = true'),
    ).toBeLessThan(publish.indexOf("npm publish"));
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
