import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { ReapAbandonedReservationsUseCase } from '../../../modules/chat/application/reap-abandoned-reservations.use-case.js';
import type { RunBillingCycleUseCase } from '../../../modules/subscriptions/application/run-billing-cycle.use-case.js';
import type { Db } from '../database/database.js';

/** Removes expired security and rate-limit records. */
export async function purgeExpiredRecords(db: Db, now: Date): Promise<void> {
  await sql`DELETE FROM dpop_proof_replays WHERE expires_at < ${now}`.execute(db);
  await sql`DELETE FROM rate_limit_buckets WHERE expires_at < ${now}`.execute(db);
  // Revoked sessions are kept long after their last token expired, so a
  // refreshed token from a signed-out IdP session cannot rebind a new key.
  await sql`DELETE FROM auth_sessions WHERE expires_at < ${now}::timestamptz - interval '30 days'`.execute(
    db,
  );
}

/**
 * In-process scheduler for the billing simulation, abandoned-reservation refunds
 * and housekeeping.
 * Runs never overlap within an instance; across instances, billing is safe
 * because subscriptions are claimed with FOR UPDATE SKIP LOCKED.
 */
export class BackgroundJobs {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      intervalMs: number;
      logger: Logger;
      billing: RunBillingCycleUseCase;
      reaper: ReapAbandonedReservationsUseCase;
      db: Db;
      now: () => Date;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const report = await this.deps.billing.execute({ kind: 'scheduler' });
        if (report.processed > 0)
          this.deps.logger.info({ billing: report }, 'billing run completed');
        const reaped = await this.deps.reaper.execute();
        if (reaped > 0) this.deps.logger.warn({ reaped }, 'refunded abandoned chat reservations');
        await purgeExpiredRecords(this.deps.db, this.deps.now());
      } catch (error) {
        this.deps.logger.error({ err: error }, 'background job failed');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
