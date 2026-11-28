// A write-only sink for MCP servers that run on their users' machines (stdio servers, CLIs): it
// sends each report to the maintainer's ingest hub (spec/ingest.md), and keeps it on disk to send
// later when the hub cannot be reached.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  INGEST_PATHS,
  MAX_QUEUE_AGE_DAYS,
  toIngestSubmission,
  unverifiedClaimsOf,
  unverifiedProjectOf,
  type IngestSubmission,
} from "./ingest/protocol.js";
import { isValidProjectName } from "./ingest/tokens.js";
import { FeedbackDeliveryError, type FeedbackReceipt, type FeedbackSink } from "./store.js";
import type { FeedbackRecord } from "./types.js";

export interface RemoteStoreOptions {
  /** The hub's base URL, e.g. `https://feedback.example.com`. Must be HTTPS unless it is this machine. */
  endpoint: string;
  /**
   * The name this server's reports are filed under, for a hub with open enrolment: no project key
   * needed. Lowercase letters, digits, `.`, `_` or `-`, usually the package name.
   */
  project?: string;
  /**
   * The project key the maintainer issued for this server, for a hub that wants one. It is public by
   * design and ships in the package; the hub exchanges it for this installation's own token.
   */
  projectKey?: string;
  /** A token the maintainer issued to a known person or team, usually read from the environment. Skips enrolment. */
  token?: string;
  /**
   * `"github"`: reports go out as the person who signed in with GitHub, not as an anonymous
   * installation. The first report asks them to sign in, once per machine; the sign-in is shared by
   * every server on the machine that reports to the same hub, and renewed as they start. The hub
   * must offer GitHub sign-in.
   */
  signIn?: "github";
  /** Where this server's token and queued reports are kept. Defaults to the platform's per-user state directory. */
  stateDir?: string;
  /** Where a sign-in is kept, shared by the servers that report to this hub. Defaults to the per-user state directory. */
  identityDir?: string;
  /** start() renews stored tokens once they are this old. Default one day. */
  renewAfterSeconds?: number;
  /** Limits on reports waiting to be sent. `false` turns the queue off, so an unreachable hub is an error. */
  queue?: { maxItems?: number; maxAgeDays?: number } | false;
  /** Per request. Default 10 seconds. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: the shortest wait between polls of a pending sign-in. */
  signInPollMs?: number;
  /** Called with errors that do not reach the agent, e.g. a queued report the hub refused. For the host's logger. */
  onError?: (error: unknown) => void;
}

export interface FlushResult {
  delivered: number;
  /** Refused by the hub or too old, and deleted. */
  dropped: number;
  remaining: number;
}

export interface StartResult extends FlushResult {
  /** Tokens renewed: `user` for the sign-in, `project` for this server's own. */
  renewed: Array<"user" | "project">;
}

export interface RemoteStore extends FeedbackSink {
  /** Resolves `stored` once the hub has the report, or `queued` with a note saying where it is waiting and why. */
  insert(record: FeedbackRecord): Promise<FeedbackReceipt>;
  /**
   * Call once when the server starts. Renews stored tokens that are more than a day old, so a machine
   * in use never has to enrol or sign in again, then sends queued reports. Contacts the hub only if
   * this machine already has a token or a queued report. Never throws.
   */
  start(): Promise<StartResult>;
  /** Sends any queued reports. insert also calls it. Never throws. */
  flush(): Promise<FlushResult>;
  /** Where this server's token and queue are kept. */
  readonly stateDir: string;
}

/** True when the user has turned feedback off with MCP_FEEDBACK_DISABLED. Hosts should then skip registerFeedback. */
export function feedbackDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.MCP_FEEDBACK_DISABLED ?? "");
}

/** The ingest hub every server on a machine reports to, set once. Not the reader endpoint, which is MCP_FEEDBACK_URL. */
export const FEEDBACK_ENDPOINT_ENV = "MCP_FEEDBACK_ENDPOINT";

/**
 * The hub to send this server's feedback to, or undefined when feedback is off. In order: `variable`
 * (this server's own, e.g. `MY_SERVER_FEEDBACK_ENDPOINT`), then `fallback` (a hub the maintainer ships
 * so every installation reports), then MCP_FEEDBACK_ENDPOINT. A server with a `fallback` never reads
 * MCP_FEEDBACK_ENDPOINT: the shared variable is how someone points the servers they run that have no
 * hub of their own, and must not redirect one that does. An empty value counts as unset, and
 * MCP_FEEDBACK_DISABLED turns feedback off whatever is set.
 */
