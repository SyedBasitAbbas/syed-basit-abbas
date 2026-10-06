import { sql } from 'kysely';
import { monthKey } from '../../../../shared/domain/calendar.js';
import type { DbExecutor } from '../../../../shared/infrastructure/database/database.js';
import { BundleAllowance } from '../../domain/entities/bundle-allowance.js';
import type { QuotaCharge } from '../../domain/entities/chat-message.js';
import { FreeMonthlyUsage } from '../../domain/entities/free-monthly-usage.js';
import type { QuotaRepository } from '../quota.repository.js';

interface BundleRow {
  id: string;
  tier: string;
  max_messages: number | null;
  start_date: Date;
  end_date: Date;
  created_at: Date;
  used: number;
}

export class PostgresQuotaRepository implements QuotaRepository {
  constructor(private readonly db: DbExecutor) {}

  async lockQuota(userId: string, periodStart: Date, limit: number): Promise<FreeMonthlyUsage> {
    // Per-user mutex for the rest of the transaction. An advisory lock (not the
    // monthly row) so requests on both sides of midnight on the 1st still queue.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${userId}`}, 0))`.execute(
      this.db,
    );
    const periodMonth = monthKey(periodStart);
    await this.db
      .insertInto('free_usage_monthly')
      .values({ user_id: userId, period_month: periodMonth, used: 0, free_limit: limit })
      .onConflict((oc) => oc.columns(['user_id', 'period_month']).doNothing())
      .execute();
    const row = await this.db
      .selectFrom('free_usage_monthly')
      .select(['used', 'free_limit'])
      .where('user_id', '=', userId)
      .where('period_month', '=', periodMonth)
      .executeTakeFirstOrThrow();
    return FreeMonthlyUsage.of({ userId, periodStart, used: row.used, limit: row.free_limit });
  }

  async readFreeUsage(userId: string, periodStart: Date, limit: number): Promise<FreeMonthlyUsage> {
    const row = await this.db
      .selectFrom('free_usage_monthly')
      .select(['used', 'free_limit'])
      .where('user_id', '=', userId)
      .where('period_month', '=', monthKey(periodStart))
      .executeTakeFirst();
    return FreeMonthlyUsage.of({
      userId,
      periodStart,
      used: row?.used ?? 0,
      limit: row?.free_limit ?? limit,
    });
  }

  async findActiveBundles(
    userId: string,
    now: Date,
    options: { lock: boolean },
  ): Promise<BundleAllowance[]> {
    // FOR SHARE keeps lifecycle changes (cancel, billing) out while we decide;
    // the billing job uses SKIP LOCKED, so it simply retries on its next run.
    const { rows } = await sql<BundleRow>`
      SELECT s.id, s.tier, s.max_messages, s.start_date, s.end_date, s.created_at,
             COALESCE(u.used, 0)::int AS used
        FROM subscriptions s
        LEFT JOIN subscription_usage u
               ON u.subscription_id = s.id AND u.period_start = s.start_date
       WHERE s.user_id = ${userId}
         AND s.status = 'active'
         AND s.start_date <= ${now}
         AND s.end_date > ${now}
       ORDER BY s.created_at DESC, s.id DESC
       ${options.lock ? sql`FOR SHARE OF s` : sql``}`.execute(this.db);

    return rows.map((row) =>
      BundleAllowance.of({
        subscriptionId: row.id,
        tier: row.tier,
        maxMessages: row.max_messages,
        used: row.used,
        periodStart: row.start_date,
        periodEnd: row.end_date,
        purchasedAt: row.created_at,
      }),
    );
  }

  async consumeFree(userId: string, periodStart: Date): Promise<void> {
    // Guarded increment: the database re-checks the limit atomically.
    const updated = await this.db
      .updateTable('free_usage_monthly')
      .set((eb) => ({ used: eb('used', '+', 1), updated_at: new Date() }))
      .where('user_id', '=', userId)
      .where('period_month', '=', monthKey(periodStart))
      .whereRef('used', '<', 'free_limit')
      .returning('used')
      .executeTakeFirst();
    if (!updated) throw new Error('Free quota changed concurrently; refusing to over-consume');
  }

  async consumeBundle(
    subscriptionId: string,
    periodStart: Date,
    maxMessages: number | null,
  ): Promise<void> {
    const { rows } = await sql<{ used: number }>`
      INSERT INTO subscription_usage (subscription_id, period_start, used, max_messages)
      VALUES (${subscriptionId}, ${periodStart}, 1, ${maxMessages})
      ON CONFLICT (subscription_id, period_start) DO UPDATE
         SET used = subscription_usage.used + 1, updated_at = now()
       WHERE subscription_usage.max_messages IS NULL
          OR subscription_usage.used < subscription_usage.max_messages
      RETURNING used`.execute(this.db);
    if (rows.length === 0) {
      throw new Error('Bundle quota changed concurrently; refusing to over-consume');
    }
  }

  async reapAbandonedReservations(olderThan: Date): Promise<number> {
    // One statement: fail the stale messages and give their units back, grouped
    // per period, so it is atomic and safe to run from several instances.
    const { rows } = await sql<{ reaped: number }>`
      WITH stale AS (
        UPDATE chat_messages
           SET status = 'failed', failure_code = 'ABANDONED', completed_at = now()
         WHERE status = 'pending' AND created_at < ${olderThan}
        RETURNING user_id, quota_source, subscription_id, quota_period_start
      ),
      free_refunds AS (
        SELECT user_id, (quota_period_start AT TIME ZONE 'UTC')::date AS period_month, count(*)::int AS n
          FROM stale WHERE quota_source = 'free'
         GROUP BY 1, 2
      ),
      bundle_refunds AS (
        SELECT subscription_id, quota_period_start, count(*)::int AS n
          FROM stale WHERE quota_source = 'subscription'
         GROUP BY 1, 2
      ),
      refunded_free AS (
        UPDATE free_usage_monthly f
           SET used = GREATEST(0, f.used - r.n), updated_at = now()
          FROM free_refunds r
         WHERE f.user_id = r.user_id AND f.period_month = r.period_month
        RETURNING 1
      ),
      refunded_bundles AS (
        UPDATE subscription_usage u
           SET used = GREATEST(0, u.used - r.n), updated_at = now()
          FROM bundle_refunds r
         WHERE u.subscription_id = r.subscription_id AND u.period_start = r.quota_period_start
        RETURNING 1
      )
      SELECT (SELECT count(*)::int FROM stale) AS reaped`.execute(this.db);
    return rows[0]?.reaped ?? 0;
  }

  async refund(userId: string, charge: QuotaCharge): Promise<void> {
    if (charge.source === 'free') {
      await this.db
        .updateTable('free_usage_monthly')
        .set((eb) => ({ used: eb('used', '-', 1), updated_at: new Date() }))
        .where('user_id', '=', userId)
        .where('period_month', '=', monthKey(charge.periodStart))
        .where('used', '>', 0)
        .execute();
      return;
    }
    if (charge.subscriptionId === null) return;
    await this.db
      .updateTable('subscription_usage')
      .set((eb) => ({ used: eb('used', '-', 1), updated_at: new Date() }))
      .where('subscription_id', '=', charge.subscriptionId)
      .where('period_start', '=', charge.periodStart)
      .where('used', '>', 0)
      .execute();
  }
}
