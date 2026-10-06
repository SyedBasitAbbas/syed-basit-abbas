import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { slowAi, stubbornAi } from '../support/fakes.js';
import {
  ALLOWED_ORIGIN,
  call,
  createTestApp,
  PUBLIC_BASE_URL,
  resetDatabase,
  signIn,
  type TestApp,
} from '../support/test-app.js';

describe('Security middleware', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.container);
  });

  describe('secure headers and request ids', () => {
    it('sets hardened headers on every response, including errors', async () => {
      const res = await request(t.app).get('/api/v1/chat/usage');
      expect(res.status).toBe(401);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['content-type']).toMatch(/^application\/json/);
    });

    it('propagates a safe X-Request-Id and replaces unsafe ones', async () => {
      const kept = await request(t.app).get('/api/v1/health').set('X-Request-Id', 'trace-1234abcd');
      expect(kept.headers['x-request-id']).toBe('trace-1234abcd');
      expect(kept.body.error.requestId).toBe('trace-1234abcd');
      const replaced = await request(t.app)
        .get('/api/v1/health')
        .set('X-Request-Id', 'bad id <script>');
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('CORS', () => {
    it('answers preflights for allowed origins only', async () => {
      const ok = await request(t.app)
        .options('/api/v1/chat/messages')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,dpop,content-type');
      expect(ok.status).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(ok.headers['access-control-allow-headers']).toContain('DPoP');
      expect(ok.headers['access-control-allow-credentials']).toBeUndefined();

      const denied = await request(t.app)
        .options('/api/v1/chat/messages')
        .set('Origin', 'https://evil.example.com')
        .set('Access-Control-Request-Method', 'POST');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('CORS_ORIGIN_DENIED');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not answer non-preflight OPTIONS requests without authentication', async () => {
      const res = await request(t.app).options('/api/v1/chat/messages');
      expect(res.status).toBe(401);
    });

    it('refuses actual requests from foreign browser origins', async () => {
      const client = await signIn(t.idp);
      const res = await call(t.app, client, 'GET', '/api/v1/auth/me', undefined, {
        Origin: 'https://evil.example.com',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('request body rules', () => {
    it('enforces the request size limit', async () => {
      const client = await signIn(t.idp);
      const res = await call(t.app, client, 'POST', '/api/v1/chat/messages', {
        question: 'x'.repeat(20_000),
      });
      expect(res.status).toBe(413);
      expect(res.body.error).toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        details: { limitBytes: 16_384 },
      });
    });

    it.each([
      ['text/plain', 'question=hi'],
      ['application/x-www-form-urlencoded', 'question=hi'],
      ['application/json; charset=utf-16', '{"question":"hi"}'],
    ])('rejects content-type %s with 415', async (contentType, payload) => {
      const client = await signIn(t.idp);
      const res = await call(t.app, client, 'POST', '/api/v1/chat/messages', payload, {
        'Content-Type': contentType,
      });
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects compressed bodies', async () => {
      const client = await signIn(t.idp);
      const res = await call(t.app, client, 'POST', '/api/v1/chat/messages', '{"question":"hi"}', {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      });
      expect(res.status).toBe(415);
    });

    it('rejects malformed JSON', async () => {
      const client = await signIn(t.idp);
      const res = await call(t.app, client, 'POST', '/api/v1/chat/messages', '{"question": "hi"', {
        'Content-Type': 'application/json',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MALFORMED_JSON');
    });

    it('rejects a body on GET requests', async () => {
      const client = await signIn(t.idp);
      const res = await call(t.app, client, 'GET', '/api/v1/chat/usage', '{"a":1}', {
        'Content-Type': 'application/json',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BODY_NOT_ALLOWED');
    });
  });

  describe('schema validation and sanitization', () => {
    it('rejects unknown fields, including prototype pollution attempts', async () => {
      const client = await signIn(t.idp);
      const extra = await call(t.app, client, 'POST', '/api/v1/chat/messages', {
        question: 'hi',
        userId: 'x',
      });
      expect(extra.status).toBe(400);
      expect(extra.body.error.details.issues[0]).toMatchObject({
        location: 'body',
        code: 'unrecognized_keys',
      });

      const polluted = await call(
        t.app,
        client,
        'POST',
        '/api/v1/chat/messages',
        '{"question":"hi","__proto__":{"isAdmin":true}}',
        {
          'Content-Type': 'application/json',
        },
      );
      expect(polluted.status).toBe(400);
    });

    it('rejects unknown query parameters and malformed ids', async () => {
      const client = await signIn(t.idp);
      expect((await call(t.app, client, 'GET', '/api/v1/chat/usage?debug=1')).status).toBe(400);
      expect((await call(t.app, client, 'GET', '/api/v1/chat/messages?limit=1000')).status).toBe(
        400,
      );
      expect(
        (await call(t.app, client, 'GET', '/api/v1/chat/messages?cursor=not-a-cursor')).status,
      ).toBe(400);
      const badId = await call(t.app, client, 'GET', "/api/v1/chat/messages/1' OR '1'='1");
      expect(badId.status).toBe(400);
      expect(badId.body.error.details.issues[0].location).toBe('params');
    });

    it('rejects missing or empty questions', async () => {
      const client = await signIn(t.idp);
      expect((await call(t.app, client, 'POST', '/api/v1/chat/messages', {})).status).toBe(400);
      expect(
        (await call(t.app, client, 'POST', '/api/v1/chat/messages', { question: '   ' })).status,
      ).toBe(400);
      expect(
        (await call(t.app, client, 'POST', '/api/v1/chat/messages', { question: 42 })).status,
      ).toBe(400);
      expect(
        (
          await call(t.app, client, 'POST', '/api/v1/chat/messages', {
            question: '<script>x</script>',
          })
        ).status,
      ).toBe(400);
    });

    it('strips markup from questions and answers (XSS)', async () => {
      const client = await signIn(t.idp);
      const res = await call(t.app, client, 'POST', '/api/v1/chat/messages', {
        question: '<script>alert(1)</script>Is <b>2</b> < 3? <img src=x onerror=alert(1)>',
      });
      expect(res.status).toBe(201);
      expect(res.body.message.question).toBe('Is 2 &lt; 3?');
      expect(res.body.message.answer).not.toMatch(/<\s*script|onerror|<img/i);
    });

    it('treats SQL injection payloads as plain data', async () => {
      const client = await signIn(t.idp);
      const payload = "'; DROP TABLE users; --";
      const res = await call(t.app, client, 'POST', '/api/v1/chat/messages', { question: payload });
      expect(res.status).toBe(201);
      expect(res.body.message.question).toBe(payload);
      const { rows } = await sql<{
        users: number;
      }>`SELECT count(*)::int AS users FROM users`.execute(t.container.db);
      expect(rows[0]?.users).toBe(1);
    });
  });

  describe('global request timeout', () => {
    it('answers 503 when a request runs too long, cancels the AI call and refunds the quota', async () => {
      const slow = await createTestApp({
        env: { REQUEST_TIMEOUT_MS: '200' },
        overrides: { ai: slowAi(5_000) },
      });
      try {
        const client = await signIn(slow.idp);
        const started = Date.now();
        const res = await call(slow.app, client, 'POST', '/api/v1/chat/messages', {
          question: 'slow?',
        });
        expect(res.status).toBe(503);
        expect(res.body.error).toMatchObject({
          code: 'REQUEST_TIMEOUT',
          details: { timeoutMs: 200 },
        });
        expect(Date.now() - started).toBeLessThan(3_000);

        await expect
          .poll(async () => {
            const row = await slow.container.db
              .selectFrom('chat_messages')
              .select(['status', 'failure_code'])
              .executeTakeFirst();
            return row;
          })
          .toEqual({ status: 'failed', failure_code: 'REQUEST_TIMEOUT' });
        const usage = await call(slow.app, client, 'GET', '/api/v1/chat/usage');
        expect(usage.body.free.used).toBe(0);
      } finally {
        await resetDatabase(slow.container);
        await slow.close();
      }
    });
    it('does not charge for an answer that arrives after the timeout', async () => {
      const late = await createTestApp({
        env: { REQUEST_TIMEOUT_MS: '200' },
        overrides: { ai: stubbornAi(350) },
      });
      try {
        const client = await signIn(late.idp);
        const res = await call(late.app, client, 'POST', '/api/v1/chat/messages', {
          question: 'late?',
        });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('REQUEST_TIMEOUT');
        const row = await late.container.db
          .selectFrom('chat_messages')
          .select(['status', 'failure_code'])
          .executeTakeFirstOrThrow();
        expect(row).toEqual({ status: 'failed', failure_code: 'REQUEST_TIMEOUT' });
        const usage = await call(late.app, client, 'GET', '/api/v1/chat/usage');
        expect(usage.body.free.used).toBe(0);
      } finally {
        await resetDatabase(late.container);
        await late.close();
      }
    });
  });

  it('builds htu from the configured public URL, not the Host header', async () => {
    const client = await signIn(t.idp);
    const proof = await client.key.proof({
      method: 'GET',
      url: 'https://attacker.example.com/api/v1/auth/me',
      accessToken: client.token,
    });
    const res = await request(t.app)
      .get('/api/v1/auth/me')
      .set('Host', 'attacker.example.com')
      .set('Authorization', `DPoP ${client.token}`)
      .set('DPoP', proof);
    expect(res.status).toBe(401);
    expect(PUBLIC_BASE_URL).toBe('https://api.ggi.test');
  });
});
