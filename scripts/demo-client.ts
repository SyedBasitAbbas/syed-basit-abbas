/**
 * End-to-end demo client against the real stack (Keycloak + API):
 * signs in with email/password at Keycloak using a DPoP-bound token request,
 * then calls the API with a fresh DPoP proof per request.
 *
 *   npm run demo            # walk through the main flows and print results
 *   npm run demo -- --e2e   # same, but assert outcomes and exit non-zero on failure
 *
 * Env: OIDC_ISSUER, API_URL, OIDC_CLIENT_ID, DEMO_USER, DEMO_PASSWORD, DEMO_ADMIN, DEMO_ADMIN_PASSWORD.
 */
import { createHash } from 'node:crypto';
import { base64url, decodeJwt } from 'jose';
import { DpopKey } from '../test/support/dpop.js';

const ISSUER = process.env.OIDC_ISSUER ?? 'http://localhost:8080/realms/ggi';
const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'ggi-web';
const E2E = process.argv.includes('--e2e');

interface Session {
  token: string;
  key: DpopKey;
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : `, expected ${JSON.stringify(expected)}`}`,
  );
}

async function signIn(username: string, password: string): Promise<Session> {
  const key = await DpopKey.generate('ES256');
  const tokenUrl = `${ISSUER}/protocol/openid-connect/token`;
  let nonce: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const proof = await key.proof({ method: 'POST', url: tokenUrl, ...(nonce ? { nonce } : {}) });
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: proof },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: CLIENT_ID,
        username,
        password,
        scope: 'openid',
      }),
    });
    const body = (await response.json()) as Record<string, string>;
    if (response.ok && body.access_token) {
      const claims = decodeJwt(body.access_token);
      console.log(
        `signed in ${username}: token_type=${body.token_type}, cnf.jkt bound=${JSON.stringify(claims.cnf ?? null)}`,
      );
      return { token: body.access_token, key };
    }
    const serverNonce = response.headers.get('dpop-nonce');
    if (body.error === 'use_dpop_nonce' && serverNonce) {
      nonce = serverNonce;
      continue;
    }
    throw new Error(`Sign-in failed (${response.status}): ${JSON.stringify(body)}`);
  }
  throw new Error('Sign-in failed: DPoP nonce negotiation did not converge');
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const url = `${API}${path}`;
  const proof = await session.key.proof({
    method,
    url: url.split('?')[0] ?? url,
    ath: base64url.encode(createHash('sha256').update(session.token).digest()),
  });
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `DPoP ${session.token}`,
      DPoP: proof,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

async function main(): Promise<void> {
  const user = await signIn(
    process.env.DEMO_USER ?? 'user@example.com',
    process.env.DEMO_PASSWORD ?? 'Demo-User-Pass-2026',
  );

  const me = await api(user, 'GET', '/api/v1/auth/me');
  check('GET /auth/me', me.status, 200);
  console.log(
    '      identity:',
    JSON.stringify(me.body?.user),
    'binding:',
    me.body?.session?.binding,
  );

  const bearer = await fetch(`${API}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${user.token}` },
  });
  check('same token as plain Bearer is rejected', bearer.status, 401);

  const statuses: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const res = await api(user, 'POST', '/api/v1/chat/messages', {
      question: `Demo question ${i}`,
    });
    statuses.push(res.status);
    if (res.status === 201)
      console.log(
        `      answer ${i}:`,
        res.body?.message?.answer?.slice(0, 80),
        '| quota:',
        JSON.stringify(res.body?.quota),
      );
    else
      console.log(
        `      error ${i}:`,
        JSON.stringify(res.body?.error?.code),
        JSON.stringify(res.body?.error?.details),
      );
  }
  if (E2E) check('3 free messages then QUOTA_EXCEEDED', statuses, [201, 201, 201, 402]);

  const bundle = await api(user, 'POST', '/api/v1/subscriptions', {
    tier: 'basic',
    billingCycle: 'monthly',
  });
  check('buy Basic bundle', bundle.status, 201);
  const paid = await api(user, 'POST', '/api/v1/chat/messages', { question: 'Paid question' });
  check(
    'message charged to the bundle',
    [paid.status, paid.body?.quota?.source],
    [201, 'subscription'],
  );
  const usage = await api(user, 'GET', '/api/v1/chat/usage');
  console.log('      usage:', JSON.stringify(usage.body));

  const forbidden = await api(user, 'GET', '/api/v1/admin/metrics');
  check('user cannot read admin metrics', forbidden.status, 403);

  const admin = await signIn(
    process.env.DEMO_ADMIN ?? 'admin@example.com',
    process.env.DEMO_ADMIN_PASSWORD ?? 'Demo-Admin-Pass-2026',
  );
  const metrics = await api(admin, 'GET', '/api/v1/admin/metrics');
  check('admin reads metrics', metrics.status, 200);
  console.log(
    '      metrics:',
    JSON.stringify(metrics.body?.usage),
    JSON.stringify(metrics.body?.subscriptions?.byTier),
  );

  const logout = await api(user, 'POST', '/api/v1/auth/logout');
  check('logout', logout.status, 204);
  const afterLogout = await api(user, 'GET', '/api/v1/auth/me');
  check(
    'token rejected after logout',
    [afterLogout.status, afterLogout.body?.error?.code],
    [401, 'SESSION_REVOKED'],
  );

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    if (E2E) process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
