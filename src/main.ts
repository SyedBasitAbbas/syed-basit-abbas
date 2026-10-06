import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createContainer } from './container.js';

const config = loadConfig();
const container = createContainer(config);
const { logger } = container;
const app = buildApp(container);

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(
    { port: config.server.port, env: config.env, issuer: config.oidc.issuer },
    'API listening',
  );
});
// Socket-level limits complement the per-request timeout middleware.
server.requestTimeout = config.server.requestTimeoutMs + 5_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.on('error', (error) => {
  logger.fatal({ err: error }, 'HTTP server error');
  process.exit(1);
});

if (config.billing.enabled) container.jobs.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  // Stop accepting connections and let in-flight requests finish before the pool closes.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await container.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
