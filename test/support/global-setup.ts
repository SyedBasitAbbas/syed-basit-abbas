import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../../src/shared/infrastructure/database/database.js';
import { migrateToLatest } from '../../src/shared/infrastructure/database/migrator.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Integration tests run against a real PostgreSQL (row locks, constraints and
 * transactions are part of what is being tested). Uses TEST_DATABASE_URL when
 * provided (CI service container), otherwise starts a throwaway embedded server.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  let embedded: EmbeddedPostgres | null = null;
  let dataDir: string | null = null;

  if (!databaseUrl) {
    dataDir = mkdtempSync(path.join(tmpdir(), 'ggi-pg-'));
    const port = 55_000 + Math.floor(Math.random() * 5_000);
    embedded = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: () => undefined,
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('ggi_test');
    databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/ggi_test`;
  }

  const db = createDatabase({
    url: databaseUrl,
    poolMax: 2,
    ssl: false,
    statementTimeoutMs: 30_000,
  });
  await migrateToLatest(db);
  await db.destroy();

  project.provide('databaseUrl', databaseUrl);

  return async () => {
    if (embedded) await embedded.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  };
}
