/**
 * Local PostgreSQL without Docker: starts an embedded server (real PostgreSQL
 * binaries from npm) with data kept in .data/pg, matching DATABASE_URL in
 * .env.example. Stop it with Ctrl+C.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = path.resolve('.data/pg');
const firstRun = !existsSync(path.join(dataDir, 'PG_VERSION'));

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'ggi',
  password: 'ggi',
  port: Number(process.env.DEV_DB_PORT ?? 5432),
  persistent: true,
  onLog: () => undefined,
});

if (firstRun) await server.initialise();
await server.start();
if (firstRun) await server.createDatabase('ggi');
console.log(
  `PostgreSQL ready: postgres://ggi:ggi@localhost:${process.env.DEV_DB_PORT ?? 5432}/ggi`,
);
console.log('Run "npm run migrate" once, then "npm run dev". Ctrl+C stops the database.');

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
setInterval(() => undefined, 1 << 30);
