// Store conformance vectors. spec/conformance/store-cases.json is generated
// from this file; every store, in any language, must pass these cases.

import type { FeedbackFilter, FeedbackRecord, FeedbackStats, FeedbackTriagePatch } from "./types.js";

export type StoreCase =
  | { name: string; op: "list"; filter: FeedbackFilter; limit: number; expect_pages: string[][] }
  | { name: string; op: "get"; id: string; expect_found: boolean }
  | { name: string; op: "stats"; filter: FeedbackFilter; expect: FeedbackStats }
  | { name: string; op: "insert_duplicate"; id: string }
  | {
      name: string;
      op: "update_triage";
      id: string;
      patch: FeedbackTriagePatch;
      /** Fields the returned and re-read record must have; null when the id is unknown. */
      expect: Partial<FeedbackRecord> | null;
    };

const id = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;

function record(
  n: number,
  created_at: string,
  fields: Pick<FeedbackRecord, "kind" | "severity" | "tags"> & { subject: string | null; tools: string[] },
  context: FeedbackRecord["context"] = {},
): FeedbackRecord {
  return {
    schema_version: 1,
    id: id(n),
    created_at,
    kind: fields.kind,
    title: `Record ${n}`,
    body: `Body of record ${n}`,
    severity: fields.severity,
    tags: fields.tags,
    context: {
      ...context,
      ...(fields.tools.length ? { tool_calls: fields.tools.map((name) => ({ name })) } : {}),
    },
    identity: {
      subject: fields.subject,
      client_id: fields.subject ? "client-1" : null,
      session_id: null,
      token_fingerprint: fields.subject ? "0123456789abcdef" : null,
      scopes: fields.subject ? ["feedback:write"] : [],
      client_name: "conformance",
      client_version: "1.0.0",
      user_agent: null,
    },
    server: { name: "conformance-server", version: "1.0.0" },
    status: "new",
    triage_note: null,
    triaged_by: null,
    updated_at: created_at,
  };
}

// Records 3 and 4 share a created_at so ordering and cursors must fall back to id.
export const conformanceRecords: FeedbackRecord[] = [
  record(
    1,
    "2026-01-01T00:00:00.000Z",
    { kind: "bug", severity: "major", tags: ["ui"], subject: "alice", tools: ["create_order"] },
    { references: { documentId: "doc-2" } },
  ),
  record(
    2,
    "2026-01-02T00:00:00.000Z",
    { kind: "tool_failure", severity: "blocker", tags: ["timeout", "ui"], subject: "bob", tools: ["create_order", "list_orders"] },
    {
      goal: "Place an order — with “quotes”, 'apostrophes' and emoji 🎭",
      expected: "A job id",
      actual: "504 after 30s",
      repro_steps: ["call create_order", "wait"],
      excerpt: "line one\nline two",
      metadata: { attempt: 2, nested: { ok: false, values: [1, "two", null] } },
      references: { documentId: "doc-1", jobId: "job-9" },
      server_context: { version: "1.2.3", job: { id: "job-9", state: "failed", attempts: [1, 2] } },
    },
  ),
  record(3, "2026-01-03T00:00:00.000Z", { kind: "feature_request", severity: "none", tags: [], subject: "alice", tools: [] }),
  record(4, "2026-01-03T00:00:00.000Z", { kind: "friction", severity: "minor", tags: ["docs"], subject: null, tools: ["list_orders"] }),
  record(5, "2026-01-04T00:00:00.000Z", { kind: "praise", severity: "none", tags: [], subject: "bob", tools: [] }),
  record(
    6,
    "2026-01-05T00:00:00.000Z",
    { kind: "bug", severity: "minor", tags: ["timeout"], subject: "alice", tools: ["create_order"] },
    { references: { documentId: "doc-1" } },
  ),
];

const ids = (...numbers: number[]) => numbers.map(id);

