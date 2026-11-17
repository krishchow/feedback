import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/index.js";
import { postgresStore } from "../src/stores/postgres.js";
import { sqliteStore } from "../src/stores/sqlite.js";
import { conformanceRecords, runStoreConformance } from "../src/testing.js";

describe("store conformance", () => {
  it("memory", async () => {
    await runStoreConformance(memoryStore());
  });

  it("sqlite in memory", async () => {
    const store = sqliteStore({ path: ":memory:" });
    await runStoreConformance(store);
    await store.close?.();
  });

  it("sqlite file persists across store instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-feedback-"));
    try {
      const path = join(dir, "feedback.db");
      const first = sqliteStore({ path });
      await runStoreConformance(first);
      await first.close?.();

      const second = sqliteStore({ path });
      expect((await second.stats({})).total).toBe(conformanceRecords.length);
      await second.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("postgres (PGlite)", async () => {
    const db = new PGlite();
    try {
      await runStoreConformance(postgresStore({ client: db, table: "feedback_conformance" }));
    } finally {
      await db.close();
    }
  });

  // Set by `docker compose up` users; see docker-compose.yml.
  const serverUrl = process.env.MCP_FEEDBACK_TEST_POSTGRES_URL;

  it.skipIf(!serverUrl)("postgres (server)", async () => {
    const pool = new pg.Pool({ connectionString: serverUrl });
    const table = `feedback_conformance_${process.pid}`;
    try {
      await runStoreConformance(postgresStore({ client: pool, table }));
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.end();
    }
  });

  it("postgres with migrate: false leaves the schema to the host", async () => {
    const db = new PGlite();
    try {
      const store = postgresStore({ client: db, migrate: false });
      await expect(store.stats({})).rejects.toThrow(/mcp_feedback/);
    } finally {
      await db.close();
    }
  });

  it("the conformance suite catches a broken store", async () => {
    const broken = memoryStore();
    const list = broken.list.bind(broken);
    broken.list = async (query) => {
      const page = await list(query);
      return { ...page, items: [...page.items].reverse() };
    };
    await expect(runStoreConformance(broken)).rejects.toThrow(/Store conformance failed/);
  });

  it("rejects unsafe table names", () => {
    expect(() => sqliteStore({ table: "x; DROP TABLE y" })).toThrow(/Invalid feedback table name/);
  });
});
