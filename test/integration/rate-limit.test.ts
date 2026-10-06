import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { call, createTestApp, resetDatabase, signIn, type TestApp } from '../support/test-app.js';

describe('Rate limiting', () => {
  const apps: TestApp[] = [];

  // Fixed windows reset on the minute; a frozen clock keeps every test inside one window.
  const insideOneWindow = () => Date.UTC(2026, 0, 1, 12, 0, 30);

  async function app(env: Record<string, string>, shareIdpWith?: TestApp) {
    const created = await createTestApp({
      env,
      overrides: { rateLimitClock: insideOneWindow },
      ...(shareIdpWith ? { idp: shareIdpWith.idp } : {}),
    });
    apps.push(created);
    return created;
  }

  afterEach(async () => {
    const [first] = apps;
    if (first) await resetDatabase(first.container);
    // Close the ones sharing an IdP before the IdP owner.
    for (const created of apps.reverse()) await created.close();
    apps.length = 0;
  });

  it('limits each user separately on chat endpoints, with standard headers', async () => {
    const t = await app({ RL_CHAT_USER: '2' });
    const alice = await signIn(t.idp);
    const bob = await signIn(t.idp);

    const first = await call(t.app, alice, 'GET', '/api/v1/chat/usage');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect((await call(t.app, alice, 'GET', '/api/v1/chat/usage')).status).toBe(200);

    const limited = await call(t.app, alice, 'GET', '/api/v1/chat/usage');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    expect(limited.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { policy: 'chat', scope: 'user', limit: 2, windowSeconds: 60 },
    });

    // Another user on the same IP is not affected by Alice's per-user limit.
    expect((await call(t.app, bob, 'GET', '/api/v1/chat/usage')).status).toBe(200);
  });

  it('limits each IP on authentication endpoints, across users', async () => {
    const t = await app({ RL_AUTH_IP: '3' });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const client = await signIn(t.idp);
      statuses.push((await call(t.app, client, 'GET', '/api/v1/auth/me')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('applies the per-IP limit before authentication (anonymous floods are throttled)', async () => {
    const t = await app({ RL_CHAT_IP: '2' });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1)
      statuses.push((await request(t.app).get('/api/v1/chat/usage')).status);
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('uses different limits for auth, chat and subscription endpoints', async () => {
    const t = await app({ RL_AUTH_USER: '1', RL_SUBSCRIPTIONS_USER: '3', RL_CHAT_USER: '5' });
    const client = await signIn(t.idp);

    const auth = [];
    for (let i = 0; i < 2; i += 1)
      auth.push((await call(t.app, client, 'GET', '/api/v1/auth/me')).status);
    const subs = [];
    for (let i = 0; i < 4; i += 1)
      subs.push((await call(t.app, client, 'GET', '/api/v1/subscriptions/plans')).status);
    const chat = [];
    for (let i = 0; i < 6; i += 1)
      chat.push((await call(t.app, client, 'GET', '/api/v1/chat/usage')).status);

    expect(auth).toEqual([200, 429]);
    expect(subs).toEqual([200, 200, 200, 429]);
    expect(chat).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('keys per-IP limits on the real client address behind a trusted proxy', async () => {
    const t = await app({ RL_AUTH_IP: '1', TRUST_PROXY: 'loopback' });
    const a = await signIn(t.idp);
    const b = await signIn(t.idp);
    const fromA = { 'X-Forwarded-For': '203.0.113.10' };
    const fromB = { 'X-Forwarded-For': '203.0.113.20' };
    expect((await call(t.app, a, 'GET', '/api/v1/auth/me', undefined, fromA)).status).toBe(200);
    expect((await call(t.app, a, 'GET', '/api/v1/auth/me', undefined, fromA)).status).toBe(429);
    expect((await call(t.app, b, 'GET', '/api/v1/auth/me', undefined, fromB)).status).toBe(200);
  });

  it('shares counters across API instances with the Postgres store', async () => {
    const nodeA = await app({ RATE_LIMIT_STORE: 'postgres', RL_CHAT_USER: '2' });
    const nodeB = await app({ RATE_LIMIT_STORE: 'postgres', RL_CHAT_USER: '2' }, nodeA);
    const client = await signIn(nodeA.idp);
    expect((await call(nodeA.app, client, 'GET', '/api/v1/chat/usage')).status).toBe(200);
    expect((await call(nodeB.app, client, 'GET', '/api/v1/chat/usage')).status).toBe(200);
    const third = await call(nodeA.app, client, 'GET', '/api/v1/chat/usage');
    expect(third.status).toBe(429);
  });
});
