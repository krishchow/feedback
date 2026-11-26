// Reader operations shared by the MCP reader tools and the CLI.

import type { FeedbackStore } from "./store.js";
import { REFERENCE_KEY_PATTERN } from "./tools.js";
import type { FeedbackFilter, FeedbackPage, FeedbackRecord, FeedbackStats, FeedbackStatus } from "./types.js";

/** A problem with the caller's input; its message is safe to show to the caller. */
export class FeedbackInputError extends Error {}

function normalizeTimestamp(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new FeedbackInputError(`${label} is not a valid ISO 8601 timestamp.`);
  return new Date(time).toISOString();
}

function checkReference(reference: FeedbackFilter["reference"]): FeedbackFilter["reference"] {
  if (reference === undefined) return undefined;
  if (!REFERENCE_KEY_PATTERN.test(reference.key)) {
    throw new FeedbackInputError("reference key must start with a letter and use only letters, digits, _ or - (at most 64).");
  }
  return { key: reference.key, value: reference.value };
}

/** Keeps only the filter fields that are set and puts timestamps in canonical form. */
export function normalizeFilter(args: FeedbackFilter): FeedbackFilter {
  // JSON round trip drops keys whose value is undefined.
  return JSON.parse(
    JSON.stringify({
      kind: args.kind,
      status: args.status,
      severity: args.severity,
      subject: args.subject,
      server: args.server,
      tool: args.tool,
      tag: args.tag,
      since: normalizeTimestamp("since", args.since),
      until: normalizeTimestamp("until", args.until),
      reference: checkReference(args.reference),
    }),
  ) as FeedbackFilter;
}

export async function listPage(
  store: FeedbackStore,
  args: FeedbackFilter & { limit?: number; cursor?: string },
): Promise<FeedbackPage> {
  try {
    return await store.list({ ...normalizeFilter(args), limit: args.limit ?? 25, cursor: args.cursor });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid feedback cursor") {
      throw new FeedbackInputError("cursor is not a value returned by a previous list.");
    }
    throw error;
  }
}

export interface TriageOutcome {
  updated: FeedbackRecord[];
  not_found: string[];
}

/** Sets status and/or note on several records. `note: null` clears the note. */
export async function triageMany(
  store: FeedbackStore,
  ids: string[],
  change: { status?: FeedbackStatus; note?: string | null; by: string | null },
): Promise<TriageOutcome> {
  if (change.status === undefined && change.note === undefined) {
    throw new FeedbackInputError("Provide a status, a note, or both.");
  }
  const outcome: TriageOutcome = { updated: [], not_found: [] };
  const updated_at = new Date().toISOString();
  for (const id of new Set(ids)) {
    const record = await store.updateTriage(id, {
      status: change.status,
      triage_note: change.note,
      triaged_by: change.by,
      updated_at,
    });
    if (record) outcome.updated.push(record);
    else outcome.not_found.push(id);
  }
  return outcome;
}

/** A failure reaching a remote reader endpoint or reported by its tools. `status` is the HTTP status, when there was one. */
export class FeedbackReaderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * The reader operations, wherever the feedback lives: a store opened in this
 * process (storeReader) or a server's reader endpoint (connectFeedbackReader).
 */
export interface FeedbackReaderClient {
  stats(filter: FeedbackFilter): Promise<FeedbackStats>;
  list(query: FeedbackFilter & { limit: number; cursor?: string }): Promise<FeedbackPage>;
  /** Rejects when the id is unknown. */
  get(id: string): Promise<FeedbackRecord>;
  /**
   * `by` is recorded as triaged_by where this side decides it (a store). A remote
   * endpoint records its caller's identity instead and ignores it.
   */
  triage(ids: string[], change: { status?: FeedbackStatus; note?: string | null; by?: string | null }): Promise<TriageOutcome>;
  close(): Promise<void>;
}

/** Reader operations straight against a store. `defaultBy` is used when a triage gives no `by`. */
export function storeReader(store: FeedbackStore, defaultBy: string | null = null): FeedbackReaderClient {
  return {
    // A custom store written before by_server existed still answers with a complete shape.
    stats: async (filter) => {
      const stats = await store.stats(normalizeFilter(filter));
      return { ...stats, by_server: stats.by_server ?? {} };
    },
    list: (query) => listPage(store, query),
    get: async (id) => {
      const record = await store.get(id);
      if (!record) throw new FeedbackInputError(`No feedback with id ${id}.`);
      return record;
    },
    triage: (ids, change) => triageMany(store, ids, { status: change.status, note: change.note, by: change.by ?? defaultBy }),
    close: async () => store.close?.(),
  };
}
