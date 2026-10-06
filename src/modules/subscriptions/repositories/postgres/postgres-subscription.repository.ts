import { sql, type Selectable } from 'kysely';
import type { Page, PageRequest } from '../../../../shared/application/pagination.js';
import type { DbExecutor } from '../../../../shared/infrastructure/database/database.js';
import type { SubscriptionsTable } from '../../../../shared/infrastructure/database/schema.js';
import type { Payment } from '../../domain/entities/payment.js';
import { Subscription, type SubscriptionProps } from '../../domain/entities/subscription.js';
import type {
  PaymentRepository,
  SubscriptionFilter,
  SubscriptionRepository,
  SubscriptionView,
} from '../subscription.repository.js';

type Row = Selectable<SubscriptionsTable>;

function toProps(row: Row): SubscriptionProps {
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    billingCycle: row.billing_cycle,
    maxMessages: row.max_messages,
    priceCents: row.price_cents,
    currency: row.currency,
    autoRenew: row.auto_renew,
    status: row.status,
    inactiveReason: row.inactive_reason,
    startDate: row.start_date,
    endDate: row.end_date,
    renewalDate: row.renewal_date,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toView(row: Row & { used: number }): SubscriptionView {
  const props = toProps(row);
  return {
    subscription: props,
    usage: {
      used: row.used,
      remaining: props.maxMessages === null ? null : Math.max(0, props.maxMessages - row.used),
    },
  };
}

export class PostgresSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(subscription: Subscription): Promise<void> {
    const s = subscription.toSnapshot();
    await this.db
      .insertInto('subscriptions')
      .values({
        id: s.id,
        user_id: s.userId,
        tier: s.tier,
        billing_cycle: s.billingCycle,
        max_messages: s.maxMessages,
        price_cents: s.priceCents,
        currency: s.currency,
        auto_renew: s.autoRenew,
        status: s.status,
        inactive_reason: s.inactiveReason,
        start_date: s.startDate,
        end_date: s.endDate,
        renewal_date: s.renewalDate,
        cancelled_at: s.cancelledAt,
        created_at: s.createdAt,
        updated_at: s.updatedAt,
      })
      .execute();
  }

  async save(subscription: Subscription): Promise<void> {
    const s = subscription.toSnapshot();
    // Only lifecycle fields are writable; owner, tier, price and allowance are immutable.
    await this.db
      .updateTable('subscriptions')
      .set({
        auto_renew: s.autoRenew,
        status: s.status,
        inactive_reason: s.inactiveReason,
        start_date: s.startDate,
        end_date: s.endDate,
        renewal_date: s.renewalDate,
        cancelled_at: s.cancelledAt,
        updated_at: s.updatedAt,
      })
      .where('id', '=', s.id)
      .execute();
  }

  async findById(id: string, options?: { forUpdate?: boolean }): Promise<Subscription | null> {
    let query = this.db.selectFrom('subscriptions').selectAll().where('id', '=', id);
    if (options?.forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row ? Subscription.rehydrate(toProps(row)) : null;
  }

  async findViewById(id: string): Promise<SubscriptionView | null> {
    const row = await this.viewQuery().where('s.id', '=', id).executeTakeFirst();
    return row ? toView(row) : null;
  }

  async list(filter: SubscriptionFilter, page: PageRequest): Promise<Page<SubscriptionView>> {
    let query = this.viewQuery();
    if (filter.userId !== undefined) query = query.where('s.user_id', '=', filter.userId);
    if (filter.status !== undefined) query = query.where('s.status', '=', filter.status);
    if (page.cursor) {
      const { createdAt, id } = page.cursor;
      query = query.where(sql<boolean>`(s.created_at, s.id) < (${createdAt}, ${id}::uuid)`);
    }
    const rows = await query
      .orderBy('s.created_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const items = rows.slice(0, page.limit).map(toView);
    const last = rows.length > page.limit ? rows[page.limit - 1] : undefined;
    return { items, nextCursor: last ? { createdAt: last.created_at, id: last.id } : null };
  }

  async claimNextDueForBilling(now: Date): Promise<Subscription | null> {
    const row = await this.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('status', '=', 'active')
      .where('end_date', '<=', now)
      .orderBy('end_date', 'asc')
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    return row ? Subscription.rehydrate(toProps(row)) : null;
  }

  private viewQuery() {
    return this.db
      .selectFrom('subscriptions as s')
      .leftJoin('subscription_usage as u', (join) =>
        join.onRef('u.subscription_id', '=', 's.id').onRef('u.period_start', '=', 's.start_date'),
      )
      .selectAll('s')
      .select(sql<number>`COALESCE(u.used, 0)::int`.as('used'));
  }
}

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(payment: Payment): Promise<void> {
    await this.db
      .insertInto('payments')
      .values({
        id: payment.id,
        subscription_id: payment.subscriptionId,
        user_id: payment.userId,
        kind: payment.kind,
        amount_cents: payment.amountCents,
        currency: payment.currency,
        status: payment.status,
        failure_reason: payment.failureReason,
        provider_reference: payment.providerReference,
        period_start: payment.periodStart,
        period_end: payment.periodEnd,
        created_at: payment.createdAt,
      })
      .execute();
  }
}
