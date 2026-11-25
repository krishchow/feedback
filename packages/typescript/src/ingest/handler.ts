// The ingest hub (spec/ingest.md): accepts feedback from installations of a distributed MCP server
// and writes it into an ordinary store, which the reader tools and CLI then read as usual.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fingerprintToken } from "../identity.js";
import { FeedbackInputError } from "../reader.js";
import { buildRecord, DEFAULT_FEEDBACK_LIMITS, validateSubmission, type FeedbackLimits } from "../register.js";
import type { FeedbackStore } from "../store.js";
import type { FeedbackIdentity, FeedbackRecord } from "../types.js";
import { GitHubError, pollDeviceFlow, signedInUser, startDeviceFlow, type GitHubSignInOptions } from "./github.js";
import {
  INGEST_PATHS,
  ingestSubmissionSchema,
  MAX_INGEST_BODY_BYTES,
  MAX_QUEUE_AGE_DAYS,
  type HubMetadata,
  type IngestErrorBody,
  type IngestSubmission,
} from "./protocol.js";
import { ANY_PROJECT, issueToken, isValidProjectName, TokenError, verifyToken, type Keyring, type TokenClaims, type TokenTier } from "./tokens.js";

export interface IngestQuotas {
  /** Reports one installation may file in 24 hours. */
  perInstallPerDay: number;
  /** Reports one holder of an issued token may file in 24 hours. */
  perIssuedSubjectPerDay: number;
  /** Reports a project accepts in 24 hours, from everyone together. */
  perProjectPerDay: number;
  /** Enrolments one network address may make in an hour. Kept in this process's memory only. */
  enrollPerAddressPerHour: number;
}

export const DEFAULT_INGEST_QUOTAS: IngestQuotas = {
  perInstallPerDay: 20,
  perIssuedSubjectPerDay: 200,
  perProjectPerDay: 500,
  enrollPerAddressPerHour: 20,
};

export interface IngestProject {
  /** Write this project somewhere other than the hub's shared store, e.g. a table its server already reads. */
  store?: FeedbackStore;
  quotas?: Partial<IngestQuotas>;
}

export interface IngestOptions {
  /** This hub's identity, usually its public URL. Tokens must name it as `iss`. */
  issuer: string;
  /** The keys whose tokens are accepted, and the key install tokens are signed with. */
  keyring: Keyring;
  /**
   * Where feedback is written. One store holds every project: each record's `server.name` is the
   * project its token names, so readers can take one project (the `server` filter) or all of them.
   * Required unless every project in `projects` has a store of its own.
   */
  store?: FeedbackStore;
  /**
   * Leave out to accept every project the keyring signed tokens for: a new server needs only a
   * project key, no change here. Give it to accept only the projects listed, or to set a project's
   * own store or quotas.
   */
  projects?: Record<string, IngestProject>;
  quotas?: Partial<IngestQuotas>;
  limits?: Partial<FeedbackLimits>;
  /** How long an install token, and a signed-in person's per-project token, lasts. Default 30 days; installations renew them. */
  installTokenTtlSeconds?: number;
  /**
   * Let people sign in with GitHub, so their reports carry `github:<login>` instead of an anonymous
   * installation id. Needs a GitHub OAuth app with device flow enabled, and a signing key.
   */
  github?: GitHubSignInOptions;
  /** Return true to refuse a token, e.g. by its `jti` or its `sub`. Checked on every request. */
  isRevoked?: (claims: TokenClaims) => boolean | Promise<boolean>;
  /**
   * Return false to refuse an enrolment, for limits that must hold across processes. The built-in
   * per-address limit still applies.
   */
  allowEnrollment?: (request: { project: string; clientAddress: string | null }) => boolean | Promise<boolean>;
  /** Last chance to scrub a record before it is stored. */
  redact?: (record: FeedbackRecord) => FeedbackRecord | Promise<FeedbackRecord>;
  /** Secret for HMAC token fingerprints, as in registerFeedback. */
  tokenFingerprintKey?: string;
  /** Mount point, e.g. `"/ingest"`. The routes are `<basePath>/v1/enroll` and `<basePath>/v1/feedback`. */
  basePath?: string;
  /** Called with unexpected errors, for the host's logger. */
  onError?: (error: unknown) => void;
}

