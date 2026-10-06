import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock, ScriptedPaymentGateway } from '../support/fakes.js';
import { call, createTestApp, resetDatabase, signIn, type TestApp } from '../support/test-app.js';

describe('Subscription bundles and billing simulation', () => {
  const clock = new ManualClock(new Date('2026-01-31T12:00:00Z'));
  const payments = new ScriptedPaymentGateway();
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ overrides: { clock, payments } });
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    clock.set('2026-01-31T12:00:00Z');
    await resetDatabase(t.container);
  });

  const buy = (client: Awaited<ReturnType<typeof signIn>>, body: Record<string, unknown>) =>
    call(t.app, client, 'POST', '/api/v1/subscriptions', body);

  it('lists the plan catalog', async () => {
    const client = await signIn(t.idp);
    const res = await call(t.app, client, 'GET', '/api/v1/subscriptions/plans');
    expect(res.status).toBe(200);
    expect(
      res.body.items.map((plan: { tier: string; maxMessagesPerCycle: object }) => [
        plan.tier,
        plan.maxMessagesPerCycle,
      ]),
    ).toEqual([
      ['basic', { monthly: 10, yearly: 120 }],
      ['pro', { monthly: 100, yearly: 1200 }],
      ['enterprise', { monthly: null, yearly: null }],
    ]);
  });

  it('creates a bundle with server-derived allowance, price and billing dates', async () => {
    const client = await signIn(t.idp);
    const res = await buy(client, { tier: 'basic', billingCycle: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tier: 'basic',
      billingCycle: 'monthly',
      status: 'active',
      inactiveReason: null,
      autoRenew: true,
      maxMessages: 10,
      price: { amountCents: 999, currency: 'USD' },
      startDate: '2026-01-31T12:00:00.000Z',
      // Jan 31 + 1 month is clamped to the last day of February.
      endDate: '2026-02-28T12:00:00.000Z',
      renewalDate: '2026-02-28T12:00:00.000Z',
      currentPeriodUsage: { used: 0, remaining: 10 },
    });

    const yearly = await buy(client, { tier: 'pro', billingCycle: 'yearly', autoRenew: false });
    expect(yearly.body).toMatchObject({
      maxMessages: 1200,
      price: { amountCents: 29_990, currency: 'USD' },
      endDate: '2027-01-31T12:00:00.000Z',
      renewalDate: null,
      autoRenew: false,
    });
  });

  it('rejects mass assignment of server-owned fields', async () => {
    const client = await signIn(t.idp);
    const res = await buy(client, {
      tier: 'enterprise',
      billingCycle: 'monthly',
      price: 0,
      maxMessages: 1_000_000,
      userId: '00000000-0000-4000-8000-000000000000',
      status: 'active',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.issues[0].code).toBe('unrecognized_keys');
    expect((await call(t.app, client, 'GET', '/api/v1/subscriptions')).body.items).toHaveLength(0);
  });

  it('rejects unknown tiers and cycles', async () => {
    const client = await signIn(t.idp);
    expect((await buy(client, { tier: 'platinum', billingCycle: 'monthly' })).status).toBe(400);
    expect((await buy(client, { tier: 'basic', billingCycle: 'weekly' })).status).toBe(400);
  });

  it('marks the subscription inactive when the initial payment fails', async () => {
    const client = await signIn(t.idp);
    payments.failNext();
    const res = await buy(client, { tier: 'pro', billingCycle: 'monthly' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_FAILED');
    const id = res.body.error.details.subscriptionId as string;

    const stored = await call(t.app, client, 'GET', `/api/v1/subscriptions/${id}`);
    expect(stored.body).toMatchObject({
      status: 'inactive',
      inactiveReason: 'payment_failed',
      renewalDate: null,
    });
    // The failed bundle never grants quota.
    for (let i = 0; i < 3; i += 1)
      await call(t.app, client, 'POST', '/api/v1/chat/messages', { question: 'q' });
    expect(
      (await call(t.app, client, 'POST', '/api/v1/chat/messages', { question: 'q' })).status,
    ).toBe(402);
  });

  it('enables and disables auto-renew', async () => {
    const client = await signIn(t.idp);
    const { body: sub } = await buy(client, { tier: 'basic', billingCycle: 'monthly' });
    const off = await call(t.app, client, 'PATCH', `/api/v1/subscriptions/${sub.id}`, {
      autoRenew: false,
    });
    expect(off.body).toMatchObject({ autoRenew: false, renewalDate: null });
    const on = await call(t.app, client, 'PATCH', `/api/v1/subscriptions/${sub.id}`, {
      autoRenew: true,
    });
    expect(on.body).toMatchObject({ autoRenew: true, renewalDate: sub.endDate });
    const bad = await call(t.app, client, 'PATCH', `/api/v1/subscriptions/${sub.id}`, {
      autoRenew: true,
      tier: 'pro',
    });
    expect(bad.status).toBe(400);
  });

  it('cancels: ends the cycle now, stops renewals, keeps usage history', async () => {
    const client = await signIn(t.idp);
    const { body: sub } = await buy(client, { tier: 'basic', billingCycle: 'monthly' });
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await call(t.app, client, 'POST', '/api/v1/chat/messages', { question: `q${i}` })).status,
      ).toBe(201);
    }
    clock.advance(3_600_000);
    const cancelled = await call(t.app, client, 'POST', `/api/v1/subscriptions/${sub.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'inactive',
      inactiveReason: 'cancelled',
      autoRenew: false,
      renewalDate: null,
      cancelledAt: '2026-01-31T13:00:00.000Z',
      endDate: '2026-01-31T13:00:00.000Z',
    });

    // History preserved: the 2 messages charged to the bundle still reference it.
    const charged = await t.container.db
      .selectFrom('chat_messages')
      .select('id')
      .where('subscription_id', '=', sub.id)
      .execute();
    expect(charged).toHaveLength(2);
    const usageRow = await t.container.db
      .selectFrom('subscription_usage')
      .select('used')
      .where('subscription_id', '=', sub.id)
      .executeTakeFirstOrThrow();
    expect(usageRow.used).toBe(2);

    // The bundle no longer grants messages, and it can neither be cancelled again nor renewed.
    expect(
      (await call(t.app, client, 'POST', '/api/v1/chat/messages', { question: 'q' })).status,
    ).toBe(402);
    const again = await call(t.app, client, 'POST', `/api/v1/subscriptions/${sub.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SUBSCRIPTION_NOT_ACTIVE');
    const admin = await signIn(t.idp, { roles: ['admin'] });
    clock.set('2026-03-01T00:00:00Z');
    const run = await call(t.app, admin, 'POST', '/api/v1/admin/billing/run');
    expect(run.body.processed).toBe(0);
  });

  it("does not let users see or manage other users' subscriptions (domain policy)", async () => {
    const owner = await signIn(t.idp);
    const intruder = await signIn(t.idp);
    const { body: sub } = await buy(owner, { tier: 'basic', billingCycle: 'monthly' });
    expect((await call(t.app, intruder, 'GET', `/api/v1/subscriptions/${sub.id}`)).status).toBe(
      404,
    );
    expect(
      (await call(t.app, intruder, 'POST', `/api/v1/subscriptions/${sub.id}/cancel`)).status,
    ).toBe(404);
    expect(
      (
        await call(t.app, intruder, 'PATCH', `/api/v1/subscriptions/${sub.id}`, {
          autoRenew: false,
        })
      ).status,
    ).toBe(404);
    expect((await call(t.app, intruder, 'GET', '/api/v1/subscriptions')).body.items).toHaveLength(
      0,
    );

    const admin = await signIn(t.idp, { roles: ['admin'] });
    expect((await call(t.app, admin, 'GET', `/api/v1/subscriptions/${sub.id}`)).status).toBe(200);
    const all = await call(t.app, admin, 'GET', '/api/v1/admin/subscriptions?status=active');
    expect(all.body.items).toHaveLength(1);
  });

  describe('billing run', () => {
    it('renews auto-renewing bundles with a new cycle and a fresh allowance', async () => {
      const client = await signIn(t.idp);
      const admin = await signIn(t.idp, { roles: ['admin'] });
      const { body: sub } = await buy(client, { tier: 'basic', billingCycle: 'monthly' });
      for (let i = 0; i < 4; i += 1)
        await call(t.app, client, 'POST', '/api/v1/chat/messages', { question: 'q' });
      expect(
        (await call(t.app, client, 'GET', `/api/v1/subscriptions/${sub.id}`)).body
          .currentPeriodUsage.used,
      ).toBe(1);

      clock.set('2026-02-28T12:00:01Z');
      const run = await call(t.app, admin, 'POST', '/api/v1/admin/billing/run');
      expect(run.body).toEqual({ processed: 1, renewed: 1, paymentFailed: 0, expired: 0 });

      const renewed = await call(t.app, client, 'GET', `/api/v1/subscriptions/${sub.id}`);
      expect(renewed.body).toMatchObject({
        status: 'active',
        startDate: '2026-02-28T12:00:00.000Z',
        endDate: '2026-03-28T12:00:00.000Z',
        renewalDate: '2026-03-28T12:00:00.000Z',
        currentPeriodUsage: { used: 0, remaining: 10 },
      });
      const history = await t.container.db
        .selectFrom('payments')
        .select(['kind', 'status'])
        .where('subscription_id', '=', sub.id)
        .orderBy('created_at')
        .execute();
      expect(history).toEqual([
        { kind: 'initial', status: 'succeeded' },
        { kind: 'renewal', status: 'succeeded' },
      ]);
      // The previous cycle's usage row is kept.
      const usageRows = await t.container.db
        .selectFrom('subscription_usage')
        .select('used')
        .where('subscription_id', '=', sub.id)
        .execute();
      expect(usageRows).toEqual([{ used: 1 }]);
    });

    it('marks the subscription inactive when the renewal payment fails', async () => {
      const client = await signIn(t.idp);
      const admin = await signIn(t.idp, { roles: ['admin'] });
      const { body: sub } = await buy(client, { tier: 'pro', billingCycle: 'monthly' });
      clock.set('2026-03-01T00:00:00Z');
      payments.failNext();
      const run = await call(t.app, admin, 'POST', '/api/v1/admin/billing/run');
      expect(run.body).toMatchObject({ processed: 1, paymentFailed: 1 });
      const after = await call(t.app, client, 'GET', `/api/v1/subscriptions/${sub.id}`);
      expect(after.body).toMatchObject({
        status: 'inactive',
        inactiveReason: 'payment_failed',
        renewalDate: null,
      });
    });

    it('expires bundles without auto-renew at the end of the cycle', async () => {
      const client = await signIn(t.idp);
      const admin = await signIn(t.idp, { roles: ['admin'] });
      const { body: sub } = await buy(client, {
        tier: 'basic',
        billingCycle: 'monthly',
        autoRenew: false,
      });
      clock.set('2026-02-28T11:59:59Z');
      expect((await call(t.app, admin, 'POST', '/api/v1/admin/billing/run')).body.processed).toBe(
        0,
      );
      clock.set('2026-02-28T12:00:00Z');
      expect((await call(t.app, admin, 'POST', '/api/v1/admin/billing/run')).body).toMatchObject({
        expired: 1,
      });
      const after = await call(t.app, client, 'GET', `/api/v1/subscriptions/${sub.id}`);
      expect(after.body).toMatchObject({ status: 'inactive', inactiveReason: 'expired' });
    });

    it('is admin-only', async () => {
      const client = await signIn(t.idp);
      expect((await call(t.app, client, 'POST', '/api/v1/admin/billing/run')).status).toBe(403);
    });
  });
});
