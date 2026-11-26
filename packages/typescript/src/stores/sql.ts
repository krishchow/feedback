// SQL shared by the SQLite and Postgres stores. Statements are written with
// `?` placeholders; the Postgres store renumbers them to `$n`.

import { decodeCursor, encodeCursor, toolNamesOf } from "../store.js";
import type {
  FeedbackFilter,
  FeedbackListQuery,
  FeedbackPage,
  FeedbackRecord,
  FeedbackStats,
  FeedbackTriagePatch,
} from "../types.js";

export type Dialect = "sqlite" | "postgres";
export type Row = Record<string, unknown>;

/** Runs one statement and resolves its rows (empty for writes). */
export type Run = (sql: string, params: unknown[]) => Promise<Row[]>;

export const DEFAULT_TABLE = "mcp_feedback";

export function checkTableName(table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) throw new Error(`Invalid feedback table name: ${table}`);
  return table;
}

const COLUMNS = [
  "id",
  "schema_version",
  "created_at",
  "updated_at",
  "kind",
  "title",
  "body",
  "severity",
  "status",
  "tags",
  "tool_names",
  "context",
  "subject",
  "client_id",
  "session_id",
  "token_fingerprint",
  "scopes",
  "client_name",
  "client_version",
  "user_agent",
  "server_name",
  "server_version",
  "triage_note",
  "triaged_by",
] as const;

const JSON_COLUMNS = new Set<string>(["tags", "tool_names", "context", "scopes"]);

