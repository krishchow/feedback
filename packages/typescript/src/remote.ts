// A write-only sink for MCP servers that run on their users' machines (stdio servers, CLIs): it
// sends each report to the maintainer's ingest hub (spec/ingest.md), and keeps it on disk to send
// later when the hub cannot be reached.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { INGEST_PATHS, MAX_QUEUE_AGE_DAYS, toIngestSubmission, unverifiedProjectOf, type IngestSubmission } from "./ingest/protocol.js";
import { FeedbackDeliveryError, type FeedbackReceipt, type FeedbackSink } from "./store.js";
import type { FeedbackRecord } from "./types.js";

export interface RemoteStoreOptions {
  /** The hub's base URL, e.g. `https://feedback.example.com`. Must be HTTPS unless it is this machine. */
  endpoint: string;
  /**
   * The project key the maintainer issued for this server. It is public by design and ships in the
   * package; the hub exchanges it for this installation's own token.
   */
  projectKey?: string;
  /** A token the maintainer issued to a known person or team, usually read from the environment. Skips enrolment. */
  token?: string;
  /** Where the installation's token and queued reports are kept. Defaults to the platform's per-user state directory. */
  stateDir?: string;
  /** Limits on reports waiting to be sent. `false` turns the queue off, so an unreachable hub is an error. */
  queue?: { maxItems?: number; maxAgeDays?: number } | false;
  /** Per request. Default 10 seconds. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  /** Called with errors that do not reach the agent, e.g. a queued report the hub refused. For the host's logger. */
  onError?: (error: unknown) => void;
}

export interface FlushResult {
  delivered: number;
  /** Refused by the hub or too old, and deleted. */
  dropped: number;
  remaining: number;
}

export interface RemoteStore extends FeedbackSink {
  /** Resolves `stored` once the hub has the report, or `queued` with a note saying where it is waiting. */
  insert(record: FeedbackRecord): Promise<FeedbackReceipt>;
  /** Sends any queued reports. Call once when the server starts; insert also calls it. Never throws. */
  flush(): Promise<FlushResult>;
  /** Where the installation's token and queue are kept. */
  readonly stateDir: string;
}

/** True when the user has turned feedback off with MCP_FEEDBACK_DISABLED. Hosts should then skip registerFeedback. */
export function feedbackDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.MCP_FEEDBACK_DISABLED ?? "");
}

function defaultStateDir(project: string): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "mcp-feedback", project);
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "mcp-feedback", project);
  return join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "mcp-feedback", project);
}

function checkEndpoint(endpoint: string): string {
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
  return url.href.replace(/\/+$/, "");
}

type Outcome =
  | { kind: "delivered" }
  | { kind: "retry"; reason: string }
  | { kind: "reauth" }
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

const DAY_MS = 24 * 60 * 60 * 1000;
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** A failure worth retrying later: the hub is down, overloaded or unreachable. */
async function hubMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message.slice(0, 500);
  } catch {
    // Not one of the hub's error bodies.
  }
  return `The feedback service answered ${response.status}.`;
}

