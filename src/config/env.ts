import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');
const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
const count = (fallback: number) => z.coerce.number().int().min(1).default(fallback);
const millis = (fallback: number) => z.coerce.number().int().min(0).default(fallback);
const ratio = (fallback: number) => z.coerce.number().min(0).max(1).default(fallback);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** json (default, for log shipping) or pretty (local development only). */
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /** External base URL of the API; DPoP `htu` claims are checked against it. */
  PUBLIC_BASE_URL: z.url(),
  /** Express "trust proxy": false, true, a hop count, or a comma list of subnets. */
  TRUST_PROXY: z.string().default('false'),
  CORS_ALLOWED_ORIGINS: csv.default([]),
  BODY_LIMIT_BYTES: count(16_384),
  // Bounded well below the 10 minute reservation reaper (see ReapAbandonedReservations).
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  DATABASE_POOL_MAX: count(10),
  DATABASE_SSL: bool.default(false),
  DATABASE_STATEMENT_TIMEOUT_MS: count(5_000),

  OIDC_ISSUER: z.url(),
  OIDC_AUDIENCE: z.string().min(1),
  /** Optional override; by default it is discovered from the issuer metadata. */
  OIDC_JWKS_URI: z.url().optional(),
  OIDC_ALGORITHMS: csv.default(['RS256', 'PS256', 'ES256']),
  /** Claim that carries roles: a top-level claim name or a dot path (realm_access.roles). */
  OIDC_ROLES_CLAIM: z.string().default('roles'),
  OIDC_CLOCK_TOLERANCE_SEC: z.coerce.number().int().min(0).max(60).default(5),
  OIDC_MAX_TOKEN_LIFETIME_SEC: count(3_600),

  /**
   * true (default): only accept tokens the IdP bound to a DPoP key (`cnf.jkt`).
   * false: compatibility mode for IdPs without DPoP; the API binds the IdP
   * session to the first key it sees.
   */
  DPOP_REQUIRE_BOUND_TOKENS: bool.default(true),
  DPOP_PROOF_MAX_AGE_SEC: count(60),
  DPOP_ALGORITHMS: csv.default(['ES256', 'EdDSA', 'RS256', 'PS256']),

  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('postgres'),
  RATE_LIMIT_WINDOW_SEC: count(60),
  RL_GLOBAL_IP: count(600),
  RL_AUTH_IP: count(20),
  RL_AUTH_USER: count(10),
  RL_CHAT_IP: count(60),
  RL_CHAT_USER: count(20),
  RL_SUBSCRIPTIONS_IP: count(60),
  RL_SUBSCRIPTIONS_USER: count(30),
  RL_ADMIN_IP: count(120),
  RL_ADMIN_USER: count(120),
  RL_SYSTEM_IP: count(60),
  RL_SYSTEM_USER: count(60),

  FREE_MESSAGES_PER_MONTH: z.coerce.number().int().min(0).default(3),
  MOCK_AI_MIN_LATENCY_MS: millis(300),
  MOCK_AI_MAX_LATENCY_MS: millis(1_200),
  MOCK_AI_FAILURE_RATE: ratio(0),

  PAYMENT_FAILURE_RATE: ratio(0.1),
  BILLING_ENABLED: bool.default(true),
  BILLING_INTERVAL_MS: count(60_000),
});