/** DDL matching spec/sql/*.sql. */
export function schemaStatements(dialect: Dialect, table: string): string[] {
  const json = dialect === "postgres" ? "JSONB" : "TEXT";
  // Postgres keeps real timestamps at millisecond precision, so they round-trip the canonical form exactly.
  const time = dialect === "postgres" ? "TIMESTAMPTZ(3)" : "TEXT";
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  created_at ${time} NOT NULL,
  updated_at ${time} NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  tags ${json} NOT NULL,
  tool_names ${json} NOT NULL,
  context ${json} NOT NULL,
  subject TEXT,
  client_id TEXT,
  session_id TEXT,
  token_fingerprint TEXT,
  scopes ${json} NOT NULL,
  client_name TEXT,
  client_version TEXT,
  user_agent TEXT,
  server_name TEXT,
  server_version TEXT,
  triage_note TEXT,
  triaged_by TEXT
)`,
    `CREATE INDEX IF NOT EXISTS ${table}_created_idx ON ${table} (created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS ${table}_status_idx ON ${table} (status)`,
    `CREATE INDEX IF NOT EXISTS ${table}_kind_idx ON ${table} (kind)`,
    // An ingest hub keeps many servers' feedback in one table and reads it a server at a time.
    `CREATE INDEX IF NOT EXISTS ${table}_server_idx ON ${table} (server_name)`,
  ];
}

function toRow(record: FeedbackRecord): Row {
  return {
    id: record.id,
    schema_version: record.schema_version,
    created_at: record.created_at,
    updated_at: record.updated_at,
    kind: record.kind,
    title: record.title,
    body: record.body,
    severity: record.severity,
    status: record.status,
    tags: JSON.stringify(record.tags),
    tool_names: JSON.stringify(toolNamesOf(record)),
    context: JSON.stringify(record.context),
    subject: record.identity.subject,
    client_id: record.identity.client_id,
    session_id: record.identity.session_id,
    token_fingerprint: record.identity.token_fingerprint,
    scopes: JSON.stringify(record.identity.scopes),
    client_name: record.identity.client_name,
    client_version: record.identity.client_version,
    user_agent: record.identity.user_agent,
    server_name: record.server.name,
    server_version: record.server.version,
    triage_note: record.triage_note,
    triaged_by: record.triaged_by,
  };
}

// SQLite returns JSON columns as text, Postgres as parsed values.
const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const text = (value: unknown): string | null => (value == null ? null : String(value));
// Postgres drivers return TIMESTAMPTZ as Date; SQLite stores the canonical string.
const timestamp = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

function fromRow(row: Row): FeedbackRecord {
  return {
    schema_version: Number(row.schema_version) as FeedbackRecord["schema_version"],
    id: String(row.id),
    created_at: timestamp(row.created_at),
    kind: row.kind as FeedbackRecord["kind"],
    title: String(row.title),
    body: String(row.body),
    severity: row.severity as FeedbackRecord["severity"],
    tags: parsed(row.tags),
    context: parsed(row.context),
    identity: {
      subject: text(row.subject),
      client_id: text(row.client_id),
      session_id: text(row.session_id),
      token_fingerprint: text(row.token_fingerprint),
      scopes: parsed(row.scopes),
      client_name: text(row.client_name),
      client_version: text(row.client_version),
      user_agent: text(row.user_agent),
    },
    server: { name: text(row.server_name), version: text(row.server_version) },
    status: row.status as FeedbackRecord["status"],
    triage_note: text(row.triage_note),
    triaged_by: text(row.triaged_by),
    updated_at: timestamp(row.updated_at),
  };
}

function where(dialect: Dialect, filter: FeedbackFilter): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, ...values: unknown[]) => {
    clauses.push(clause);
    params.push(...values);
  };
  const contains = (column: string, value: string) =>
    dialect === "postgres"
      ? add(`f.${column} @> ?::jsonb`, JSON.stringify([value]))
      : add(`EXISTS (SELECT 1 FROM json_each(f.${column}) WHERE value = ?)`, value);

  if (filter.kind !== undefined) add("f.kind = ?", filter.kind);
  if (filter.status !== undefined) add("f.status = ?", filter.status);
  if (filter.severity !== undefined) add("f.severity = ?", filter.severity);
  if (filter.subject !== undefined) add("f.subject = ?", filter.subject);
  if (filter.server !== undefined) add("f.server_name = ?", filter.server);
  if (filter.tool !== undefined) contains("tool_names", filter.tool);
  if (filter.tag !== undefined) contains("tags", filter.tag);
  if (filter.since !== undefined) add("f.created_at >= ?", filter.since);
  if (filter.until !== undefined) add("f.created_at < ?", filter.until);
  if (filter.reference !== undefined) {
    // Keys are checked against REFERENCE_KEY_PATTERN before they reach a store.
    if (dialect === "postgres") add("f.context -> 'references' ->> ? = ?", filter.reference.key, filter.reference.value);
    else add("json_extract(f.context, ?) = ?", `$.references."${filter.reference.key}"`, filter.reference.value);
  }
  return { clauses, params };
}

const whereSql = (clauses: string[]) => (clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "");

export function sqlOperations(dialect: Dialect, table: string, run: Run) {
  const placeholder = (column: string) => (dialect === "postgres" && JSON_COLUMNS.has(column) ? "?::jsonb" : "?");

  const get = async (id: string): Promise<FeedbackRecord | null> => {
    const [row] = await run(`SELECT * FROM ${table} f WHERE f.id = ?`, [id]);
    return row ? fromRow(row) : null;
  };

  return {
    async insert(record: FeedbackRecord): Promise<void> {
      const row = toRow(record);
      await run(
        `INSERT INTO ${table} (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(placeholder).join(", ")})`,
        COLUMNS.map((column) => row[column]),
      );
    },

    get,

    async list(query: FeedbackListQuery): Promise<FeedbackPage> {
      const { clauses, params } = where(dialect, query);
      if (query.cursor) {
        const after = decodeCursor(query.cursor);
        clauses.push("(f.created_at < ? OR (f.created_at = ? AND f.id < ?))");
        params.push(after.created_at, after.created_at, after.id);
      }
      const rows = await run(
        `SELECT * FROM ${table} f${whereSql(clauses)} ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
        [...params, query.limit + 1],
      );
      const items = rows.slice(0, query.limit).map(fromRow);
      const last = items[items.length - 1];
      return { items, next_cursor: rows.length > query.limit && last ? encodeCursor(last) : null };
    },

    async updateTriage(id: string, patch: FeedbackTriagePatch): Promise<FeedbackRecord | null> {
      const sets = ["triaged_by = ?", "updated_at = ?"];
      const params: unknown[] = [patch.triaged_by, patch.updated_at];
      if (patch.status !== undefined) {
        sets.push("status = ?");
        params.push(patch.status);
      }
      if (patch.triage_note !== undefined) {
        sets.push("triage_note = ?");
        params.push(patch.triage_note);
      }
      await run(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
      return get(id);
    },

    async stats(filter: FeedbackFilter): Promise<FeedbackStats> {
      const { clauses, params } = where(dialect, filter);
      const filterSql = whereSql(clauses);
      const counts = async (sql: string): Promise<Record<string, number>> =>
        Object.fromEntries((await run(sql, params)).map((row) => [String(row.k), Number(row.c)]));
      const grouped = (column: string) =>
        counts(`SELECT f.${column} AS k, COUNT(*) AS c FROM ${table} f${filterSql} GROUP BY f.${column}`);
      const each =
        dialect === "postgres"
          ? "CROSS JOIN LATERAL jsonb_array_elements_text(f.tool_names) AS j(value)"
          : ", json_each(f.tool_names) AS j";

      const [total] = await run(`SELECT COUNT(*) AS c FROM ${table} f${filterSql}`, params);
      return {
        total: Number(total?.c ?? 0),
        by_kind: await grouped("kind"),
        by_status: await grouped("status"),
        by_severity: await grouped("severity"),
        by_tool: await counts(`SELECT j.value AS k, COUNT(*) AS c FROM ${table} f ${each}${filterSql} GROUP BY j.value`),
        by_server: await counts(
          `SELECT f.server_name AS k, COUNT(*) AS c FROM ${table} f${whereSql([...clauses, "f.server_name IS NOT NULL"])} GROUP BY f.server_name`,
        ),
      };
    },
  };
}
