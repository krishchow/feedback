import type { FeedbackStore } from "../store.js";
import { DEFAULT_TABLE, checkTableName, schemaStatements, sqlOperations, type Row } from "./sql.js";

/** The slice of a Postgres client this store needs. A `pg.Pool` satisfies it. */
export interface PostgresClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PostgresStoreOptions {
  client: PostgresClient;
  table?: string;
  /** Set false when the host manages the schema itself (see spec/sql/postgres.sql). */
  migrate?: boolean;
}

export function postgresStore(options: PostgresStoreOptions): FeedbackStore {
  const { client } = options;
  const table = checkTableName(options.table ?? DEFAULT_TABLE);
  let ready: Promise<void> | undefined;

  const migrate = (): Promise<void> => {
    if (options.migrate === false) return Promise.resolve();
    ready ??= (async () => {
      for (const statement of schemaStatements("postgres", table)) await client.query(statement);
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  return sqlOperations("postgres", table, async (sql, params) => {
    await migrate();
    let index = 0;
    const result = await client.query(
      sql.replace(/\?/g, () => `$${++index}`),
      params,
    );
    return result.rows as Row[];
  });
}