export function remoteStore(options: RemoteStoreOptions): RemoteStore {
  const endpoint = checkEndpoint(options.endpoint);
  const credential = options.token ?? options.projectKey;
  if (!credential) throw new Error("remoteStore: pass projectKey (or an issued token).");
  const project = unverifiedProjectOf(credential);
  if (!project) throw new Error("remoteStore: the project key is not one an mcp-feedback hub issues.");
  const stateDir = options.stateDir ?? defaultStateDir(project);
  const queueDir = join(stateDir, "queue");
  const tokenFile = join(stateDir, "token.json");
  const queueLimits = options.queue === false ? null : { maxItems: 50, maxAgeDays: MAX_QUEUE_AGE_DAYS, ...options.queue };
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? fetch;
  const userAgent = `mcp-feedback-remote/${version}`;

  const request = (path: string, token: string, body?: unknown) =>
    doFetch(endpoint + path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": userAgent },
      body: body === undefined ? "{}" : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const ensureDir = (dir: string) => mkdir(dir, { recursive: true, mode: 0o700 });

  /** Writes through a temporary file, so a crash never leaves half a file for the next run to choke on. */
  const writePrivate = async (file: string, value: unknown) => {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, file);
  };

  // ---- the installation's token

  let enrolling: Promise<string> | undefined;

  const cachedToken = async (): Promise<string | null> => {
    try {
      const cached = JSON.parse(await readFile(tokenFile, "utf8")) as CachedToken;
      if (cached.endpoint === endpoint && Date.parse(cached.expires_at) - Date.now() > DAY_MS) return cached.token;
    } catch {
      // None yet, or unreadable: enrol again.
    }
    return null;
  };

  const enroll = async (): Promise<string> => {
    const response = await request(INGEST_PATHS.enroll, options.projectKey!);
    if (!response.ok) {
      const message = await hubMessage(response);
      if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
      throw new FeedbackDeliveryError(`The feedback service did not accept this server's project key: ${message}`);
    }
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new RetryableError("The feedback service gave an unexpected answer to enrolment.");
    }
    await ensureDir(stateDir);
    await writePrivate(tokenFile, { endpoint, token: body.token, expires_at: body.expires_at } satisfies CachedToken);
    return body.token;
  };

  const installToken = async (fresh = false): Promise<string> => {
    if (options.token) return options.token;
    if (!fresh) {
      const cached = await cachedToken();
      if (cached) return cached;
    }
    enrolling ??= enroll().finally(() => {
      enrolling = undefined;
    });
    return enrolling;
  };

  // ---- sending one report

  const send = async (submission: IngestSubmission, fresh = false): Promise<Outcome> => {
    let response: Response;
    try {
      response = await request(INGEST_PATHS.feedback, await installToken(fresh), submission);
    } catch (error) {
      if (error instanceof FeedbackDeliveryError) return { kind: "refused", message: error.message };
      return { kind: "retry", reason: error instanceof Error ? error.message : String(error) };
    }
    if (response.ok) return { kind: "delivered" };
    if (response.status === 401 && !options.token && !fresh) return { kind: "reauth" };
    const message = await hubMessage(response);
    if (response.status === 429 || response.status >= 500) return { kind: "retry", reason: message };
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

  let flushing: Promise<FlushResult & { unreachable: boolean }> | undefined;

  const flushOnce = async (): Promise<FlushResult & { unreachable: boolean }> => {
    const result = { delivered: 0, dropped: 0, remaining: 0, unreachable: false };
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
      if (outcome.kind === "retry") {
        // Unreachable now; the rest stays for next time.
        result.unreachable = true;
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
      .catch((error) => {
        options.onError?.(error);
        return { delivered: 0, dropped: 0, remaining: 0, unreachable: true };
      })
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  };

  const enqueue = async (record: FeedbackRecord, submission: IngestSubmission, reason: string): Promise<FeedbackReceipt> => {
    if (!queueLimits) throw new FeedbackDeliveryError(`The feedback service could not be reached (${reason}). Nothing was sent.`);
    const waiting = await queued();
    if (waiting.length >= queueLimits.maxItems) {
      throw new FeedbackDeliveryError(
        `The feedback service could not be reached, and ${waiting.length} earlier reports are already waiting on this machine. ` +
          "Nothing was sent or saved; try again later.",
      );
    }
    await ensureDir(queueDir);
    const file = join(queueDir, `${record.id}.json`);
    await writePrivate(file, { queued_at: new Date().toISOString(), submission } satisfies QueuedReport);
    return {
      delivery: "queued",
      note:
        `The feedback service could not be reached, so the report was saved on this machine at ${file} and will be sent ` +
        "the next time this server starts or files feedback. Deleting that file cancels it.",
    };
  };

  return {
    stateDir,
    async insert(record) {
      const submission = toIngestSubmission(record);
      // Older reports go first, and a hub that is down is found out once, not twice.
      const flushed = await flushInternal();
      if (flushed.unreachable && flushed.remaining > 0) return enqueue(record, submission, "earlier reports are still waiting");
      const outcome = await deliver(submission);
      if (outcome.kind === "delivered") return { delivery: "stored" };
      if (outcome.kind === "retry") return enqueue(record, submission, outcome.reason);
      throw new FeedbackDeliveryError(outcome.kind === "refused" ? outcome.message : "The feedback service refused the report.");
    },
    async flush() {
      const { unreachable: _unreachable, ...result } = await flushInternal();
      return result;
    },
  };
}

class RetryableError extends Error {}
