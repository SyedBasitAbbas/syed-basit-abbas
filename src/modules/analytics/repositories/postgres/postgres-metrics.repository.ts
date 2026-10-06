import { sql } from 'kysely';
import { monthLabel, startOfUtcMonth } from '../../../../shared/domain/calendar.js';
import type { DbExecutor } from '../../../../shared/infrastructure/database/database.js';
import type { MetricsRepository, SystemMetrics } from '../metrics.repository.js';

export class PostgresMetricsRepository implements MetricsRepository {
  constructor(private readonly db: DbExecutor) {}

  async collect(now: Date): Promise<SystemMetrics> {
    const monthStart = startOfUtcMonth(now);

    const [users, messages, allTime, subscriptions, payments] = await Promise.all([
      sql<{ total: number; active_this_month: number }>`
        SELECT (SELECT count(*)::int FROM users) AS total,
               (SELECT count(DISTINCT user_id)::int FROM chat_messages
                 WHERE created_at >= ${monthStart}) AS active_this_month`.execute(this.db),
      sql<{
        status: 'pending' | 'completed' | 'failed';
        quota_source: 'free' | 'subscription';
        messages: number;
        prompt: number;
        completion: number;
        total: number;
      }>`
        SELECT status, quota_source, count(*)::int AS messages,
               COALESCE(sum(prompt_tokens), 0)::int AS prompt,
               COALESCE(sum(completion_tokens), 0)::int AS completion,
               COALESCE(sum(total_tokens), 0)::int AS total
          FROM chat_messages
         WHERE created_at >= ${monthStart}
         GROUP BY status, quota_source`.execute(this.db),
      sql<{ messages: number }>`SELECT count(*)::int AS messages FROM chat_messages`.execute(
        this.db,
      ),
      sql<{
        tier: 'basic' | 'pro' | 'enterprise';
        status: 'active' | 'inactive';
        inactive_reason: 'cancelled' | 'payment_failed' | 'expired' | null;
        auto_renew: boolean;
        subscriptions: number;
      }>`
        SELECT tier, status, inactive_reason, auto_renew, count(*)::int AS subscriptions
          FROM subscriptions
         GROUP BY tier, status, inactive_reason, auto_renew`.execute(this.db),
      sql<{ status: 'succeeded' | 'failed'; payments: number; amount: number }>`
        SELECT status, count(*)::int AS payments, COALESCE(sum(amount_cents), 0)::int AS amount
          FROM payments
         GROUP BY status`.execute(this.db),
    ]);

    const metrics: SystemMetrics = {
      users: {
        total: users.rows[0]?.total ?? 0,
        activeThisMonth: users.rows[0]?.active_this_month ?? 0,
      },
      usage: {
        period: monthLabel(now),
        messagesThisMonth: 0,
        byStatus: { pending: 0, completed: 0, failed: 0 },
        bySource: { free: 0, subscription: 0 },
        tokensThisMonth: { prompt: 0, completion: 0, total: 0 },
        messagesAllTime: allTime.rows[0]?.messages ?? 0,
      },
      subscriptions: {
        active: 0,
        inactive: 0,
        autoRenewEnabled: 0,
        byTier: {
          basic: { active: 0, total: 0 },
          pro: { active: 0, total: 0 },
          enterprise: { active: 0, total: 0 },
        },
        inactiveByReason: { cancelled: 0, payment_failed: 0, expired: 0 },
      },
      billing: { paymentsSucceeded: 0, paymentsFailed: 0, revenueCents: 0 },
    };

    for (const row of messages.rows) {
      metrics.usage.messagesThisMonth += row.messages;
      metrics.usage.byStatus[row.status] += row.messages;
      metrics.usage.bySource[row.quota_source] += row.messages;
      metrics.usage.tokensThisMonth.prompt += row.prompt;
      metrics.usage.tokensThisMonth.completion += row.completion;
      metrics.usage.tokensThisMonth.total += row.total;
    }
    for (const row of subscriptions.rows) {
      const tier = metrics.subscriptions.byTier[row.tier];
      tier.total += row.subscriptions;
      if (row.status === 'active') {
        metrics.subscriptions.active += row.subscriptions;
        tier.active += row.subscriptions;
        if (row.auto_renew) metrics.subscriptions.autoRenewEnabled += row.subscriptions;
      } else {
        metrics.subscriptions.inactive += row.subscriptions;
        if (row.inactive_reason)
          metrics.subscriptions.inactiveByReason[row.inactive_reason] += row.subscriptions;
      }
    }
    for (const row of payments.rows) {
      if (row.status === 'succeeded') {
        metrics.billing.paymentsSucceeded = row.payments;
        metrics.billing.revenueCents = row.amount;
      } else {
        metrics.billing.paymentsFailed = row.payments;
      }
    }
    return metrics;
  }
}
