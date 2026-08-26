import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  oauthCallbackResponseHeaders,
  renderOAuthCallbackPage,
} from "./auth.js";

describe("OAuth callback page", () => {
  it("renders a self-contained Borealis-styled success page", () => {
    const html = renderOAuthCallbackPage("success");

    expect(html).toContain("Authorization complete");
    expect(html).toContain("CLI session authorized");
    expect(html).toContain("Borealis CLI is connected");
    expect(html).toContain('class="brand-mark"');
    expect(html).toContain("--color-bg: #06131f");
    expect(html).toContain("--color-accent: #38f5c8");
    expect(html).toContain('role="status"');
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/<script|https?:\/\//);
  });

  it.each([
    ["invalid" as const, "Invalid authorization response"],
    ["failed" as const, "Authorization incomplete"],
  ])("renders a branded %s callback failure", (kind, title) => {
    const html = renderOAuthCallbackPage(kind);

    expect(html).toContain(title);
    expect(html).toContain("CLI session not authorized");
    expect(html).toContain('role="alert"');
    expect(html).toContain("borealis auth login");
  });

  it("allows only the exact embedded stylesheet through CSP", () => {
    const html = renderOAuthCallbackPage("success");
    const style = html.match(/<style>([\s\S]+)<\/style>/)?.[1];

    expect(style).toBeDefined();
    const hash = createHash("sha256").update(style!, "utf8").digest("base64");
    expect(oauthCallbackResponseHeaders["content-type"]).toBe(
      "text/html; charset=utf-8",
    );
    expect(oauthCallbackResponseHeaders["content-security-policy"]).toContain(
      `style-src 'sha256-${hash}'`,
    );
    expect(
      oauthCallbackResponseHeaders["content-security-policy"],
    ).not.toContain("unsafe-inline");
  });
});
