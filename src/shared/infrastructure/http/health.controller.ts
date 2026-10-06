import { Router } from 'express';
import { sql } from 'kysely';
import type { Db } from '../database/database.js';
import { endpoint } from './endpoint.js';

/** Health check. Authenticated like every other endpoint (no open routes). */
export function healthRoutes(deps: { db: Db; startedAt: Date }): Router {
  const router = Router();
  router.get(
    '/',
    endpoint({}, async () => {
      let database: 'ok' | 'unavailable' = 'ok';
      try {
        await sql`SELECT 1`.execute(deps.db);
      } catch {
        database = 'unavailable';
      }
      const healthy = database === 'ok';
      return {
        status: healthy ? 200 : 503,
        body: {
          status: healthy ? 'ok' : 'degraded',
          checks: { database },
          uptimeSeconds: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
        },
      };
    }),
  );
  return router;
}
