import type {
  FeedbackFilter,
  FeedbackListQuery,
  FeedbackPage,
  FeedbackRecord,
  FeedbackStats,
  FeedbackTriagePatch,
} from "./types.js";

/**
 * The storage contract (spec/store-contract.md). A store is created once and
 * shared across requests; it must initialise itself lazily on first use.
 */
export interface FeedbackStore {
  /** Persist a new record. Must reject if a record with the same id exists. */
  insert(record: FeedbackRecord): Promise<void>;
  get(id: string): Promise<FeedbackRecord | null>;
  /** Newest first, ordered by (created_at, id) descending. */
  list(query: FeedbackListQuery): Promise<FeedbackPage>;
  /** Apply a triage patch. Resolves null when the id is unknown. */
  updateTriage(id: string, patch: FeedbackTriagePatch): Promise<FeedbackRecord | null>;
  stats(filter: FeedbackFilter): Promise<FeedbackStats>;
  close?(): Promise<void>;
}

/** What became of a submission, for a sink with more to say than "stored". */
export interface FeedbackReceipt {
  /** `queued`: accepted but not yet delivered, e.g. saved locally until a remote service is reachable. */
  delivery: "stored" | "queued";
  /** Shown to the submitting agent, e.g. where a queued report is waiting. Must be safe to show. */
  note?: string;
}

/**
 * The write half of the contract, which is all `registerFeedback` needs. Every store is a sink;
 * a sink that cannot be read locally (remoteStore) is not a store.
 */
export interface FeedbackSink {
  insert(record: FeedbackRecord): Promise<void | FeedbackReceipt>;
}

/** A submission could not be delivered. Its message is safe to show to the caller. */
export class FeedbackDeliveryError extends Error {}

/** Identity helper that type-checks a custom store against the contract. */
export function defineFeedbackStore<T extends FeedbackStore>(store: T): T {
  return store;
}

// Helpers shared by the bundled stores and useful to custom ones.

export function toolNamesOf(record: FeedbackRecord): string[] {
  return [...new Set((record.context.tool_calls ?? []).map((call) => call.name))];
}

export function encodeCursor(record: Pick<FeedbackRecord, "created_at" | "id">): string {
  return Buffer.from(`${record.created_at}|${record.id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { created_at: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const split = decoded.indexOf("|");
  if (split <= 0 || split === decoded.length - 1) throw new Error("Invalid feedback cursor");
  return { created_at: decoded.slice(0, split), id: decoded.slice(split + 1) };
}

/** Sort comparator for the contract's ordering: newest first, id as tiebreak. */
export function compareNewestFirst(a: FeedbackRecord, b: FeedbackRecord): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

export function matchesFilter(record: FeedbackRecord, filter: FeedbackFilter): boolean {
  if (filter.kind !== undefined && record.kind !== filter.kind) return false;
  if (filter.status !== undefined && record.status !== filter.status) return false;
  if (filter.severity !== undefined && record.severity !== filter.severity) return false;
  if (filter.subject !== undefined && record.identity.subject !== filter.subject) return false;
  if (filter.server !== undefined && record.server.name !== filter.server) return false;
  if (filter.tool !== undefined && !toolNamesOf(record).includes(filter.tool)) return false;
  if (filter.tag !== undefined && !record.tags.includes(filter.tag)) return false;
  if (filter.since !== undefined && record.created_at < filter.since) return false;
  if (filter.until !== undefined && record.created_at >= filter.until) return false;
  if (filter.reference !== undefined && record.context.references?.[filter.reference.key] !== filter.reference.value) {
    return false;
  }
  return true;
}
