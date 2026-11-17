import { createHash, createHmac } from "node:crypto";
import type { FeedbackIdentity } from "./types.js";

/**
 * The parts of the SDK's per-request `extra` argument that identity resolution
 * reads. Declared structurally so it accepts any SDK 1.x handler extra.
 */
export interface FeedbackRequestExtra {
  sessionId?: string;
  authInfo?: {
    token?: string;
    clientId?: string;
    scopes?: string[];
    extra?: Record<string, unknown>;
  };
  requestInfo?: {
    headers?: Record<string, string | string[] | undefined>;
  };
}

export interface ClientImplementation {
  name?: string;
  version?: string;
}

/**
 * Host hook for mapping a request onto an identity. Receives what the default
 * resolver found; returned fields override it.
 */
export type ResolveIdentity = (
  extra: FeedbackRequestExtra,
  defaults: FeedbackIdentity,
) => Partial<FeedbackIdentity> | Promise<Partial<FeedbackIdentity>>;

/**
 * A short, non-reversible label for a bearer token. The token itself is never stored.
 * With a key it is an HMAC, so a leaked table cannot be used to test guesses of weak tokens.
 */
export function fingerprintToken(token: string, key?: string): string {
  const hash = key ? createHmac("sha256", key) : createHash("sha256");
  return hash.update(token).digest("hex").slice(0, 16);
}

const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function defaultResolveIdentity(
  extra: FeedbackRequestExtra,
  client?: ClientImplementation,
  fingerprintKey?: string,
): FeedbackIdentity {
  const auth = extra.authInfo;
  const userAgent = extra.requestInfo?.headers?.["user-agent"];
  return {
    subject: stringOrNull(auth?.extra?.sub) ?? stringOrNull(auth?.extra?.subject),
    client_id: stringOrNull(auth?.clientId),
    session_id: stringOrNull(extra.sessionId),
    token_fingerprint: auth?.token ? fingerprintToken(auth.token, fingerprintKey) : null,
    scopes: [...(auth?.scopes ?? [])],
    client_name: stringOrNull(client?.name),
    client_version: stringOrNull(client?.version),
    user_agent: stringOrNull(Array.isArray(userAgent) ? userAgent[0] : userAgent),
  };
}
