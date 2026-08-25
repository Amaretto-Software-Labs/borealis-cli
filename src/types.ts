import { z } from "zod";

export const operationSchema = z.object({
  operationId: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/api/v1/"),
  scope: z.string().min(1),
  risk: z.enum(["read", "write", "destructive", "credential", "stream"]),
  clientMethod: z.string().min(1),
  command: z.string().min(1),
  mcpName: z.string().min(1),
  ownership: z.enum(["subject", "subject-and-organization", "organization"]),
  idempotency: z.enum(["safe", "idempotency-key", "target-state", "none"]),
  retry: z.enum(["safe", "never-after-dispatch"]),
  paging: z.enum(["none", "page"]),
  requiresPreflight: z.boolean(),
});

export type Operation = z.infer<typeof operationSchema>;

export interface GlobalOptions {
  api: string;
  identity: string;
  app: string;
  profile: string;
  organization?: string;
  tokenFile?: string;
  token?: string;
  json: boolean;
  yes: boolean;
}

export const sessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.iso.datetime(),
  scope: z.string(),
  clientId: z.string().min(1),
  api: z.url(),
  identity: z.url(),
  app: z.url(),
  organization: z.string().min(1).optional(),
});

export type Session = z.infer<typeof sessionSchema>;
