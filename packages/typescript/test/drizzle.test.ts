import { PGlite } from "@electric-sql/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { feedbackTable } from "../src/drizzle.js";
import { postgresStore } from "../src/stores/postgres.js";
import { schemaStatements } from "../src/stores/sql.js";
import { runStoreConformance } from "../src/testing.js";

type Query = (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

// Everything about a table that the store and its queries depend on.
async function describeTable(query: Query, table: string) {
  const columns = await query(
    `SELECT column_name, data_type, datetime_precision, is_nullable, column_default
     FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
    [table],
  );
  const indexes = await query(`SELECT indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`, [table]);
  return {
    columns: columns.rows,
    // Normalise the table name and drizzle's quoting so only real differences remain.
    indexes: (indexes.rows as { indexdef: string }[]).map((row) =>
      row.indexdef.replaceAll(table, "T").replaceAll('"', "").replace(/_pkey\b/, "_pk"),
    ),
  };
}

async function drizzleStatements(table: string): Promise<string[]> {
  return generateMigration(generateDrizzleJson({}), generateDrizzleJson({ table: feedbackTable(table) }));
}

async function checkMatches(query: Query) {
  for (const statement of schemaStatements("postgres", "from_spec")) await query(statement);
  for (const statement of await drizzleStatements("from_drizzle")) await query(statement);
  expect(await describeTable(query, "from_drizzle")).toEqual(await describeTable(query, "from_spec"));
}

describe("drizzle schema", () => {
  it("creates the same table as the store's own DDL (PGlite)", async () => {
    const db = new PGlite();
    try {
      await checkMatches((text, params) => db.query(text, params));
    } finally {
      await db.close();
    }
  });

  it("passes conformance on a drizzle-created table with migrate: false", async () => {
    const db = new PGlite();
    try {
      for (const statement of await drizzleStatements("mcp_feedback")) await db.query(statement);
      await runStoreConformance(postgresStore({ client: db, migrate: false }));
    } finally {
      await db.close();
    }
  });

  const serverUrl = process.env.MCP_FEEDBACK_TEST_POSTGRES_URL;

  it.skipIf(!serverUrl)("creates the same table as the store's own DDL (server)", async () => {
    const pool = new pg.Pool({ connectionString: serverUrl });
    const client = await pool.connect();
    try {
      // A throwaway schema keeps parallel runs and leftovers apart.
      const schema = `drizzle_check_${process.pid}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      try {
        await checkMatches((text, params) => client.query(text, params));
      } finally {
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
      }
    } finally {
      client.release();
      await pool.end();
    }
  });
});
