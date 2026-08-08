import postgres, { type Sql, type TransactionSql } from 'postgres';
import type { SqlExecutor } from './db.ts';

/** Production SqlExecutor backed by postgres.js against the control plane's own Postgres. */
export function createPostgresExecutor(databaseUrl: string): SqlExecutor & { end(): Promise<void> } {
  const sql = postgres(databaseUrl, { onnotice: () => {} });

  const queryVia = (client: Sql | TransactionSql) =>
    async <T>(text: string, params: unknown[] = []): Promise<T[]> => {
      const rows = await client.unsafe(text, params as never[]);
      return rows as unknown as T[];
    };

  // Statements issued inside a transaction run on the transaction's own
  // connection; a nested transaction() call just joins the open one.
  const inTransaction = (client: TransactionSql): SqlExecutor => {
    const executor: SqlExecutor = {
      query: queryVia(client),
      transaction: fn => fn(executor),
    };
    return executor;
  };

  return {
    query: queryVia(sql),
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const result = await sql.begin((tx: TransactionSql) => fn(inTransaction(tx)));
      return result as T;
    },
    end: () => sql.end(),
  };
}