/** What a host knows about a request that a web Request does not carry. */
export interface IngestRequestInfo {
  clientAddress?: string | null;
}

export type IngestHandler = (request: Request, info?: IngestRequestInfo) => Promise<Response>;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function errorResponse(error: HttpError): Response {
  const body: IngestErrorBody = { error: { code: error.code, message: error.message } };
  return json(error.status, body, error.headers);
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  if (!match) throw new HttpError(401, "unauthorized", "Send the token as Authorization: Bearer <token>.");
  return match[1]!;
}

/** Reads at most `max` bytes of the body, refusing more without reading it all. */
async function readBody(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (declared > max) throw new HttpError(413, "payload_too_large", `The request is larger than ${max} bytes.`);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new HttpError(413, "payload_too_large", `The request is larger than ${max} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** An installation's id is kept only if it is a UUIDv7 from no longer ago than a queue can hold a report. */
function acceptableId(id: string | undefined, now: number): string | undefined {
  if (id === undefined || !UUIDV7.test(id)) return undefined;
  const time = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
  return time > now - MAX_QUEUE_AGE_DAYS * DAY_MS && time < now + 5 * 60 * 1000 ? id : undefined;
}

/** In-memory sliding window: process-local, so a host running several instances should add allowEnrollment. */
function windowLimiter(windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, limit: number): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((time) => time > now - windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) {
      for (const [entry, times] of hits) if (!times.some((time) => time > now - windowMs)) hits.delete(entry);
    }
    return true;
  };
}

export function createIngestHandler(options: IngestOptions): IngestHandler {
  for (const [name, project] of Object.entries(options.projects ?? {})) {
    if (!isValidProjectName(name)) throw new Error(`Invalid project name: ${name}`);
    if (!project.store && !options.store) throw new Error(`Project ${name} has no store, and there is no shared store.`);
  }
  if (!options.store && !options.projects) throw new Error("Give a store, or projects with stores of their own.");
  if (!options.keyring.keys.length) throw new Error("The keyring needs at least one verification key.");
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const limits = { ...DEFAULT_FEEDBACK_LIMITS, ...options.limits };
  const installTtl = options.installTokenTtlSeconds ?? 30 * 24 * 60 * 60;
  const userTtl = options.github?.userTokenTtlSeconds ?? 180 * 24 * 60 * 60;
  const enrollLimiter = windowLimiter(60 * 60 * 1000);
  const quotasFor = (project: string): IngestQuotas => ({ ...DEFAULT_INGEST_QUOTAS, ...options.quotas, ...options.projects?.[project]?.quotas });
  /** The store a project's feedback goes to, or undefined when this hub does not take that project. */
  const storeFor = (project: string): FeedbackStore | undefined => {
    if (!options.projects) return options.store;
    const entry = options.projects[project];
    return entry ? (entry.store ?? options.store) : undefined;
  };

  const authenticate = async (request: Request, tiers: readonly TokenTier[]) => {
    const token = bearer(request);
    let claims: TokenClaims;
    try {
      claims = verifyToken(token, options.keyring, { issuer: options.issuer, tiers });
    } catch (error) {
      if (error instanceof TokenError) throw new HttpError(401, "unauthorized", error.message);
      throw error;
    }
    if (await options.isRevoked?.(claims)) throw new HttpError(403, "revoked", "This token has been revoked.");
    const store = storeFor(claims.prj);
    if (!store) throw new HttpError(404, "unknown_project", `This hub does not collect feedback for ${claims.prj}.`);
    return { token, claims, store };
  };

  const requireSigner = () => {
    const signer = options.keyring.signer;
    if (!signer) throw new HttpError(501, "not_enrolling", "This hub does not issue tokens; ask the maintainer for one.");
    return signer;
  };

  const tokenResponse = (status: number, issued: { token: string; claims: TokenClaims }) =>
    json(status, {
      token: issued.token,
      subject: issued.claims.sub,
      tier: issued.claims.tier,
      expires_at: new Date(issued.claims.exp! * 1000).toISOString(),
    });

  const limitAddress = (key: string, project: string) => {
    if (!enrollLimiter(key, quotasFor(project).enrollPerAddressPerHour)) {
      throw new HttpError(429, "rate_limited", "Too many requests from this address. Try again later.", { "retry-after": "3600" });
    }
  };

  /** A JSON object body, or `{}` when there is none. */
  const readObject = async (request: Request): Promise<Record<string, unknown>> => {
    const text = await readBody(request, 8 * 1024);
    if (!text.trim()) return {};
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Falls through.
    }
    throw new HttpError(400, "invalid_request", "The body must be a JSON object.");
  };

  /** A signed-in person's `user` token from a request body, verified and not revoked. */
  const userClaims = async (token: unknown): Promise<TokenClaims> => {
    if (typeof token !== "string") throw new HttpError(400, "invalid_request", "user_token must be a string.");
    let claims: TokenClaims;
    try {
      claims = verifyToken(token, options.keyring, { issuer: options.issuer, tiers: ["user"] });
    } catch (error) {
      if (error instanceof TokenError) throw new HttpError(401, "unauthorized", `The sign-in is no longer valid: ${error.message}`);
      throw error;
    }
    if (await options.isRevoked?.(claims)) throw new HttpError(403, "revoked", "This sign-in has been revoked.");
    return claims;
  };

  // With a user_token, the installation becomes that person for this project; without, it is anonymous.
  const enroll = async (request: Request, info: IngestRequestInfo): Promise<Response> => {
    const { claims } = await authenticate(request, ["project"]);
    const signer = requireSigner();
    const body = await readObject(request);
    if (body.user_token !== undefined) {
      const user = await userClaims(body.user_token);
      return tokenResponse(201, issueToken({ issuer: options.issuer, project: claims.prj, tier: "issued", subject: user.sub, ttlSeconds: installTtl }, signer));
    }
    const clientAddress = info.clientAddress ?? null;
    if (clientAddress) limitAddress(clientAddress, claims.prj);
    if (options.allowEnrollment && !(await options.allowEnrollment({ project: claims.prj, clientAddress }))) {
      throw new HttpError(429, "rate_limited", "Enrolment is not available right now. Try again later.", { "retry-after": "3600" });
    }
    return tokenResponse(201, issueToken({ issuer: options.issuer, project: claims.prj, tier: "install", ttlSeconds: installTtl }, signer));
  };

  // A fresh copy of a token the hub issued: same subject, project and tier, new expiry. Installations
  // call it as they start, so a machine in use never runs out.
  const renew = async (request: Request): Promise<Response> => {
    const token = bearer(request);
    let claims: TokenClaims;
    try {
      claims = verifyToken(token, options.keyring, { issuer: options.issuer, tiers: ["install", "user"] });
    } catch (error) {
      if (error instanceof TokenError) throw new HttpError(401, "unauthorized", error.message);
      throw error;
    }
    if (await options.isRevoked?.(claims)) throw new HttpError(403, "revoked", "This token has been revoked.");
    if (claims.prj !== ANY_PROJECT && !storeFor(claims.prj)) {
      throw new HttpError(404, "unknown_project", `This hub does not collect feedback for ${claims.prj}.`);
    }
    if (claims.tier === "user" && !options.github) throw new HttpError(501, "not_signing_in", "This hub no longer offers sign-in.");
    const ttl = claims.tier === "user" ? userTtl : installTtl;
    return tokenResponse(200, issueToken({ issuer: options.issuer, project: claims.prj, tier: claims.tier, subject: claims.sub, ttlSeconds: ttl }, requireSigner()));
  };

  const github = () => {
    if (!options.github) throw new HttpError(501, "not_signing_in", "This hub does not offer GitHub sign-in.");
    return options.github;
  };

  const githubFailure = (error: unknown): never => {
    if (error instanceof GitHubError) throw new HttpError(502, "github", error.message);
    throw error;
  };

  // The installation gets a code for its user to enter at GitHub, and a handle to poll with.
  const githubStart = async (request: Request, info: IngestRequestInfo): Promise<Response> => {
    const { claims } = await authenticate(request, ["project"]);
    const config = github();
    requireSigner();
    if (info.clientAddress) limitAddress(`signin:${info.clientAddress}`, claims.prj);
    const code = await startDeviceFlow(config).catch(githubFailure);
    return json(200, {
      verification_uri: code.verification_uri,
      user_code: code.user_code,
      expires_in: code.expires_in,
      interval: code.interval,
      handle: code.device_code,
    });
  };

  const githubPoll = async (request: Request): Promise<Response> => {
    await authenticate(request, ["project"]);
    const config = github();
    const signer = requireSigner();
    const { handle } = await readObject(request);
    if (typeof handle !== "string" || !handle || handle.length > 200) throw new HttpError(400, "invalid_request", "handle must be the value start returned.");
    const result = await pollDeviceFlow(config, handle).catch(githubFailure);
    if (result.status === "pending") return json(202, { status: "pending", ...(result.interval ? { interval: result.interval } : {}) });
    if (result.status === "denied") throw new HttpError(403, "signin_denied", "The sign-in was declined at GitHub.");
    if (result.status === "expired") throw new HttpError(410, "signin_expired", "The sign-in code expired before it was entered. Start again.");
    let login: string;
    try {
      login = await signedInUser(config, result.accessToken);
    } catch (error) {
      if (error instanceof GitHubError && /not (one|a member)/.test(error.message)) throw new HttpError(403, "not_allowed", error.message);
      return githubFailure(error);
    }
    const issued = issueToken({ issuer: options.issuer, project: ANY_PROJECT, tier: "user", subject: `github:${login}`, ttlSeconds: userTtl }, signer);
    if (await options.isRevoked?.(issued.claims)) throw new HttpError(403, "revoked", "This GitHub account has been revoked on this hub.");
    return tokenResponse(200, issued);
  };

  const metadata = (): HubMetadata => ({
    issuer: options.issuer,
    endpoints: { enroll: INGEST_PATHS.enroll, feedback: INGEST_PATHS.feedback, renew: INGEST_PATHS.renew },
    signin: options.github && options.keyring.signer ? { github: { start: INGEST_PATHS.githubStart, poll: INGEST_PATHS.githubPoll } } : {},
    install_token_ttl_seconds: installTtl,
    user_token_ttl_seconds: options.github ? userTtl : null,
  });

  // Counted within the project, so projects sharing a store do not use up each other's quotas.
  const checkQuota = async (store: FeedbackStore, claims: TokenClaims, now: number) => {
    const quotas = quotasFor(claims.prj);
    const since = new Date(now - DAY_MS).toISOString();
    const own = claims.tier === "install" ? quotas.perInstallPerDay : quotas.perIssuedSubjectPerDay;
    const limited = (message: string) => new HttpError(429, "rate_limited", message, { "retry-after": "3600" });
    if ((await store.stats({ server: claims.prj, subject: claims.sub, since })).total >= own) {
      throw limited(`This installation has sent ${own} reports in the last day, the most this project accepts. Try again later.`);
    }
    if ((await store.stats({ server: claims.prj, since })).total >= quotas.perProjectPerDay) {
      throw limited("This project has received as many reports today as it accepts. Try again later.");
    }
  };

  const feedback = async (request: Request): Promise<Response> => {
    const { token, claims, store } = await authenticate(request, ["install", "issued"]);
    const text = await readBody(request, MAX_INGEST_BODY_BYTES);
    let parsed: IngestSubmission;
    try {
      const result = ingestSubmissionSchema.safeParse(JSON.parse(text));
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new HttpError(400, "invalid_request", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
      }
      parsed = result.data;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "invalid_request", "The body is not valid JSON.");
    }
    try {
      validateSubmission(parsed, limits);
      if (parsed.server_context && Buffer.byteLength(JSON.stringify(parsed.server_context), "utf8") > limits.metadataBytes) {
        throw new FeedbackInputError(`server_context is larger than ${limits.metadataBytes} bytes as JSON.`);
      }
    } catch (error) {
      if (error instanceof FeedbackInputError) throw new HttpError(400, "invalid_request", error.message);
      throw error;
    }

    const now = Date.now();
    const id = acceptableId(parsed.id, now);
    if (id) {
      // A retry of a report this hub already has: answer as before, store nothing.
      const existing = await store.get(id);
      if (existing) return duplicate(existing, claims);
    }
    await checkQuota(store, claims, now);

    const identity: FeedbackIdentity = {
      subject: claims.sub,
      client_id: claims.prj,
      session_id: null,
      token_fingerprint: fingerprintToken(token, options.tokenFingerprintKey),
      scopes: [`ingest:${claims.tier}`],
      client_name: parsed.client_name ?? null,
      client_version: parsed.client_version ?? null,
      user_agent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
    };
    let record = buildRecord(parsed, {
      id,
      now: new Date(now),
      identity,
      server: { name: claims.prj, version: parsed.server_version ?? null },
    });
    const { ingest: _reserved, ...reportedContext } = parsed.server_context ?? {};
    const clientCreated = parsed.created_at && !Number.isNaN(Date.parse(parsed.created_at)) ? new Date(parsed.created_at).toISOString() : null;
    record.context.server_context = {
      ...reportedContext,
      ingest: { tier: claims.tier, received_at: record.created_at, client_created_at: clientCreated },
    };
    if (options.redact) record = await options.redact(record);

    try {
      await store.insert(record);
    } catch (error) {
      // Two deliveries of the same queued report can race; the loser finds the winner's record.
      const existing = await store.get(record.id).catch(() => null);
      if (existing) return duplicate(existing, claims);
      throw error;
    }
    return json(201, { id: record.id, created_at: record.created_at, status: record.status });
  };

  const duplicate = (existing: FeedbackRecord, claims: TokenClaims): Response => {
    if (existing.identity.subject !== claims.sub || existing.server.name !== claims.prj) {
      throw new HttpError(409, "conflict", "That report id is already in use. Send the report again without an id.");
    }
    return json(200, { id: existing.id, created_at: existing.created_at, status: existing.status, duplicate: true });
  };

  return async (request, info = {}) => {
    try {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      if (path === basePath + INGEST_PATHS.wellKnown) {
        if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.", { allow: "GET" });
        return json(200, metadata(), { "cache-control": "public, max-age=300" });
      }
      const routes: Record<string, (request: Request, info: IngestRequestInfo) => Promise<Response>> = {
        [basePath + INGEST_PATHS.enroll]: enroll,
        [basePath + INGEST_PATHS.feedback]: feedback,
        [basePath + INGEST_PATHS.renew]: renew,
        [basePath + INGEST_PATHS.githubStart]: githubStart,
        [basePath + INGEST_PATHS.githubPoll]: githubPoll,
      };
      const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
      if (!route) throw new HttpError(404, "not_found", "No such endpoint.");
      if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.", { allow: "POST" });
      return await route(request, info);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error);
      options.onError?.(error);
      return errorResponse(new HttpError(503, "unavailable", "The feedback service could not store the report. Try again later."));
    }
  };
}

/**
 * Adapts the handler to node:http and Express. Mount it before any body parser.
 *
 * The client address (for the enrolment limit) is, in order: `clientAddress(req)` if given; the
 * first X-Forwarded-For entry with `trustProxy`, which is only safe behind a proxy that overwrites
 * that header; Express's `req.ip`, which follows the app's own `trust proxy` setting; the socket.
 */
export function toNodeListener(
  handler: IngestHandler,
  options: { trustProxy?: boolean; clientAddress?: (req: IncomingMessage) => string | null | undefined } = {},
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const host = req.headers.host ?? "localhost";
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      // Express strips its mount path from req.url and keeps the full one in originalUrl.
      const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? "/";
      const request = new Request(`http://${host}${path}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
      } as RequestInit);
      const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
      const expressIp = (req as IncomingMessage & { ip?: unknown }).ip;
      const clientAddress =
        options.clientAddress?.(req) || forwarded || (typeof expressIp === "string" ? expressIp : "") || req.socket.remoteAddress || null;
      const response = await handler(request, { clientAddress });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
}
