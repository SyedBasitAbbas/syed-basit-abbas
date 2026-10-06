import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { failingAi, ManualClock } from '../support/fakes.js';
import { call, createTestApp, resetDatabase, signIn, type TestApp } from '../support/test-app.js';

async function ask(
  t: TestApp,
  client: Awaited<ReturnType<typeof signIn>>,
  question = 'What is DDD?',
) {
  return call(t.app, client, 'POST', '/api/v1/chat/messages', { question });
}

describe('AI chat with monthly quota and subscription bundles', () => {
  const clock = new ManualClock(new Date('2026-03-15T10:00:00Z'));
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ overrides: { clock } });
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    clock.set('2026-03-15T10:00:00Z');
    await resetDatabase(t.container);
  });

  it('answers with a mocked OpenAI response and stores question, answer, tokens and metadata', async () => {
    const client = await signIn(t.idp);
    const res = await ask(t, client, 'Explain transactions');
    expect(res.status).toBe(201);
    const { message } = res.body;
    expect(message.status).toBe('completed');
    expect(message.answer).toContain('simulated answer');
    expect(message.model).toContain('mock');
    expect(message.usage.totalTokens).toBe(
      message.usage.promptTokens + message.usage.completionTokens,
    );
    expect(message.providerResponseId).toMatch(/^chatcmpl-mock-/);
    expect(res.body.quota).toEqual({ source: 'free', subscriptionId: null, remainingInSource: 2 });

    const row = await t.container.db
      .selectFrom('chat_messages')
      .selectAll()
      .where('id', '=', message.id)
      .executeTakeFirstOrThrow();
    expect(row.question).toBe('Explain transactions');
    expect(row.answer).toBe(message.answer);
    expect(row.total_tokens).toBe(message.usage.totalTokens);
    expect(row.request_id).toBe(res.headers['x-request-id']);
    expect(row.created_at.toISOString()).toBe('2026-03-15T10:00:00.000Z');
    expect(row.user_id).toBe(message.userId);
  });

  it('gives 3 free messages per month, then returns a typed QUOTA_EXCEEDED error', async () => {
    const client = await signIn(t.idp);
    for (let i = 0; i < 3; i += 1) expect((await ask(t, client)).status).toBe(201);

    const res = await ask(t, client);
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: {
        period: '2026-03',
        free: { limit: 3, used: 3, remaining: 0, resetsAt: '2026-04-01T00:00:00.000Z' },
        bundles: { active: 0, withRemainingQuota: 0 },
      },
    });
    const stored = await t.container.db.selectFrom('chat_messages').select('id').execute();
    expect(stored).toHaveLength(3);
  });

  it('resets the free quota automatically on the 1st of the month (UTC)', async () => {
    clock.set('2026-03-31T23:59:30Z');
    const client = await signIn(t.idp);
    for (let i = 0; i < 3; i += 1) expect((await ask(t, client)).status).toBe(201);
    expect((await ask(t, client)).status).toBe(402);

    clock.set('2026-04-01T00:00:00Z');
    const res = await ask(t, client);
    expect(res.status).toBe(201);
    expect(res.body.quota.source).toBe('free');

    const usage = await call(t.app, client, 'GET', '/api/v1/chat/usage');
    expect(usage.body.period).toBe('2026-04');
    expect(usage.body.free).toMatchObject({ used: 1, remaining: 2 });
  });

  it('uses a subscription bundle after the free quota, deducting from the latest bundle first', async () => {
    const client = await signIn(t.idp);
    const basic = await call(t.app, client, 'POST', '/api/v1/subscriptions', {
      tier: 'basic',
      billingCycle: 'monthly',
    });
    clock.advance(60_000);
    const pro = await call(t.app, client, 'POST', '/api/v1/subscriptions', {
      tier: 'pro',
      billingCycle: 'monthly',
    });
    expect(basic.status).toBe(201);
    expect(pro.status).toBe(201);

    for (let i = 0; i < 3; i += 1) expect((await ask(t, client)).body.quota.source).toBe('free');
    const paid = await ask(t, client);
    expect(paid.status).toBe(201);
    expect(paid.body.quota).toEqual({
      source: 'subscription',
      subscriptionId: pro.body.id,
      remainingInSource: 99,
    });

    const usage = await call(t.app, client, 'GET', '/api/v1/chat/usage');
    expect(usage.body.totalRemaining).toBe(10 + 99);
    expect(usage.body.nextCharge).toEqual({ source: 'subscription', subscriptionId: pro.body.id });
  });

  it('falls back to an older bundle once the latest one is used up', async () => {
    const client = await signIn(t.idp);
    const older = await call(t.app, client, 'POST', '/api/v1/subscriptions', {
      tier: 'pro',
      billingCycle: 'monthly',
    });
    clock.advance(60_000);
    const newer = await call(t.app, client, 'POST', '/api/v1/subscriptions', {
      tier: 'basic',
      billingCycle: 'monthly',
    });
    for (let i = 0; i < 3 + 10; i += 1) expect((await ask(t, client)).status).toBe(201);
    const next = await ask(t, client);
    expect(next.body.quota.subscriptionId).toBe(older.body.id);
    expect(newer.body.id).not.toBe(older.body.id);
  });

  it('treats Enterprise as unlimited', async () => {
    const client = await signIn(t.idp);
    await call(t.app, client, 'POST', '/api/v1/subscriptions', {
      tier: 'enterprise',
      billingCycle: 'yearly',
    });
    for (let i = 0; i < 3; i += 1) await ask(t, client);
    const res = await ask(t, client);
    expect(res.body.quota.source).toBe('subscription');
    expect(res.body.quota.remainingInSource).toBeNull();
    const usage = await call(t.app, client, 'GET', '/api/v1/chat/usage');
    expect(usage.body.unlimited).toBe(true);
  });

  it('deducts atomically under concurrent requests: never more than the available quota', async () => {
    const client = await signIn(t.idp);
    const basic = await call(t.app, client, 'POST', '/api/v1/subscriptions', {
      tier: 'basic',
      billingCycle: 'monthly',
    });
    expect(basic.status).toBe(201);

    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) => ask(t, client, `Concurrent question #${i}`)),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(13); // 3 free + 10 Basic
    expect(statuses.filter((s) => s === 402)).toHaveLength(12);

    const { rows } = await sql<{ free_used: number; bundle_used: number; messages: number }>`
      SELECT (SELECT used FROM free_usage_monthly) AS free_used,
             (SELECT used FROM subscription_usage WHERE subscription_id = ${basic.body.id}) AS bundle_used,
             (SELECT count(*)::int FROM chat_messages) AS messages`.execute(t.container.db);
    expect(rows[0]).toEqual({ free_used: 3, bundle_used: 10, messages: 13 });
  });

  it('isolates quotas between users under concurrency', async () => {
    const [a, b] = await Promise.all([signIn(t.idp), signIn(t.idp)]);
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => ask(t, a)),
      ...Array.from({ length: 6 }, () => ask(t, b)),
    ]);
    expect(results.slice(0, 6).filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.slice(6).filter((r) => r.status === 201)).toHaveLength(3);
  });

  it("lists only the caller's own messages, newest first, with cursor pagination", async () => {
    const client = await signIn(t.idp);
    const other = await signIn(t.idp);
    for (const q of ['first', 'second', 'third']) {
      await ask(t, client, q);
      clock.advance(1_000);
    }
    await ask(t, other, 'not yours');

    const page1 = await call(t.app, client, 'GET', '/api/v1/chat/messages?limit=2');
    expect(page1.body.items.map((m: { question: string }) => m.question)).toEqual([
      'third',
      'second',
    ]);
    const page2 = await call(
      t.app,
      client,
      'GET',
      `/api/v1/chat/messages?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items.map((m: { question: string }) => m.question)).toEqual(['first']);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('refunds the reserved quota when the AI provider fails', async () => {
    const broken = await createTestApp({ overrides: { ai: failingAi } });
    try {
      const client = await signIn(broken.idp);
      const res = await call(broken.app, client, 'POST', '/api/v1/chat/messages', {
        question: 'hi',
      });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('AI_PROVIDER_UNAVAILABLE');

      const usage = await call(broken.app, client, 'GET', '/api/v1/chat/usage');
      expect(usage.body.free).toMatchObject({ used: 0, remaining: 3 });
      const row = await broken.container.db
        .selectFrom('chat_messages')
        .select(['status', 'failure_code'])
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: 'failed', failure_code: 'AI_PROVIDER_UNAVAILABLE' });
    } finally {
      await resetDatabase(broken.container);
      await broken.close();
    }
  });

  it('refunds reservations abandoned by a crashed process', async () => {
    const client = await signIn(t.idp);
    const first = await ask(t, client, 'kept');
    const second = await ask(t, client, 'abandoned');
    // Simulate a crash between reserve and settle for the second message.
    await t.container.db
      .updateTable('chat_messages')
      .set({ status: 'pending', answer: null, total_tokens: null, completed_at: null })
      .set({ created_at: new Date('2026-03-15T09:00:00Z') })
      .where('id', '=', second.body.message.id)
      .execute();

    expect(await t.container.chat.reaper.execute()).toBe(1);
    expect(await t.container.chat.reaper.execute()).toBe(0);

    const usage = await call(t.app, client, 'GET', '/api/v1/chat/usage');
    expect(usage.body.free.used).toBe(1);
    const reaped = await call(
      t.app,
      client,
      'GET',
      `/api/v1/chat/messages/${second.body.message.id}`,
    );
    expect(reaped.body).toMatchObject({ status: 'failed', failureCode: 'ABANDONED' });
    const kept = await call(t.app, client, 'GET', `/api/v1/chat/messages/${first.body.message.id}`);
    expect(kept.body.status).toBe('completed');
  });

  it("lets admins list every user's messages and read any user's usage", async () => {
    const alice = await signIn(t.idp);
    const admin = await signIn(t.idp, { roles: ['admin'] });
    await ask(t, alice, 'alice asks');
    const me = await call(t.app, alice, 'GET', '/api/v1/auth/me');

    const list = await call(
      t.app,
      admin,
      'GET',
      `/api/v1/admin/chat/messages?userId=${me.body.user.id}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const usage = await call(t.app, admin, 'GET', `/api/v1/admin/users/${me.body.user.id}/usage`);
    expect(usage.body.free.used).toBe(1);
  });
});
