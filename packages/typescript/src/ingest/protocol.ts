// The body an installation sends to a hub's /v1/feedback, shared by remoteStore and the hub.

import { z } from "zod";
import { submitFeedbackShapeFor } from "../tools.js";
import type { FeedbackRecord } from "../types.js";

export const INGEST_PATHS = {
  enroll: "/v1/enroll",
  feedback: "/v1/feedback",
  renew: "/v1/renew",
  githubStart: "/v1/signin/github/start",
  githubPoll: "/v1/signin/github/poll",
  wellKnown: "/.well-known/mcp-feedback",
} as const;

/** What a hub publishes at `<base>/.well-known/mcp-feedback`, so a client can find out what it offers. */
export interface HubMetadata {
  issuer: string;
  /** Paths relative to the hub's base URL. */
  endpoints: { enroll: string; feedback: string; renew: string };
  /** Ways to sign in, with their endpoints. Empty when the hub only takes anonymous installations and issued tokens. */
  signin: { github?: { start: string; poll: string } };
  install_token_ttl_seconds: number;
  user_token_ttl_seconds: number | null;
}

/** The most a hub reads of a request body. */
export const MAX_INGEST_BODY_BYTES = 64 * 1024;

/** How long a report may wait in an installation's queue, and so how old an id a hub accepts. */
export const MAX_QUEUE_AGE_DAYS = 30;

const reported = z.string().max(200).nullable().optional();

/**
 * What an installation sends: the submission, plus what the installation itself recorded. Every
 * field is the installation's own account; the hub stamps identity, project, status and time.
 */
export const ingestSubmissionSchema = z.object({
  ...submitFeedbackShapeFor(),
  /** The installation's id for the report, reused on every retry so the hub can tell a retry from a new report. */
  id: z.string().max(64).optional(),
  /** When the installation built the report. Kept for reference only; the hub records when it received it. */
  created_at: z.string().max(64).optional(),
  /** What the server's own attachContext hook recorded. */
  server_context: z.record(z.string(), z.unknown()).optional(),
  server_version: reported,
  client_name: reported,
  client_version: reported,
});

export type IngestSubmission = z.infer<typeof ingestSubmissionSchema>;

/** The wire form of a record built by registerFeedback in an installation. */
export function toIngestSubmission(record: FeedbackRecord): IngestSubmission {
  const { server_context, ...context } = record.context;
  return {
    id: record.id,
    created_at: record.created_at,
    kind: record.kind,
    title: record.title,
    body: record.body,
    severity: record.severity,
    tags: record.tags,
    context,
    ...(server_context ? { server_context } : {}),
    server_version: record.server.version,
    client_name: record.identity.client_name,
    client_version: record.identity.client_version,
  };
}

/** A hub's error body: `{ error: { code, message } }`. The message is written to be shown to an agent. */
export interface IngestErrorBody {
  error: { code: string; message: string };
}

/** Reads a token's claims without verifying them. Only for an installation's own bookkeeping (when to renew). */
export function unverifiedClaimsOf(token: string): { tier: string; iat: number; exp?: number; sub: string } | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof claims.tier !== "string" || typeof claims.iat !== "number" || typeof claims.sub !== "string") return null;
    return { tier: claims.tier, iat: claims.iat, sub: claims.sub, ...(typeof claims.exp === "number" ? { exp: claims.exp } : {}) };
  } catch {
    return null;
  }
}

/** Reads the project a token names without verifying it. Only for choosing where to keep local state. */
export function unverifiedProjectOf(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { prj?: unknown };
    return typeof claims.prj === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(claims.prj) ? claims.prj : null;
  } catch {
    return null;
  }
}