export type RateLimitPolicyName = 'auth' | 'chat' | 'subscriptions' | 'admin' | 'system';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  logLevel: string;
  logFormat: 'json' | 'pretty';
  server: {
    host: string;
    port: number;
    publicBaseUrl: string;
    trustProxy: boolean | number | string;
    corsAllowedOrigins: string[];
    bodyLimitBytes: number;
    requestTimeoutMs: number;
  };
  database: { url: string; poolMax: number; ssl: boolean; statementTimeoutMs: number };
  oidc: {
    issuer: string;
    audience: string;
    jwksUri: string | undefined;
    algorithms: string[];
    rolesClaim: string;
    clockToleranceSec: number;
    maxTokenLifetimeSec: number;
  };
  dpop: { requireBoundTokens: boolean; proofMaxAgeSec: number; algorithms: string[] };
  rateLimit: {
    store: 'memory' | 'postgres';
    windowMs: number;
    globalPerIp: number;
    policies: Record<RateLimitPolicyName, { perIp: number; perUser: number }>;
  };
  quota: { freeMessagesPerMonth: number };
  mockAi: { minLatencyMs: number; maxLatencyMs: number; failureRate: number };
  billing: { enabled: boolean; intervalMs: number; paymentFailureRate: number };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function parseTrustProxy(raw: string): boolean | number | string {
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

const ASYMMETRIC_ALG = /^(RS|PS|ES)(256|384|512)$|^EdDSA$|^Ed25519$/;

/** Parses and validates the environment once at startup; fails fast on any problem. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }
  const env = parsed.data;

  const problems: string[] = [];
  for (const alg of [...env.OIDC_ALGORITHMS, ...env.DPOP_ALGORITHMS]) {
    if (!ASYMMETRIC_ALG.test(alg))
      problems.push(`algorithm "${alg}" is not an allowed asymmetric JWS algorithm`);
  }
  if (env.CORS_ALLOWED_ORIGINS.includes('*')) {
    problems.push('CORS_ALLOWED_ORIGINS must list explicit origins, "*" is not allowed');
  }
  if (env.MOCK_AI_MIN_LATENCY_MS > env.MOCK_AI_MAX_LATENCY_MS) {
    problems.push('MOCK_AI_MIN_LATENCY_MS must be <= MOCK_AI_MAX_LATENCY_MS');
  }
  if (env.NODE_ENV === 'production') {
    if (!env.PUBLIC_BASE_URL.startsWith('https://'))
      problems.push('PUBLIC_BASE_URL must use https in production');
    if (!env.OIDC_ISSUER.startsWith('https://'))
      problems.push('OIDC_ISSUER must use https in production');
    if (env.OIDC_JWKS_URI && !env.OIDC_JWKS_URI.startsWith('https://')) {
      problems.push('OIDC_JWKS_URI must use https in production');
    }
    if (env.RATE_LIMIT_STORE === 'memory') {
      problems.push('RATE_LIMIT_STORE=memory is per process; use postgres in production');
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    logFormat: env.LOG_FORMAT,
    server: {
      host: env.HOST,
      port: env.PORT,
      publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ''),
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
      bodyLimitBytes: env.BODY_LIMIT_BYTES,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    },
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      ssl: env.DATABASE_SSL,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    oidc: {
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_AUDIENCE,
      jwksUri: env.OIDC_JWKS_URI,
      algorithms: env.OIDC_ALGORITHMS,
      rolesClaim: env.OIDC_ROLES_CLAIM,
      clockToleranceSec: env.OIDC_CLOCK_TOLERANCE_SEC,
      maxTokenLifetimeSec: env.OIDC_MAX_TOKEN_LIFETIME_SEC,
    },
    dpop: {
      requireBoundTokens: env.DPOP_REQUIRE_BOUND_TOKENS,
      proofMaxAgeSec: env.DPOP_PROOF_MAX_AGE_SEC,
      algorithms: env.DPOP_ALGORITHMS,
    },
    rateLimit: {
      store: env.RATE_LIMIT_STORE,
      windowMs: env.RATE_LIMIT_WINDOW_SEC * 1000,
      globalPerIp: env.RL_GLOBAL_IP,
      policies: {
        auth: { perIp: env.RL_AUTH_IP, perUser: env.RL_AUTH_USER },
        chat: { perIp: env.RL_CHAT_IP, perUser: env.RL_CHAT_USER },
        subscriptions: { perIp: env.RL_SUBSCRIPTIONS_IP, perUser: env.RL_SUBSCRIPTIONS_USER },
        admin: { perIp: env.RL_ADMIN_IP, perUser: env.RL_ADMIN_USER },
        system: { perIp: env.RL_SYSTEM_IP, perUser: env.RL_SYSTEM_USER },
      },
    },
    quota: { freeMessagesPerMonth: env.FREE_MESSAGES_PER_MONTH },
    mockAi: {
      minLatencyMs: env.MOCK_AI_MIN_LATENCY_MS,
      maxLatencyMs: env.MOCK_AI_MAX_LATENCY_MS,
      failureRate: env.MOCK_AI_FAILURE_RATE,
    },
    billing: {
      enabled: env.BILLING_ENABLED,
      intervalMs: env.BILLING_INTERVAL_MS,
      paymentFailureRate: env.PAYMENT_FAILURE_RATE,
    },
  };
}
