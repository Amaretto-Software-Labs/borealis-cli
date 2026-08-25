import { homedir } from "node:os";
import { join } from "node:path";
import { operations } from "./catalog.js";

const protocolScopes = ["openid", "profile", "email", "offline_access"];
const explicitPrivilegeScopes = new Set([
  "borealis.billing.manage",
  "borealis.billing.write",
  "borealis.hosts.manage",
  "borealis.service-principals.manage",
]);
const publicOperationScopes = [
  ...new Set(operations.map(({ scope }) => scope)),
];
const allowedLoginScopes = new Set([
  ...protocolScopes,
  ...publicOperationScopes,
]);
const defaultScope = [...protocolScopes, ...publicOperationScopes]
  .filter((scope) => !explicitPrivilegeScopes.has(scope))
  .filter((scope, index, scopes) => scopes.indexOf(scope) === index)
  .join(" ");

export const defaults = {
  api: "https://api.borealishq.io",
  identity: "https://identity.borealishq.io",
  app: "https://app.borealishq.io",
  clientId: "borealis-saas-cli",
  redirectUri: "http://127.0.0.1:17890/callback/",
  scope: defaultScope,
} as const;

export const configDirectory =
  process.env.BOREALIS_CONFIG_HOME ?? join(homedir(), ".config", "borealis");

export function validateOrigin(value: string, label: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      `${label} must be an HTTPS origin without a path, credentials, query, or fragment. HTTP is allowed only for loopback development.`,
    );
  }
  return url.origin;
}

export function validateLoginScope(value: string): string {
  const scopes = value.split(/\s+/).filter(Boolean);
  if (!scopes.length) throw new Error("OAuth scope must not be empty.");
  const unsupported = scopes.find((scope) => !allowedLoginScopes.has(scope));
  if (unsupported)
    throw new Error(
      `OAuth scope '${unsupported}' is not used by the public Borealis CLI.`,
    );
  return [...new Set(scopes)].join(" ");
}