// Cases run in order against one store seeded with conformanceRecords.
// Read-only cases come first; the triage cases at the end mutate record 1.
export const conformanceCases: StoreCase[] = [
  { name: "lists newest first with id as tiebreak", op: "list", filter: {}, limit: 10, expect_pages: [ids(6, 5, 4, 3, 2, 1)] },
  { name: "paginates across a created_at tie", op: "list", filter: {}, limit: 3, expect_pages: [ids(6, 5, 4), ids(3, 2, 1)] },
  { name: "paginates one record at a time", op: "list", filter: { subject: "alice" }, limit: 1, expect_pages: [ids(6), ids(3), ids(1)] },
  { name: "filters by kind", op: "list", filter: { kind: "bug" }, limit: 10, expect_pages: [ids(6, 1)] },
  { name: "filters by severity", op: "list", filter: { severity: "minor" }, limit: 10, expect_pages: [ids(6, 4)] },
  { name: "filters by status", op: "list", filter: { status: "resolved" }, limit: 10, expect_pages: [[]] },
  { name: "filters by subject", op: "list", filter: { subject: "alice" }, limit: 10, expect_pages: [ids(6, 3, 1)] },
  { name: "filters by tool", op: "list", filter: { tool: "create_order" }, limit: 10, expect_pages: [ids(6, 2, 1)] },
  { name: "filters by tag", op: "list", filter: { tag: "timeout" }, limit: 10, expect_pages: [ids(6, 2)] },
  { name: "since is inclusive", op: "list", filter: { since: "2026-01-03T00:00:00.000Z" }, limit: 10, expect_pages: [ids(6, 5, 4, 3)] },
  { name: "until is exclusive", op: "list", filter: { until: "2026-01-03T00:00:00.000Z" }, limit: 10, expect_pages: [ids(2, 1)] },
  { name: "combines filters with AND", op: "list", filter: { kind: "bug", tag: "timeout" }, limit: 10, expect_pages: [ids(6)] },
  {
    name: "filters by a reference",
    op: "list",
    filter: { reference: { key: "documentId", value: "doc-1" } },
    limit: 10,
    expect_pages: [ids(6, 2)],
  },
  { name: "a reference matches one key only", op: "list", filter: { reference: { key: "jobId", value: "doc-1" } }, limit: 10, expect_pages: [[]] },
  {
    name: "combines a reference with other filters",
    op: "list",
    filter: { kind: "bug", reference: { key: "documentId", value: "doc-1" } },
    limit: 10,
    expect_pages: [ids(6)],
  },
  { name: "round-trips a full record", op: "get", id: id(2), expect_found: true },
  { name: "round-trips a record with null identity", op: "get", id: id(4), expect_found: true },
  { name: "get resolves null for an unknown id", op: "get", id: id(9), expect_found: false },
  {
    name: "stats over everything",
    op: "stats",
    filter: {},
    expect: {
      total: 6,
      by_kind: { bug: 2, tool_failure: 1, feature_request: 1, friction: 1, praise: 1 },
      by_status: { new: 6 },
      by_severity: { major: 1, blocker: 1, none: 2, minor: 2 },
      by_tool: { create_order: 3, list_orders: 2 },
    },
  },
  {
    name: "stats honours filters",
    op: "stats",
    filter: { subject: "alice" },
    expect: {
      total: 3,
      by_kind: { bug: 2, feature_request: 1 },
      by_status: { new: 3 },
      by_severity: { major: 1, none: 1, minor: 1 },
      by_tool: { create_order: 2 },
    },
  },
  {
    name: "stats honour a reference",
    op: "stats",
    filter: { reference: { key: "documentId", value: "doc-1" } },
    expect: {
      total: 2,
      by_kind: { tool_failure: 1, bug: 1 },
      by_status: { new: 2 },
      by_severity: { blocker: 1, minor: 1 },
      by_tool: { create_order: 2, list_orders: 1 },
    },
  },
  {
    name: "stats with no matches is empty",
    op: "stats",
    filter: { tag: "nope" },
    expect: { total: 0, by_kind: {}, by_status: {}, by_severity: {}, by_tool: {} },
  },
  { name: "rejects a duplicate id", op: "insert_duplicate", id: id(1) },
  {
    name: "triage sets status and note",
    op: "update_triage",
    id: id(1),
    patch: { status: "triaged", triage_note: "Known issue", triaged_by: "reader", updated_at: "2026-02-01T00:00:00.000Z" },
    expect: { status: "triaged", triage_note: "Known issue", triaged_by: "reader", updated_at: "2026-02-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z", title: "Record 1" },
  },
  { name: "triaged record is found by status", op: "list", filter: { status: "triaged" }, limit: 10, expect_pages: [ids(1)] },
  {
    name: "omitted patch fields are left unchanged",
    op: "update_triage",
    id: id(1),
    patch: { triaged_by: "reader-2", updated_at: "2026-02-02T00:00:00.000Z" },
    expect: { status: "triaged", triage_note: "Known issue", triaged_by: "reader-2", updated_at: "2026-02-02T00:00:00.000Z" },
  },
  {
    name: "a null note clears it",
    op: "update_triage",
    id: id(1),
    patch: { triage_note: null, triaged_by: "reader", updated_at: "2026-02-03T00:00:00.000Z" },
    expect: { status: "triaged", triage_note: null },
  },
  {
    name: "triage resolves null for an unknown id",
    op: "update_triage",
    id: id(9),
    patch: { status: "resolved", triaged_by: "reader", updated_at: "2026-02-04T00:00:00.000Z" },
    expect: null,
  },
];
