import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { pino } from 'pino';
import request, { type Response } from 'supertest';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createContainer, type Container, type ContainerOverrides } from '../../src/container.js';
import type { Role } from '../../src/shared/domain/actor.js';
import { DpopKey } from './dpop.js';
import { MockOidcProvider, type TokenOptions } from './mock-oidc-provider.js';

export const PUBLIC_BASE_URL = 'https://api.ggi.test';
export const ALLOWED_ORIGIN = 'https://app.ggi.test';

export interface TestApp {
  app: Express;
  container: Container;
  config: AppConfig;
  idp: MockOidcProvider;
  close(): Promise<void>;
}

export async function createTestApp(
  options: {
    env?: Record<string, string>;
    overrides?: ContainerOverrides;
    /** Share an IdP between app instances (simulates several API nodes). */
    idp?: MockOidcProvider;
  } = {},
): Promise<TestApp> {
  const ownsIdp = options.idp === undefined;
  const idp = options.idp ?? (await MockOidcProvider.start({ audience: 'ggi-api' }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL,
    DATABASE_URL: inject('databaseUrl'),
    DATABASE_POOL_MAX: '20',
    OIDC_ISSUER: idp.issuer,
    OIDC_AUDIENCE: 'ggi-api',
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    RATE_LIMIT_STORE: 'memory',
    RL_GLOBAL_IP: '10000',
    RL_AUTH_IP: '1000',
    RL_AUTH_USER: '1000',
    RL_CHAT_IP: '1000',
    RL_CHAT_USER: '1000',
    RL_SUBSCRIPTIONS_IP: '1000',
    RL_SUBSCRIPTIONS_USER: '1000',
    RL_ADMIN_IP: '1000',
    RL_ADMIN_USER: '1000',
    RL_SYSTEM_IP: '1000',
    RL_SYSTEM_USER: '1000',
    MOCK_AI_MIN_LATENCY_MS: '5',
    MOCK_AI_MAX_LATENCY_MS: '25',
    PAYMENT_FAILURE_RATE: '0',
    BILLING_ENABLED: 'false',
    ...options.env,
  });
  const container = createContainer(config, {
    logger: pino({ level: 'silent' }),
    ...options.overrides,
  });
  return {
    app: buildApp(container),
    container,
    config,
    idp,
    async close() {
      await container.close();
      if (ownsIdp) await idp.stop();
    },
  };
}

/** A signed-in client: an access token from the IdP plus the DPoP key it holds. */
export interface TestClient {
  sub: string;
  token: string;
  key: DpopKey;
  roles: Role[];
}

export async function signIn(
  idp: MockOidcProvider,
  options: {
    roles?: Role[];
    /** Default true: the IdP binds the token to the client's DPoP key (`cnf.jkt`). */
    bindTokenToKey?: boolean;
    token?: TokenOptions;
  } = {},
): Promise<TestClient> {
  const key = await DpopKey.generate();
  const sub = options.token?.sub ?? `user-${randomUUID()}`;
  const roles = options.roles ?? ['user'];
  const token = await idp.issueAccessToken({
    sub,
    roles,
    email: `${sub}@example.com`,
    ...((options.bindTokenToKey ?? true) ? { cnfJkt: key.jkt } : {}),
    ...options.token,
  });
  return { sub, token, key, roles };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Sends a request exactly like a compliant client: DPoP token + fresh proof. */
export async function call(
  app: Express,
  client: TestClient,
  method: Method,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const proof = await client.key.proof({
    method,
    url: `${PUBLIC_BASE_URL}${path.split('?')[0] ?? ''}`,
    accessToken: client.token,
  });
  const agent = request(app);
  let req =
    method === 'GET'
      ? agent.get(path)
      : method === 'POST'
        ? agent.post(path)
        : method === 'PATCH'
          ? agent.patch(path)
          : agent.delete(path);
  req = req.set('Authorization', `DPoP ${client.token}`).set('DPoP', proof);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

/** Wipes all rows between tests (schema stays). */
export async function resetDatabase(container: Container): Promise<void> {
  const { sql } = await import('kysely');
  await sql`TRUNCATE chat_messages, subscription_usage, free_usage_monthly, payments, subscriptions,
            auth_sessions, dpop_proof_replays, rate_limit_buckets, users RESTART IDENTITY CASCADE`.execute(
    container.db,
  );
}
