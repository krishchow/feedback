import {
  compareNewestFirst,
  decodeCursor,
  encodeCursor,
  matchesFilter,
  toolNamesOf,
  type FeedbackStore,
} from "../store.js";
import type { FeedbackRecord, FeedbackStats } from "../types.js";

/** Non-persistent store for tests and local experiments. */
export function memoryStore(): FeedbackStore {
  const records = new Map<string, FeedbackRecord>();
  const copy = (record: FeedbackRecord): FeedbackRecord => structuredClone(record);

  return {
    async insert(record) {
      if (records.has(record.id)) throw new Error(`Feedback ${record.id} already exists`);
      records.set(record.id, copy(record));
    },
    async get(id) {
      const record = records.get(id);
      return record ? copy(record) : null;
    },
    async list(query) {
      let matched = [...records.values()].filter((record) => matchesFilter(record, query)).sort(compareNewestFirst);
      if (query.cursor) {
        const after = decodeCursor(query.cursor);
        matched = matched.filter(
          (record) =>
            record.created_at < after.created_at || (record.created_at === after.created_at && record.id < after.id),
        );
      }
      const items = matched.slice(0, query.limit).map(copy);
      const last = items[items.length - 1];
      return { items, next_cursor: matched.length > query.limit && last ? encodeCursor(last) : null };
    },
    async updateTriage(id, patch) {
      const record = records.get(id);
      if (!record) return null;
      if (patch.status !== undefined) record.status = patch.status;
      if (patch.triage_note !== undefined) record.triage_note = patch.triage_note;
      record.triaged_by = patch.triaged_by;
      record.updated_at = patch.updated_at;
      return copy(record);
    },
    async stats(filter) {
      const stats: FeedbackStats = { total: 0, by_kind: {}, by_status: {}, by_severity: {}, by_tool: {}, by_server: {} };
      const bump = (counts: Record<string, number>, key: string) => {
        counts[key] = (counts[key] ?? 0) + 1;
      };
      for (const record of records.values()) {
        if (!matchesFilter(record, filter)) continue;
        stats.total += 1;
        bump(stats.by_kind, record.kind);
        bump(stats.by_status, record.status);
        bump(stats.by_severity, record.severity);
        for (const tool of toolNamesOf(record)) bump(stats.by_tool, tool);
        if (record.server.name !== null) bump(stats.by_server, record.server.name);
      }
      return stats;
    },
  };
}
