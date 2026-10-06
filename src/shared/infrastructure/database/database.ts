import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { UnitOfWork } from '../../application/ports.js';
import type { Database } from './schema.js';

// Keep DATE columns as 'YYYY-MM-DD' strings: the default parser would build a
// Date at local midnight and silently shift calendar months across time zones.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export type Db = Kysely<Database>;
export type DbExecutor = Kysely<Database> | Transaction<Database>;

export interface DatabaseOptions {
  url: string;
  poolMax: number;
  ssl: boolean;
  statementTimeoutMs: number;
  applicationName?: string;
}

export function createDatabase(options: DatabaseOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
    application_name: options.applicationName ?? 'ggi-api',
    // Hard limits so a bad query or a forgotten transaction cannot hold locks forever.
    statement_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs * 3,
    connectionTimeoutMillis: 5_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_SQLSTATES.has(error.code)
  );
}

/** Unit of work backed by a Kysely transaction, retried on serialization failures and deadlocks. */
export class KyselyUnitOfWork<TRepositories> implements UnitOfWork<TRepositories> {
  constructor(
    private readonly db: Db,
    private readonly bind: (trx: Transaction<Database>) => TRepositories,
    private readonly maxAttempts = 3,
  ) {}

  async run<T>(work: (repositories: TRepositories) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.db.transaction().execute((trx) => work(this.bind(trx)));
      } catch (error) {
        if (attempt >= this.maxAttempts || !isRetryable(error)) throw error;
      }
    }
  }
}
