// The Postgres table as a Drizzle schema, for hosts whose schema is managed by
// drizzle-kit. Export it from your schema so push and migrations create the
// table and never drop it, then pass `migrate: false` to postgresStore.

import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { DEFAULT_TABLE, checkTableName } from "./stores/sql.js";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: "string" }).notNull();

/** Builds the table definition; must match spec/sql/postgres.sql (tests enforce it). */
export function feedbackTable(name: string = DEFAULT_TABLE) {
  checkTableName(name);
  return pgTable(
    name,
    {
      id: text("id").primaryKey(),
      schemaVersion: integer("schema_version").notNull(),
      createdAt: time("created_at"),
      updatedAt: time("updated_at"),
      kind: text("kind").notNull(),
      title: text("title").notNull(),
      body: text("body").notNull(),
      severity: text("severity").notNull(),
      status: text("status").notNull(),
      tags: jsonb("tags").notNull(),
      toolNames: jsonb("tool_names").notNull(),
      context: jsonb("context").notNull(),
      subject: text("subject"),
      clientId: text("client_id"),
      sessionId: text("session_id"),
      tokenFingerprint: text("token_fingerprint"),
      scopes: jsonb("scopes").notNull(),
      clientName: text("client_name"),
      clientVersion: text("client_version"),
      userAgent: text("user_agent"),
      serverName: text("server_name"),
      serverVersion: text("server_version"),
      triageNote: text("triage_note"),
      triagedBy: text("triaged_by"),
    },
    (table) => [
      // NULLS FIRST is Postgres's default for DESC; spelling it out keeps the index usable for list ordering.
      index(`${name}_created_idx`).on(table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
      index(`${name}_status_idx`).on(table.status),
      index(`${name}_kind_idx`).on(table.kind),
      index(`${name}_server_idx`).on(table.serverName),
    ],
  );
}

/** The default `mcp_feedback` table. */
export const mcpFeedbackTable = feedbackTable();
