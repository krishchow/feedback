// Data shapes defined by spec/feedback-record.schema.json. Field names are
// snake_case on purpose: they are the wire and storage format shared by every
// language implementation.

export const FEEDBACK_SCHEMA_VERSION = 1;

export const FEEDBACK_KINDS = ["bug", "tool_failure", "feature_request", "friction", "praise", "other"] as const;
export const FEEDBACK_SEVERITIES = ["blocker", "major", "minor", "none"] as const;
export const FEEDBACK_STATUSES = ["new", "triaged", "resolved", "dismissed"] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface FeedbackToolCall {
  name: string;
  arguments_summary?: string;
  error?: string;
  is_error?: boolean;
}

export interface FeedbackContext {
  goal?: string;
  expected?: string;
  actual?: string;
  workaround?: string;
  suggestion?: string;
  tool_calls?: FeedbackToolCall[];
  repro_steps?: string[];
  excerpt?: string;
  metadata?: Record<string, unknown>;
  /** Ids of the objects involved, keyed by what they are (e.g. `orderId`). Supplied by the agent. */
  references?: Record<string, string>;
  /** Attached by the server's `attachContext` hook; never taken from tool input. */
  server_context?: Record<string, unknown>;
}

/** Who submitted the feedback. Always stamped by the server, never read from tool input. */
export interface FeedbackIdentity {
  subject: string | null;
  client_id: string | null;
  session_id: string | null;
  token_fingerprint: string | null;
  scopes: string[];
  client_name: string | null;
  client_version: string | null;
  user_agent: string | null;
}

export interface FeedbackServerInfo {
  name: string | null;
  version: string | null;
}

export interface FeedbackRecord {
  schema_version: typeof FEEDBACK_SCHEMA_VERSION;
  id: string;
  /** UTC, always `YYYY-MM-DDTHH:mm:ss.sssZ`, so string order is time order. */
  created_at: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  severity: FeedbackSeverity;
  tags: string[];
  context: FeedbackContext;
  identity: FeedbackIdentity;
  server: FeedbackServerInfo;
  status: FeedbackStatus;
  triage_note: string | null;
  triaged_by: string | null;
  updated_at: string;
}

export interface FeedbackFilter {
  kind?: FeedbackKind;
  status?: FeedbackStatus;
  severity?: FeedbackSeverity;
  subject?: string;
  /** Matches records whose server.name equals this: one server, or one project on an ingest hub. */
  server?: string;
  /** Matches records whose context.tool_calls names include this tool. */
  tool?: string;
  tag?: string;
  /** Inclusive lower bound on created_at. */
  since?: string;
  /** Exclusive upper bound on created_at. */
  until?: string;
  /** Matches records whose context.references[key] equals value. */
  reference?: { key: string; value: string };
}

export interface FeedbackListQuery extends FeedbackFilter {
  limit: number;
  cursor?: string;
}

export interface FeedbackPage {
  items: FeedbackRecord[];
  next_cursor: string | null;
}

export interface FeedbackTriagePatch {
  status?: FeedbackStatus;
  /** `null` clears the note; `undefined` leaves it unchanged. */
  triage_note?: string | null;
  triaged_by: string | null;
  updated_at: string;
}

export interface FeedbackStats {
  total: number;
  by_kind: Record<string, number>;
  by_status: Record<string, number>;
  by_severity: Record<string, number>;
  by_tool: Record<string, number>;
  /** Counts by server.name. Records with no server name are not counted here. */
  by_server: Record<string, number>;
}
