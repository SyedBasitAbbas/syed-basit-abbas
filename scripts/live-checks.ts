/**
 * Live checks against the running stack (Keycloak + API + PostgreSQL), one topic per run:
 *
 *   npm run demo:checks -- security|input|concurrency|bundles|billing|limits|admin
 *
 * Signs in at Keycloak with a DPoP-bound token request (like demo-client.ts), prints one
 * PASS/FAIL line per check and exits non-zero if any check fails. `concurrency`, `bundles` and
 * `billing` use a freshly registered account (register it on the Keycloak login page first).
 *
 * Env: OIDC_ISSUER, API_URL, DATABASE_URL, OIDC_CLIENT_ID, DEMO_USER, DEMO_PASSWORD, DEMO_ADMIN,
 * DEMO_ADMIN_PASSWORD, DEMO_SIGNUP_USER, DEMO_SIGNUP_PASSWORD.
 */
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { base64url, decodeJwt } from 'jose';
import pg from 'pg';
import { DpopKey } from '../test/support/dpop.js';

const ISSUER = process.env.OIDC_ISSUER ?? 'http://localhost:8080/realms/ggi';
const API = (process.env.API_URL ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ggi:ggi@localhost:5432/ggi';
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'ggi-web';
const ACCOUNTS = {
  user: [
    process.env.DEMO_USER ?? 'user@example.com',
    process.env.DEMO_PASSWORD ?? 'Demo-User-Pass-2026',
  ],
  admin: [
    process.env.DEMO_ADMIN ?? 'admin@example.com',
    process.env.DEMO_ADMIN_PASSWORD ?? 'Demo-Admin-Pass-2026',
  ],
  signup: [
    process.env.DEMO_SIGNUP_USER ?? 'syed.basit@example.com',
    process.env.DEMO_SIGNUP_PASSWORD ?? 'Basit-Pass-2026',
  ],
} as const;

interface Session {
  email: string;
  token: string;
  key: DpopKey;
}

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

interface SubscriptionItem {
  id: string;
  userId: string;
  tier: string;
  status: string;
  inactiveReason: string | null;
  startDate: string;
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : `, expected ${JSON.stringify(expected)}`}`,
  );
}

function note(text: string): void {
  console.log(`      ${text}`);
}

const ath = (token: string) => base64url.encode(createHash('sha256').update(token).digest());
const code = (reply: Reply): string | undefined => reply.body?.error?.code;
const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'none');

async function signIn(account: keyof typeof ACCOUNTS): Promise<Session> {
  const [email, password] = ACCOUNTS[account];
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
        username: email,
        password,
        scope: 'openid',
      }),
    });
    const body = (await response.json()) as Record<string, string>;
    if (response.ok && body.access_token) {
      const claims = decodeJwt(body.access_token);
      console.log(
        `signed in ${email}: token_type=${body.token_type}, cnf.jkt bound=${JSON.stringify(claims.cnf ?? null)}`,
      );
      return { email, token: body.access_token, key };
    }
    const serverNonce = response.headers.get('dpop-nonce');
    if (body.error === 'use_dpop_nonce' && serverNonce) {
      nonce = serverNonce;
      continue;
    }
    throw new Error(`Sign-in failed for ${email} (${response.status}): ${JSON.stringify(body)}`);
  }
  throw new Error('Sign-in failed: DPoP nonce negotiation did not converge');
}

async function call(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
  options: { proof?: string; headers?: Record<string, string>; raw?: string } = {},
): Promise<Reply> {
  const url = `${API}${path}`;
  const proof =
    options.proof ??
    (await session.key.proof({ method, url: url.split('?')[0] ?? url, ath: ath(session.token) }));
  const hasBody = body !== undefined || options.raw !== undefined;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `DPoP ${session.token}`,
      DPoP: proof,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(hasBody ? { body: options.raw ?? JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function anonymous(path: string): Promise<Reply> {
  const response = await fetch(`${API}${path}`);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function userIdOf(session: Session): Promise<string> {
  const reply = await call(session, 'GET', '/api/v1/auth/me');
  return reply.body.user.id;
}

/** Buys a bundle; a simulated decline is shown and the purchase retried. */
async function buy(session: Session, tier: string, billingCycle: string, autoRenew = true) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const reply = await call(session, 'POST', '/api/v1/subscriptions', {
      tier,
      billingCycle,
      autoRenew,
    });
    if (reply.status === 201) {
      check(`buy ${tier} (${billingCycle})`, reply.status, 201);
      return reply.body;
    }
    if (code(reply) === 'PAYMENT_FAILED') {
      note(
        `buy ${tier}: 402 PAYMENT_FAILED (${reply.body.error.details.reason}), stored as inactive; trying again`,
      );
      continue;
    }
    check(`buy ${tier} (${billingCycle})`, [reply.status, code(reply)], 201);
    throw new Error('purchase failed');
  }
  throw new Error('too many declined payments');
}

async function security(): Promise<void> {
  const user = await signIn('user');

  const anon = await anonymous('/api/v1/health');
  check('no token at all (GET /health)', [anon.status, code(anon)], [401, 'UNAUTHENTICATED']);
  const hidden = await anonymous('/api/v1/internal/debug');
  check('unknown route without a token', [hidden.status, code(hidden)], [401, 'UNAUTHENTICATED']);

  const url = `${API}/api/v1/health`;
  const proof = await user.key.proof({ method: 'GET', url, ath: ath(user.token) });
  const ok = await call(user, 'GET', '/api/v1/health', undefined, { proof });
  check('token + fresh DPoP proof', [ok.status, ok.body?.status], [200, 'ok']);

  const replay = await call(user, 'GET', '/api/v1/health', undefined, { proof });
  check(
    'same proof sent again (replay)',
    [replay.status, code(replay)],
    [401, 'DPOP_PROOF_REPLAYED'],
  );

  const elsewhere = await user.key.proof({
    method: 'GET',
    url: `${API}/api/v1/chat/usage`,
    ath: ath(user.token),
  });
  const moved = await call(user, 'GET', '/api/v1/health', undefined, { proof: elsewhere });
  check('proof made for another URL', [moved.status, code(moved)], [401, 'INVALID_DPOP_PROOF']);

  const stale = await user.key.proof({
    method: 'GET',
    url,
    ath: ath(user.token),
    iat: Math.floor(Date.now() / 1000) - 300,
  });
  const old = await call(user, 'GET', '/api/v1/health', undefined, { proof: stale });
  check('proof signed 5 minutes ago', [old.status, code(old)], [401, 'INVALID_DPOP_PROOF']);

  const attacker = await DpopKey.generate('ES256');
  const stolen = await call({ ...user, key: attacker }, 'GET', '/api/v1/health');
  check(
    "stolen token used with the attacker's own key",
    [stolen.status, code(stolen)],
    [401, 'TOKEN_BINDING_MISMATCH'],
  );

  const [header, payload, signature] = user.token.split('.');
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
  claims.roles = ['user', 'admin'];
  const edited = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
  const forged = await call({ ...user, token: edited }, 'GET', '/api/v1/health');
  check(
    'token edited to add the admin role',
    [forged.status, code(forged)],
    [401, 'INVALID_TOKEN'],
  );

  note('security headers on every response:');
  for (const name of [
    'content-security-policy',
    'strict-transport-security',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'cache-control',
  ]) {
    note(`  ${name}: ${ok.headers.get(name)}`);
  }
}

async function input(): Promise<void> {
  const user = await signIn('user');

  const extra = await call(user, 'POST', '/api/v1/chat/messages', {
    question: 'Hello',
    role: 'admin',
  });
  check('unknown field in the body', [extra.status, code(extra)], [400, 'VALIDATION_FAILED']);
  note(`details: ${JSON.stringify(extra.body?.error?.details)}`);

  const mass = await call(user, 'POST', '/api/v1/subscriptions', {
    tier: 'pro',
    billingCycle: 'monthly',
    priceCents: 1,
    maxMessages: 1_000_000,
  });
  check(
    'client sets its own price and allowance',
    [mass.status, code(mass)],
    [400, 'VALIDATION_FAILED'],
  );

  const plain = await call(user, 'POST', '/api/v1/chat/messages', undefined, {
    raw: 'question=Hello',
    headers: { 'content-type': 'text/plain' },
  });
  check('text/plain body', [plain.status, code(plain)], [415, 'UNSUPPORTED_MEDIA_TYPE']);

  const broken = await call(user, 'POST', '/api/v1/chat/messages', undefined, {
    raw: '{"question": "Hello"',
  });
  check('malformed JSON', [broken.status, code(broken)], [400, 'MALFORMED_JSON']);

  const big = await call(user, 'POST', '/api/v1/chat/messages', { question: 'x'.repeat(20_000) });
  check('20 KB body (limit is 16 KB)', [big.status, code(big)], [413, 'PAYLOAD_TOO_LARGE']);

  const foreign = await call(user, 'GET', '/api/v1/chat/usage', undefined, {
    headers: { origin: 'https://evil.example' },
  });
  check(
    'request from a foreign origin',
    [foreign.status, code(foreign)],
    [403, 'CORS_ORIGIN_DENIED'],
  );

  const xss = await call(user, 'POST', '/api/v1/chat/messages', {
    question: 'Is <b>this</b> safe?<script>alert(1)</script>',
  });
  check(
    'HTML is stripped before it is stored',
    [xss.status, xss.body?.message?.question],
    [201, 'Is this safe?'],
  );

  const sql = "'; DROP TABLE chat_messages; --";
  const injection = await call(user, 'POST', '/api/v1/chat/messages', { question: sql });
  check(
    'SQL in a question is stored as plain text',
    [injection.status, injection.body?.message?.question],
    [201, sql],
  );
  const history = await call(user, 'GET', '/api/v1/chat/messages?limit=1');
  check(
    'chat_messages table still works',
    [history.status, history.body?.items?.[0]?.question],
    [200, sql],
  );
}

async function concurrency(): Promise<void> {
  const me = await signIn('signup');
  const before = await call(me, 'GET', '/api/v1/chat/usage');
  const left: number = before.body.free.remaining;
  note(`${me.email}: ${left} free messages left this month, ${before.body.bundles.length} bundles`);
  const total = left + 7;
  note(`sending ${total} questions at the same moment...`);
  const replies = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      call(me, 'POST', '/api/v1/chat/messages', { question: `Parallel question ${i + 1}` }),
    ),
  );
  const tally: Record<string, number> = {};
  for (const reply of replies) tally[reply.status] = (tally[reply.status] ?? 0) + 1;
  check('only the remaining quota succeeds', tally, left > 0 ? { 201: left, 402: 7 } : { 402: 7 });
  const after = await call(me, 'GET', '/api/v1/chat/usage');
  check(
    'free quota is used exactly, never below zero',
    [after.body.free.used, after.body.free.remaining],
    [after.body.free.limit, 0],
  );
}

async function bundles(): Promise<void> {
  const me = await signIn('signup');
  const pro = await buy(me, 'pro', 'monthly');
  note(
    `pro: ${pro.maxMessages} messages, ${dollars(pro.price.amountCents)} a month, renews ${day(pro.renewalDate)}`,
  );
  const enterprise = await buy(me, 'enterprise', 'yearly', false);
  note(
    `enterprise: unlimited, ${dollars(enterprise.price.amountCents)} a year, auto-renew off, ends ${day(enterprise.endDate)}`,
  );
  const tiers: Record<string, string> = { [pro.id]: 'pro', [enterprise.id]: 'enterprise' };
  const tierOf = (reply: Reply) => tiers[reply.body?.quota?.subscriptionId ?? ''];

  const first = await call(me, 'POST', '/api/v1/chat/messages', { question: 'Which bundle pays?' });
  check(
    'the next message is charged to the newest bundle',
    [first.status, tierOf(first)],
    [201, 'enterprise'],
  );

  const cancelled = await call(me, 'POST', `/api/v1/subscriptions/${enterprise.id}/cancel`);
  check(
    'cancel enterprise',
    [cancelled.status, cancelled.body?.status, cancelled.body?.inactiveReason],
    [200, 'inactive', 'cancelled'],
  );
  note(
    `cycle ended now, renewalDate ${cancelled.body?.renewalDate}, its usage is kept: ${cancelled.body?.currentPeriodUsage?.used} used`,
  );

  const second = await call(me, 'POST', '/api/v1/chat/messages', { question: 'And now?' });
  check('after cancelling, the charge moves to pro', [second.status, tierOf(second)], [201, 'pro']);
}

async function billing(): Promise<void> {
  // The check ends billing cycles directly in the database, so it only runs against a local one.
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) {
    throw new Error('The billing check only runs against a local database.');
  }
  const me = await signIn('signup');
  const userId = await userIdOf(me);
  const db = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    note('buying 4 more basic bundles (the payment simulator declines about 1 in 10)');
    const outcomes: string[] = [];
    const bought: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const reply = await call(me, 'POST', '/api/v1/subscriptions', {
        tier: 'basic',
        billingCycle: 'monthly',
      });
      if (reply.status === 201) bought.push(reply.body.id);
      outcomes.push(reply.status === 201 ? '201' : `402 ${reply.body?.error?.details?.reason}`);
    }
    note(`purchases: ${outcomes.join(', ')}`);

    const stopping = bought[0] ?? '';
    const off = await call(me, 'PATCH', `/api/v1/subscriptions/${stopping}`, { autoRenew: false });
    check(
      'turn auto-renew off on one bundle',
      [off.status, off.body?.autoRenew, off.body?.renewalDate],
      [200, false, null],
    );

    const list = async (): Promise<SubscriptionItem[]> =>
      (await call(me, 'GET', '/api/v1/subscriptions?limit=50')).body.items;
    let failedSeen = false;
    for (let month = 1; month <= 6 && !failedSeen; month += 1) {
      const before = new Map((await list()).map((s) => [s.id, s]));
      // Simulates the end of the month: every active cycle of this account ends now.
      const due = await db.query(
        `UPDATE subscriptions
            SET end_date = now(), renewal_date = CASE WHEN auto_renew THEN now() END
          WHERE user_id = $1 AND status = 'active'`,
        [userId],
      );
      if (month === 1) {
        note(
          `fast-forward: UPDATE subscriptions SET end_date = now() WHERE status = 'active'  (${due.rowCount} bundles at the end of their month)`,
        );
      }
      const started = Date.now();
      for (;;) {
        const { rows } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1 AND status = 'active' AND end_date <= now()`,
          [userId],
        );
        if (rows[0]?.n === 0) break;
        if (Date.now() - started > 120_000)
          throw new Error('The billing job did not run within 2 minutes.');
        await sleep(150);
      }
      let renewed = 0;
      let failed = 0;
      let expired = 0;
      for (const s of await list()) {
        const was = before.get(s.id);
        if (was?.status !== 'active') continue;
        if (s.status === 'active' && s.startDate !== was.startDate) renewed += 1;
        if (s.inactiveReason === 'payment_failed') failed += 1;
        if (s.inactiveReason === 'expired') expired += 1;
      }
      failedSeen = failed > 0;
      note(
        `month ${month}: billing job ran ${((Date.now() - started) / 1000).toFixed(1)} s later: renewed ${renewed}, payment failed ${failed}, expired ${expired}`,
      );
    }

    const final = await list();
    const declined = final.find((s) => s.inactiveReason === 'payment_failed');
    check(
      'a declined payment makes the bundle inactive',
      [declined?.status, declined?.inactiveReason],
      ['inactive', 'payment_failed'],
    );
    const stopped = final.find((s) => s.id === stopping);
    check(
      'auto-renew off: expired, not charged again',
      [stopped?.status, stopped?.inactiveReason],
      ['inactive', 'expired'],
    );
    const enterprise = final.find((s) => s.tier === 'enterprise');
    if (enterprise) {
      check(
        'cancelled enterprise was never billed again',
        [enterprise.status, enterprise.inactiveReason],
        ['inactive', 'cancelled'],
      );
    }
    const { rows } = await db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM payments WHERE user_id = $1 GROUP BY status ORDER BY status`,
      [userId],
    );
    note(`payments recorded for ${me.email}: ${rows.map((r) => `${r.n} ${r.status}`).join(', ')}`);
  } finally {
    await db.end();
  }
}

async function limits(): Promise<void> {
  const admin = await signIn('admin');
  const probes: [string, string][] = [
    ['auth', '/api/v1/auth/me'],
    ['chat', '/api/v1/chat/usage'],
    ['subscriptions', '/api/v1/subscriptions/plans'],
    ['admin', '/api/v1/admin/metrics'],
  ];
  const seen: string[] = [];
  for (const [policy, path] of probes) {
    const reply = await call(admin, 'GET', path);
    seen.push(`${policy} ${reply.headers.get('ratelimit-limit')}`);
  }
  note(`per-user limits per minute (RateLimit-Limit): ${seen.join(', ')}`);

  const statuses: number[] = [];
  let last: Reply | null = null;
  for (let i = 0; i < 12; i += 1) {
    last = await call(admin, 'GET', '/api/v1/auth/me');
    statuses.push(last.status);
  }
  const runs: { status: number; count: number }[] = [];
  for (const status of statuses) {
    const tail = runs.at(-1);
    if (tail?.status === status) tail.count += 1;
    else runs.push({ status, count: 1 });
  }
  note(
    `12 more GET /auth/me in a row: ${runs.map((r) => `${r.status} x${r.count}`).join(', then ')}`,
  );
  check('over the limit', [last?.status, last ? code(last) : null], [429, 'RATE_LIMITED']);
  note(
    `Retry-After: ${last?.headers.get('retry-after')} s, details: ${JSON.stringify(last?.body?.error?.details)}`,
  );
}

async function admin(): Promise<void> {
  const user = await signIn('user');
  const boss = await signIn('admin');
  const userId = await userIdOf(user);

  const all = await call(boss, 'GET', '/api/v1/admin/subscriptions?limit=100');
  const items: SubscriptionItem[] = all.body?.items ?? [];
  check('admin lists every subscription', all.status, 200);
  note(`${items.length} subscriptions from ${new Set(items.map((s) => s.userId)).size} users`);

  const other = items.find((s) => s.userId !== userId);
  if (other) {
    const peek = await call(user, 'GET', `/api/v1/subscriptions/${other.id}`);
    check("user opens another user's subscription", [peek.status, code(peek)], [404, 'NOT_FOUND']);
    const cancel = await call(user, 'POST', `/api/v1/subscriptions/${other.id}/cancel`);
    check('user tries to cancel it', [cancel.status, code(cancel)], [404, 'NOT_FOUND']);
  } else {
    note("no other user's subscription yet: run the bundles check first to see ownership checks");
  }
  const forbidden = await call(user, 'GET', '/api/v1/admin/subscriptions');
  check('user calls an admin endpoint', [forbidden.status, code(forbidden)], [403, 'FORBIDDEN']);

  const metrics = await call(boss, 'GET', '/api/v1/admin/metrics');
  check('admin reads system metrics', metrics.status, 200);
  const { users, usage, subscriptions, billing: money } = metrics.body;
  note(
    `users ${users.total}; messages this month ${usage.messagesThisMonth} (free ${usage.bySource.free}, bundles ${usage.bySource.subscription}); tokens ${usage.tokensThisMonth.total}`,
  );
  note(
    `subscriptions: ${subscriptions.active} active, ${subscriptions.inactive} inactive ${JSON.stringify(subscriptions.inactiveByReason)}`,
  );
  note(
    `payments: ${money.paymentsSucceeded} succeeded, ${money.paymentsFailed} declined, revenue ${dollars(money.revenueCents)}`,
  );
}

const TOPICS: Record<string, () => Promise<void>> = {
  security,
  input,
  concurrency,
  bundles,
  billing,
  limits,
  admin,
};

const topic = process.argv[2] ?? '';
const run = TOPICS[topic];
if (!run) {
  console.error(`usage: npm run demo:checks -- <${Object.keys(TOPICS).join('|')}>`);
  process.exit(2);
}
run()
  .then(() => {
    if (failures > 0) {
      console.error(`${failures} check(s) failed`);
      process.exit(1);
    }
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
