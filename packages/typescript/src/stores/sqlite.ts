import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { FeedbackStore } from "../store.js";
import { DEFAULT_TABLE, checkTableName, schemaStatements, sqlOperations, type Row } from "./sql.js";

export interface SqliteStoreOptions {
  /** Database file. Defaults to `./mcp-feedback.db`; use `:memory:` for a throwaway store. */
  path?: string;
  table?: string;
}

/** Default store: a standalone SQLite file, using Node's built-in `node:sqlite`. */
export function sqliteStore(options: SqliteStoreOptions = {}): FeedbackStore {
  const path = options.path ?? "./mcp-feedback.db";
  const table = checkTableName(options.table ?? DEFAULT_TABLE);
  let db: DatabaseSync | undefined;

  // Opened on first use so importing a server module never touches the disk.
  const open = (): DatabaseSync => {
    if (!db) {
      const opened = new DatabaseSync(path);
      opened.exec("PRAGMA busy_timeout = 5000");
      if (path !== ":memory:") opened.exec("PRAGMA journal_mode = WAL");
      for (const statement of schemaStatements("sqlite", table)) opened.exec(statement);
      db = opened;
    }
    return db;
  };

  const operations = sqlOperations("sqlite", table, async (sql, params) => {
    const statement = open().prepare(sql);
    if (/^\s*SELECT/i.test(sql)) return statement.all(...(params as SQLInputValue[])) as Row[];
    statement.run(...(params as SQLInputValue[]));
    return [];
  });

  return {
    ...operations,
    async close() {
      db?.close();
      db = undefined;
    },
  };
}
