import { createDatabase } from './shared/infrastructure/database/database.js';
import { migrateDown, migrateToLatest } from './shared/infrastructure/database/migrator.js';
import { createLogger } from './shared/infrastructure/logging/logger.js';

const logger = createLogger({ level: 'info' });
const url = process.env.DATABASE_URL;
if (!url) {
  logger.fatal('DATABASE_URL is required');
  process.exit(1);
}

const db = createDatabase({
  url,
  poolMax: 1,
  ssl: process.env.DATABASE_SSL === 'true',
  statementTimeoutMs: 60_000,
  applicationName: 'ggi-migrations',
});

try {
  const down = process.argv[2] === 'down';
  const applied = down ? await migrateDown(db) : await migrateToLatest(db);
  logger.info({ direction: down ? 'down' : 'up', migrations: applied }, 'migrations complete');
} catch (error) {
  logger.fatal({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
