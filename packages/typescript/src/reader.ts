// Reader operations shared by the MCP reader tools and the CLI.

import type { FeedbackStore } from "./store.js";
import type { FeedbackFilter, FeedbackPage, FeedbackRecord, FeedbackStatus } from "./types.js";

/** A problem with the caller's input; its message is safe to show to the caller. */
export class FeedbackInputError extends Error {}

function normalizeTimestamp(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new FeedbackInputError(`${label} is not a valid ISO 8601 timestamp.`);
  return new Date(time).toISOString();
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
      tool: args.tool,
      tag: args.tag,
      since: normalizeTimestamp("since", args.since),
      until: normalizeTimestamp("until", args.until),
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
