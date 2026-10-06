import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DpopKey } from '../support/dpop.js';
import {
  call,
  createTestApp,
  PUBLIC_BASE_URL,
  resetDatabase,
  signIn,
  type TestApp,
} from '../support/test-app.js';

describe('Authenticated API access (OIDC access token + DPoP proof-of-possession)', () => {
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

  it('accepts a valid IdP token with a matching DPoP proof and provisions the user', async () => {
    const client = await signIn(t.idp);
    const res = await call(t.app, client, 'GET', '/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.roles).toEqual(['user']);
    expect(res.body.identity).toEqual({ issuer: t.idp.issuer, subject: client.sub });
    expect(res.body.session.dpopKeyThumbprint).toBe(client.key.jkt);
    expect(res.body.session.binding).toBe('cnf');
  });

  it('rejects requests without credentials, with a DPoP challenge', async () => {
    const res = await request(t.app).get('/api/v1/chat/usage');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.headers['www-authenticate']).toMatch(/^DPoP algs=/);
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('protects every route, including health checks and unknown paths', async () => {
    for (const path of [
      '/api/v1/health',
      '/api/v1/admin/metrics',
      '/api/v1/nope',
      '/',
      '/metrics',
    ]) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(401);
    }
    const client = await signIn(t.idp);
    expect((await call(t.app, client, 'GET', '/api/v1/health')).status).toBe(200);
    const unknown = await call(t.app, client, 'GET', '/api/v1/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('rejects a bare Bearer token: possession of the token alone is not enough', async () => {
    const client = await signIn(t.idp);
    const res = await request(t.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${client.token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a DPoP token sent without a proof', async () => {
    const client = await signIn(t.idp);
    const res = await request(t.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `DPoP ${client.token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_DPOP_PROOF');
  });

  it.each([
    ['expired', { expiresInSec: -120, issuedAt: Math.floor(Date.now() / 1000) - 600 }],
    ['wrong audience', { audience: 'some-other-api' }],
    ['wrong issuer', { issuer: 'https://evil.example.com' }],
    ['signed by a key outside the JWKS', { signWithUntrustedKey: true }],
    ['an ID token', { typ: 'ID' }],
    ['an over-long lifetime', { expiresInSec: 7 * 24 * 3600 }],
  ])('rejects a token that is %s', async (_label, tokenOptions) => {
    const client = await signIn(t.idp, { token: tokenOptions });
    const res = await call(t.app, client, 'GET', '/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('answers a token with a hostile header with a JSON 401, never an error page', async () => {
    const client = await signIn(t.idp);
    const hostileTyp = 'x\r\nSet-Cookie: a=b';
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: hostileTyp })).toString(
      'base64url',
    );
    const hostile = { ...client, token: `${header}.e30.AAAA` };
    const res = await call(t.app, hostile, 'GET', '/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['www-authenticate']).toMatch(/^DPoP algs=/);
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const client = await signIn(t.idp);
    const [, payload] = client.token.split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString(
      'base64url',
    );
    const forged = { ...client, token: `${header}.${payload}.AAAA` };
    const res = await call(t.app, forged, 'GET', '/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  describe('DPoP proof validation', () => {
    const url = `${PUBLIC_BASE_URL}/api/v1/auth/me`;

    async function withProof(client: Awaited<ReturnType<typeof signIn>>, proof: string) {
      return request(t.app)
        .get('/api/v1/auth/me')
        .set('Authorization', `DPoP ${client.token}`)
        .set('DPoP', proof);
    }

    it('rejects a proof for another HTTP method', async () => {
      const client = await signIn(t.idp);
      const proof = await client.key.proof({ method: 'POST', url, accessToken: client.token });
      expect((await withProof(client, proof)).body.error.code).toBe('INVALID_DPOP_PROOF');
    });

    it('rejects a proof for another URL', async () => {
      const client = await signIn(t.idp);
      const proof = await client.key.proof({
        method: 'GET',
        url: `${PUBLIC_BASE_URL}/api/v1/chat/usage`,
        accessToken: client.token,
      });
      expect((await withProof(client, proof)).body.error.code).toBe('INVALID_DPOP_PROOF');
    });

    it('rejects a stale proof (timestamp validation)', async () => {
      const client = await signIn(t.idp);
      const proof = await client.key.proof({
        method: 'GET',
        url,
        accessToken: client.token,
        iat: Math.floor(Date.now() / 1000) - 300,
      });
      expect((await withProof(client, proof)).body.error.code).toBe('INVALID_DPOP_PROOF');
    });

    it('rejects a proof minted for a different access token (ath)', async () => {
      const client = await signIn(t.idp);
      const other = await signIn(t.idp);
      const proof = await client.key.proof({ method: 'GET', url, accessToken: other.token });
      expect((await withProof(client, proof)).body.error.code).toBe('INVALID_DPOP_PROOF');
    });

    it('rejects a proof that embeds a private key or has the wrong typ', async () => {
      const client = await signIn(t.idp);
      const leaked = await client.key.proof({
        method: 'GET',
        url,
        accessToken: client.token,
        leakPrivateKey: true,
      });
      expect((await withProof(client, leaked)).body.error.code).toBe('INVALID_DPOP_PROOF');
      const wrongTyp = await client.key.proof({
        method: 'GET',
        url,
        accessToken: client.token,
        typ: 'JWT',
      });
      expect((await withProof(client, wrongTyp)).body.error.code).toBe('INVALID_DPOP_PROOF');
    });

    it('rejects a replayed proof (nonce/jti validation)', async () => {
      const client = await signIn(t.idp);
      const proof = await client.key.proof({ method: 'GET', url, accessToken: client.token });
      expect((await withProof(client, proof)).status).toBe(200);
      const replay = await withProof(client, proof);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('DPOP_PROOF_REPLAYED');
    });
  });

  describe('token binding', () => {
    it('rejects tokens the IdP did not bind to a DPoP key', async () => {
      const client = await signIn(t.idp, { bindTokenToKey: false });
      const res = await call(t.app, client, 'GET', '/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });

    it("rejects a stolen IdP-bound token used with the attacker's own key", async () => {
      const victim = await signIn(t.idp);
      const thief = { ...victim, key: await DpopKey.generate() };
      const res = await call(t.app, thief, 'GET', '/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_BINDING_MISMATCH');
    });

    it('gives every client of one SSO session its own binding and its own logout', async () => {
      const laptop = await signIn(t.idp, { token: { sid: 'sso-session-1' } });
      const phone = await signIn(t.idp, { token: { sub: laptop.sub, sid: 'sso-session-1' } });
      expect((await call(t.app, laptop, 'GET', '/api/v1/auth/me')).status).toBe(200);
      expect((await call(t.app, phone, 'GET', '/api/v1/auth/me')).status).toBe(200);

      expect((await call(t.app, laptop, 'POST', '/api/v1/auth/logout')).status).toBe(204);
      expect((await call(t.app, laptop, 'GET', '/api/v1/auth/me')).body.error.code).toBe(
        'SESSION_REVOKED',
      );
      expect((await call(t.app, phone, 'GET', '/api/v1/auth/me')).status).toBe(200);
    });

    it('logout revokes the server-side session immediately', async () => {
      const client = await signIn(t.idp);
      expect((await call(t.app, client, 'POST', '/api/v1/auth/logout')).status).toBe(204);
      const res = await call(t.app, client, 'GET', '/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_REVOKED');
    });
  });

  describe('compatibility mode for IdPs without DPoP (DPOP_REQUIRE_BOUND_TOKENS=false)', () => {
    let compat: TestApp;

    beforeAll(async () => {
      compat = await createTestApp({ env: { DPOP_REQUIRE_BOUND_TOKENS: 'false' } });
    });
    afterAll(async () => {
      await compat.close();
    });

    it('binds the IdP session to the first key and rejects a stolen token with another key', async () => {
      const victim = await signIn(compat.idp, { bindTokenToKey: false });
      const first = await call(compat.app, victim, 'GET', '/api/v1/auth/me');
      expect(first.status).toBe(200);
      expect(first.body.session.binding).toBe('first_use');

      const thief = { ...victim, key: await DpopKey.generate() };
      const res = await call(compat.app, thief, 'GET', '/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_BINDING_MISMATCH');
    });

    it('keeps later tokens of the same IdP session bound to that first key', async () => {
      const first = await signIn(compat.idp, { bindTokenToKey: false, token: { sid: 'shared' } });
      expect((await call(compat.app, first, 'GET', '/api/v1/auth/me')).status).toBe(200);
      const refreshed = await compat.idp.issueAccessToken({ sub: first.sub, sid: 'shared' });
      const sameKey = { ...first, token: refreshed };
      expect((await call(compat.app, sameKey, 'GET', '/api/v1/auth/me')).status).toBe(200);
      const otherKey = { ...sameKey, key: await DpopKey.generate() };
      expect((await call(compat.app, otherKey, 'GET', '/api/v1/auth/me')).status).toBe(401);
    });
  });

  describe('role-based access control', () => {
    it('denies admin endpoints to regular users at the controller level', async () => {
      const user = await signIn(t.idp, { roles: ['user'] });
      for (const path of [
        '/api/v1/admin/metrics',
        '/api/v1/admin/chat/messages',
        '/api/v1/admin/subscriptions',
      ]) {
        const res = await call(t.app, user, 'GET', path);
        expect(res.status, path).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('lets admins use system-wide endpoints', async () => {
      const admin = await signIn(t.idp, { roles: ['admin'] });
      const res = await call(t.app, admin, 'GET', '/api/v1/admin/metrics');
      expect(res.status).toBe(200);
      expect(res.body.users.total).toBe(1);
    });

    it('ignores unknown role claims and never self-elevates', async () => {
      const client = await signIn(t.idp, { token: { roles: ['superuser', 'root'] } });
      const me = await call(t.app, client, 'GET', '/api/v1/auth/me');
      expect(me.body.user.roles).toEqual(['user']);
      expect((await call(t.app, client, 'GET', '/api/v1/admin/metrics')).status).toBe(403);
    });

    it("hides other users' chats behind the domain policy, but admins can read them", async () => {
      const alice = await signIn(t.idp);
      const bob = await signIn(t.idp);
      const admin = await signIn(t.idp, { roles: ['admin'] });
      const created = await call(t.app, alice, 'POST', '/api/v1/chat/messages', {
        question: 'Hello?',
      });
      expect(created.status).toBe(201);
      const id = created.body.message.id as string;

      expect((await call(t.app, alice, 'GET', `/api/v1/chat/messages/${id}`)).status).toBe(200);
      const asBob = await call(t.app, bob, 'GET', `/api/v1/chat/messages/${id}`);
      expect(asBob.status).toBe(404);
      expect((await call(t.app, admin, 'GET', `/api/v1/chat/messages/${id}`)).status).toBe(200);
    });
  });
});