export function feedbackEndpoint(
  options: { variable?: string; fallback?: string; env?: Record<string, string | undefined> } = {},
): string | undefined {
  const env = options.env ?? process.env;
  if (feedbackDisabled(env)) return undefined;
  const read = (name: string | undefined) => (name ? env[name]?.trim() || undefined : undefined);
  return read(options.variable) ?? (options.fallback?.trim() || read(FEEDBACK_ENDPOINT_ENV));
}

function stateRoot(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "mcp-feedback");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "mcp-feedback");
  return join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "mcp-feedback");
}

function checkEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`remoteStore: endpoint is not a URL: ${endpoint}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("remoteStore: the endpoint must use https (plain http is allowed only for localhost).");
  }
  return url;
}

type Outcome =
  | { kind: "delivered" }
  | { kind: "retry"; reason: string }
  | { kind: "reauth" }
  | { kind: "signin" }
  | { kind: "refused"; message: string };

interface CachedToken {
  endpoint: string;
  token: string;
  expires_at: string;
}

interface QueuedReport {
  queued_at: string;
  submission: IngestSubmission;
}

interface PendingSignIn {
  verificationUri: string;
  userCode: string;
  handle: string;
  expiresAt: number;
  intervalMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A failure worth retrying later: the hub is down, overloaded or unreachable. */
class RetryableError extends Error {}

/** No usable sign-in on this machine: the user has to sign in before reports can go. */
class SignInRequired extends Error {}

async function hubMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message.slice(0, 500);
  } catch {
    // Not one of the hub's error bodies.
  }
  return `The feedback service answered ${response.status}.`;
}

/** Worth trying again later. 501 means the hub does not offer something at all, which waiting will not change. */
const retryable = (status: number) => status === 429 || (status >= 500 && status !== 501);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    // A wait for a sign-in must not keep a server process alive after its client has gone.
    setTimeout(resolve, ms).unref();
  });

export function remoteStore(options: RemoteStoreOptions): RemoteStore {
  const url = checkEndpoint(options.endpoint);
  const endpoint = url.href.replace(/\/+$/, "");
  const credential = options.token ?? options.projectKey;
  if (!credential && !options.project) throw new Error("remoteStore: pass project (or projectKey, or an issued token).");
  if (options.project !== undefined && !isValidProjectName(options.project)) {
    throw new Error("remoteStore: project is lowercase letters, digits, '.', '_' or '-', at most 64.");
  }
  const project = credential ? unverifiedProjectOf(credential) : options.project;
  if (!project) throw new Error("remoteStore: the project key is not one an mcp-feedback hub issues.");
  if (options.project && options.project !== project) throw new Error(`remoteStore: the key is for ${project}, not ${options.project}.`);
  if (options.signIn && !options.projectKey && !options.project) throw new Error("remoteStore: signIn needs project or projectKey.");
  const stateDir = options.stateDir ?? join(stateRoot(), project);
  const identityDir = options.identityDir ?? join(stateRoot(), "_hubs", `${url.host}${url.pathname}`.replace(/[^A-Za-z0-9.-]+/g, "_"));
  const queueDir = join(stateDir, "queue");
  const tokenFile = join(stateDir, "token.json");
  const userFile = join(identityDir, "user.json");
  const queueLimits = options.queue === false ? null : { maxItems: 50, maxAgeDays: MAX_QUEUE_AGE_DAYS, ...options.queue };
  const timeoutMs = options.timeoutMs ?? 10_000;
  const renewAfterMs = (options.renewAfterSeconds ?? 24 * 60 * 60) * 1000;
  const doFetch = options.fetch ?? fetch;
  // No version: reading package.json at run time breaks when the package is bundled.
  const userAgent = "mcp-feedback-remote";

  const request = (path: string, token: string | undefined, body?: unknown) =>
    doFetch(endpoint + path, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "user-agent": userAgent },
      body: body === undefined ? "{}" : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  /** Before this installation has a token of its own: with the project key, or by naming the project. */
  const enrolling = (path: string, body: Record<string, unknown> = {}) =>
    options.projectKey ? request(path, options.projectKey, body) : request(path, undefined, { ...body, project });

  /** Writes through a temporary file, so a crash never leaves half a file for the next run to choke on. */
  const writePrivate = async (file: string, value: unknown) => {
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, file);
  };

  const readCached = async (file: string): Promise<CachedToken | null> => {
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as CachedToken;
      return cached.endpoint === endpoint && typeof cached.token === "string" ? cached : null;
    } catch {
      return null;
    }
  };

  const save = (file: string, body: { token: string; expires_at: string }) =>
    writePrivate(file, { endpoint, token: body.token, expires_at: body.expires_at } satisfies CachedToken);

  /** A cached token with more than a day to run, or null. */
  const usable = (cached: CachedToken | null): CachedToken | null =>
    cached && Date.parse(cached.expires_at) - Date.now() > DAY_MS ? cached : null;

  const tokenBody = async (response: Response): Promise<{ token: string; expires_at: string }> => {
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new RetryableError("The feedback service gave an unexpected answer.");
    }
    return { token: body.token, expires_at: body.expires_at };
  };

  // ---- this server's token

  let acquiring: Promise<string> | undefined;

  /** With a sign-in, the hub makes this installation that person for this project; without, it is anonymous. */
  const enroll = async (userToken?: string): Promise<string> => {
    const response = await enrolling(INGEST_PATHS.enroll, userToken ? { user_token: userToken } : {});
    if (!response.ok) {
      const message = await hubMessage(response);
      if (retryable(response.status)) throw new RetryableError(message);
      if (userToken && (response.status === 401 || response.status === 403)) {
        // The sign-in expired or was revoked: drop it and ask again.
        await rm(userFile, { force: true });
        throw new SignInRequired(message);
      }
      throw new FeedbackDeliveryError(
        options.projectKey
          ? `The feedback service did not accept this server's project key: ${message}`
          : `The feedback service did not enrol this server: ${message}`,
      );
    }
    const body = await tokenBody(response);
    await save(tokenFile, body);
    return body.token;
  };

  const acquire = async (): Promise<string> => {
    if (options.signIn !== "github") return enroll();
    const user = usable(await readCached(userFile));
    if (!user) throw new SignInRequired("No sign-in on this machine.");
    return enroll(user.token);
  };

  const serverToken = async (fresh = false): Promise<string> => {
    if (options.token) return options.token;
    if (!fresh) {
      const cached = usable(await readCached(tokenFile));
      // In sign-in mode, a token from earlier anonymous use does not count.
      if (cached && (options.signIn !== "github" || unverifiedClaimsOf(cached.token)?.tier === "issued")) return cached.token;
    }
    acquiring ??= acquire().finally(() => {
      acquiring = undefined;
    });
    return acquiring;
  };

  // ---- signing in with GitHub

  let pending: PendingSignIn | undefined;

  const pollSignIn = async (signIn: PendingSignIn) => {
    let interval = signIn.intervalMs;
    while (pending === signIn && Date.now() < signIn.expiresAt) {
      await sleep(interval);
      let response: Response;
      try {
        response = await enrolling(INGEST_PATHS.githubPoll, { handle: signIn.handle });
      } catch {
        continue; // Unreachable for a moment; keep trying until the code expires.
      }
      if (response.status === 202) {
        const body = (await response.json().catch(() => ({}))) as { interval?: unknown };
        if (typeof body.interval === "number") interval = Math.max(interval, body.interval * 1000);
        continue;
      }
      if (response.ok) {
        try {
          await save(userFile, await tokenBody(response));
          pending = undefined;
          await flushInternal(); // the reports that were waiting for it
        } catch (error) {
          options.onError?.(error);
        }
        return;
      }
      pending = undefined;
      options.onError?.(new FeedbackDeliveryError(`GitHub sign-in did not complete: ${await hubMessage(response)}`));
      return;
    }
    if (pending === signIn) pending = undefined;
  };

  /** Starts a sign-in, or returns the one already waiting for the user. */
  const beginSignIn = async (): Promise<PendingSignIn> => {
    if (pending && pending.expiresAt - Date.now() > 60_000) return pending;
    const response = await enrolling(INGEST_PATHS.githubStart);
    if (!response.ok) {
      const message = await hubMessage(response);
      if (retryable(response.status)) throw new RetryableError(message);
      throw new FeedbackDeliveryError(`This server sends feedback as a GitHub user, but the feedback service could not start a sign-in: ${message}`);
    }
    const body = (await response.json()) as { verification_uri?: unknown; user_code?: unknown; handle?: unknown; expires_in?: unknown; interval?: unknown };
    if (typeof body.verification_uri !== "string" || typeof body.user_code !== "string" || typeof body.handle !== "string") {
      throw new RetryableError("The feedback service gave an unexpected answer to a sign-in request.");
    }
    const signIn: PendingSignIn = {
      verificationUri: body.verification_uri,
      userCode: body.user_code,
      handle: body.handle,
      expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
      intervalMs: options.signInPollMs ?? (Number(body.interval) || 5) * 1000,
    };
    pending = signIn;
    void pollSignIn(signIn);
    return signIn;
  };

  // ---- sending one report

  const send = async (submission: IngestSubmission, fresh = false): Promise<Outcome> => {
    let response: Response;
    try {
      response = await request(INGEST_PATHS.feedback, await serverToken(fresh), submission);
    } catch (error) {
      if (error instanceof SignInRequired) return { kind: "signin" };
      if (error instanceof FeedbackDeliveryError) return { kind: "refused", message: error.message };
      return { kind: "retry", reason: error instanceof Error ? error.message : String(error) };
    }
    if (response.ok) return { kind: "delivered" };
    if (response.status === 401 && !options.token && !fresh) return { kind: "reauth" };
    const message = await hubMessage(response);
    if (retryable(response.status)) return { kind: "retry", reason: message };
    return { kind: "refused", message: `The feedback service refused the report: ${message}` };
  };

  const deliver = async (submission: IngestSubmission): Promise<Outcome> => {
    const outcome = await send(submission);
    return outcome.kind === "reauth" ? send(submission, true) : outcome;
  };

  // ---- the queue

  const queued = async (): Promise<string[]> => {
    try {
      return (await readdir(queueDir)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return [];
    }
  };

  type FlushState = FlushResult & { blocked: "unreachable" | "signin" | null };
  let flushing: Promise<FlushState> | undefined;

  const flushOnce = async (): Promise<FlushState> => {
    const result: FlushState = { delivered: 0, dropped: 0, remaining: 0, blocked: null };
    const files = await queued();
    for (const [index, name] of files.entries()) {
      const file = join(queueDir, name);
      let item: QueuedReport;
      try {
        item = JSON.parse(await readFile(file, "utf8")) as QueuedReport;
      } catch {
        // Deleted by another process sending the same queue, or corrupt.
        await rm(file, { force: true });
        continue;
      }
      if (Date.now() - Date.parse(item.queued_at) > (queueLimits?.maxAgeDays ?? MAX_QUEUE_AGE_DAYS) * DAY_MS) {
        await rm(file, { force: true });
        result.dropped++;
        continue;
      }
      const outcome = await deliver(item.submission);
      if (outcome.kind === "retry" || outcome.kind === "signin") {
        // Cannot send now; the rest stays for next time.
        result.blocked = outcome.kind === "retry" ? "unreachable" : "signin";
        result.remaining = files.length - index;
        break;
      }
      await rm(file, { force: true });
      if (outcome.kind === "delivered") result.delivered++;
      else {
        result.dropped++;
        options.onError?.(new FeedbackDeliveryError(`A queued report was deleted. ${outcome.kind === "refused" ? outcome.message : ""}`));
      }
    }
    return result;
  };

  const flushInternal = () => {
    flushing ??= flushOnce()
      .catch((error): FlushState => {
        options.onError?.(error);
        return { delivered: 0, dropped: 0, remaining: 0, blocked: "unreachable" };
      })
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  };

  /** Saves a report to send later. `note` tells the user why and where; `withoutQueue` is the error when queueing is off. */
  const enqueue = async (
    record: FeedbackRecord,
    submission: IngestSubmission,
    note: (file: string) => string,
    withoutQueue: string,
  ): Promise<FeedbackReceipt> => {
    if (!queueLimits) throw new FeedbackDeliveryError(`${withoutQueue} Nothing was sent.`);
    const waiting = await queued();
    if (waiting.length >= queueLimits.maxItems) {
      throw new FeedbackDeliveryError(
        `The report could not be sent, and ${waiting.length} earlier reports are already waiting on this machine. ` +
          "Nothing was sent or saved; try again later.",
      );
    }
    const file = join(queueDir, `${record.id}.json`);
    await writePrivate(file, { queued_at: new Date().toISOString(), submission } satisfies QueuedReport);
    return { delivery: "queued", note: note(file) };
  };

  const unreachableNote = (file: string) =>
    `The feedback service could not be reached, so the report was saved on this machine at ${file} and will be sent ` +
    "the next time this server starts or files feedback. Deleting that file cancels it.";
  const queueUnreachable = (record: FeedbackRecord, submission: IngestSubmission) =>
    enqueue(record, submission, unreachableNote, "The feedback service could not be reached.");

  const queueForSignIn = async (record: FeedbackRecord, submission: IngestSubmission): Promise<FeedbackReceipt> => {
    let signIn: PendingSignIn;
    try {
      signIn = await beginSignIn();
    } catch (error) {
      if (error instanceof FeedbackDeliveryError) throw error;
      return queueUnreachable(record, submission);
    }
    const minutes = Math.max(1, Math.round((signIn.expiresAt - Date.now()) / 60_000));
    const instruction =
      `Reports from this server are sent as your GitHub user, so sign in once on this machine: open ${signIn.verificationUri} ` +
      `and enter the code ${signIn.userCode} within ${minutes} minutes.`;
    return enqueue(
      record,
      submission,
      (file) => `${instruction} The report is saved at ${file} and is sent as soon as you approve. Deleting that file cancels it.`,
      `${instruction} Then file the report again.`,
    );
  };

  /** Renews a stored token once it is older than renewAfterSeconds. Forgets it if the hub no longer accepts it. */
  const renewIfOld = async (file: string, renew: (token: string) => Promise<Response>): Promise<boolean> => {
    const cached = await readCached(file);
    const claims = cached && unverifiedClaimsOf(cached.token);
    if (!cached || !claims || Date.now() - claims.iat * 1000 < renewAfterMs) return false;
    const response = await renew(cached.token);
    if (response.ok) {
      await save(file, await tokenBody(response));
      return true;
    }
    if ([401, 403, 404].includes(response.status)) await rm(file, { force: true });
    return false;
  };

  return {
    stateDir,
    async insert(record) {
      const submission = toIngestSubmission(record);
      // Older reports go first, and a hub that is down is found out once, not twice.
      const flushed = await flushInternal();
      if (flushed.blocked === "unreachable" && flushed.remaining > 0) return queueUnreachable(record, submission);
      if (flushed.blocked === "signin" && flushed.remaining > 0) return queueForSignIn(record, submission);
      const outcome = await deliver(submission);
      if (outcome.kind === "delivered") return { delivery: "stored" };
      if (outcome.kind === "retry") return queueUnreachable(record, submission);
      if (outcome.kind === "signin") return queueForSignIn(record, submission);
      throw new FeedbackDeliveryError(outcome.kind === "refused" ? outcome.message : "The feedback service refused the report.");
    },
    async start() {
      const renewed: StartResult["renewed"] = [];
      if (!options.token) {
        try {
          if (await renewIfOld(userFile, (token) => request(INGEST_PATHS.renew, token))) renewed.push("user");
          const renewedProject = await renewIfOld(tokenFile, async (token) => {
            if (unverifiedClaimsOf(token)?.tier === "install") return request(INGEST_PATHS.renew, token);
            // A signed-in person's token for this project is renewed from their sign-in.
            const user = usable(await readCached(userFile));
            return user
              ? enrolling(INGEST_PATHS.enroll, { user_token: user.token })
              : new Response(null, { status: 401 });
          });
          if (renewedProject) renewed.push("project");
        } catch (error) {
          // Offline, or the hub is down: the tokens still work until they expire, so this is not worth reporting.
          const network = error instanceof RetryableError || error instanceof TypeError || (error as Error)?.name === "TimeoutError";
          if (!network) options.onError?.(error);
        }
      }
      const { blocked: _blocked, ...flushed } = await flushInternal();
      return { ...flushed, renewed };
    },
    async flush() {
      const { blocked: _blocked, ...result } = await flushInternal();
      return result;
    },
  };
}
