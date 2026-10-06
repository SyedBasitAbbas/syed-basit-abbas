import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationResult } from 'kysely/migration';
import * as initialSchema from './migrations/0001_initial_schema.js';

/** Migrations are registered statically so they work the same under tsx and from dist/. */
const MIGRATIONS: Record<string, Migration> = {
  '0001_initial_schema': initialSchema,
};

// Migrations operate on whatever schema exists at the time, hence the untyped Kysely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>;

function createMigrator(db: AnyDb): Migrator {
  return new Migrator({ db, provider: { getMigrations: () => Promise.resolve(MIGRATIONS) } });
}

function names(results: MigrationResult[] | undefined): string[] {
  return (results ?? []).map((result) => result.migrationName);
}

/** Applies pending migrations. Kysely takes a lock, so concurrent instances are safe. */
export async function migrateToLatest(db: AnyDb): Promise<string[]> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  if (error) {
    const failed = results?.find((result) => result.status === 'Error')?.migrationName;
    throw new Error(`Migration ${failed ?? '(unknown)'} failed`, { cause: error });
  }
  return names(results);
}

export async function migrateDown(db: AnyDb): Promise<string[]> {
  const { error, results } = await createMigrator(db).migrateDown();
  if (error) throw new Error('Migration rollback failed', { cause: error });
  return names(results);
}
