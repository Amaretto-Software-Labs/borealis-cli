import { describe, expect, it } from "vitest";
import { defaults, validateLoginScope, validateOrigin } from "./config.js";

describe("origin validation", () => {
  it("uses the registered native client and a non-privileged default scope", () => {
    expect(defaults.clientId).toBe("borealis-saas-cli");
    expect(defaults.redirectUri).toBe("http://127.0.0.1:17890/callback/");
    expect(defaults.scope).toContain("offline_access");
    expect(defaults.scope).not.toMatch(
      /admin|billing\.write|hosts\.manage|service-principals\.manage/,
    );
  });

  it("allows only protocol and public-operation scopes", () => {
    expect(() => validateLoginScope("openid borealis.internal.manage")).toThrow(
      "not used by the public Borealis CLI",
    );
    expect(validateLoginScope("openid borealis.billing.write")).toBe(
      "openid borealis.billing.write",
    );
  });
  it("allows HTTPS and loopback HTTP origins", () => {
    expect(validateOrigin("https://api.borealishq.io", "API")).toBe(
      "https://api.borealishq.io",
    );
    expect(validateOrigin("http://localhost:8385", "API")).toBe(
      "http://localhost:8385",
    );
  });

  it.each([
    "http://example.com",
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?q=1",
  ])("rejects unsafe origin %s", (origin) => {
    expect(() => validateOrigin(origin, "API")).toThrow();
  });
});
