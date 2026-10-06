import { describe, expect, it } from 'vitest';
import { MockOpenAiChatClient } from '../../../src/modules/chat/infrastructure/mock-openai.client.js';
import { SimulatedPaymentGateway } from '../../../src/modules/subscriptions/infrastructure/simulated-payment-gateway.js';
import { ConfigError, loadConfig } from '../../../src/config/env.js';
import { sanitizeText } from '../../../src/shared/infrastructure/http/sanitize.js';
import {
  ipv6Prefix64,
  MemoryRateLimitStore,
} from '../../../src/shared/infrastructure/http/rate-limit.js';

const BASE_ENV = {
  PUBLIC_BASE_URL: 'https://api.example.com',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  OIDC_ISSUER: 'https://idp.example.com/realms/ggi',
  OIDC_AUDIENCE: 'ggi-api',
};

describe('sanitizeText', () => {
  it('removes tags and dangerous blocks, escapes stray brackets', () => {
    expect(sanitizeText('<b>bold</b> <script>alert(1)</script>ok')).toBe('bold ok');
    expect(sanitizeText('a < b')).toBe('a &lt; b');
    expect(sanitizeText('<img src=x onerror=alert(1)>')).toBe('');
    expect(sanitizeText('<svg><script>x</script></svg>plain')).toBe('plain');
  });
});

describe('MockOpenAiChatClient', () => {
  it('returns an OpenAI-like completion with consistent token usage after simulated latency', async () => {
    const client = new MockOpenAiChatClient({ minLatencyMs: 30, maxLatencyMs: 30, failureRate: 0 });
    const started = Date.now();
    const result = await client.complete(
      { question: 'Why?', userId: 'u' },
      { signal: new AbortController().signal },
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(result.providerResponseId).toMatch(/^chatcmpl-mock-/);
    expect(result.tokenUsage.totalTokens).toBe(
      result.tokenUsage.promptTokens + result.tokenUsage.completionTokens,
    );
  });

  it('can be cancelled through the abort signal', async () => {
    const client = new MockOpenAiChatClient({
      minLatencyMs: 5_000,
      maxLatencyMs: 5_000,
      failureRate: 0,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      client.complete({ question: 'x', userId: 'u' }, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('can simulate provider failures', async () => {
    const client = new MockOpenAiChatClient({ minLatencyMs: 0, maxLatencyMs: 0, failureRate: 1 });
    await expect(
      client.complete({ question: 'x', userId: 'u' }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
  });
});

describe('SimulatedPaymentGateway', () => {
  const request = {
    idempotencyKey: 'k1',
    userId: 'u',
    subscriptionId: 's',
    amountCents: 999,
    currency: 'USD',
    description: 'd',
  };

  it('fails randomly at the configured rate', async () => {
    expect(
      (await new SimulatedPaymentGateway({ failureRate: 1, latencyMs: 0 }).charge(request)).status,
    ).toBe('failed');
    expect(
      (await new SimulatedPaymentGateway({ failureRate: 0, latencyMs: 0 }).charge(request)).status,
    ).toBe('succeeded');
  });

  it('is idempotent per key', async () => {
    let calls = 0;
    const gateway = new SimulatedPaymentGateway({
      failureRate: 0.5,
      latencyMs: 0,
      random: () => (calls++ === 0 ? 0.9 : 0.1),
    });
    const first = await gateway.charge(request);
    const second = await gateway.charge(request);
    expect(second).toEqual(first);
  });
});

describe('MemoryRateLimitStore', () => {
  it('counts hits per fixed window and resets on the next window', async () => {
    const store = new MemoryRateLimitStore();
    expect((await store.hit('k', 60_000, 0)).count).toBe(1);
    expect((await store.hit('k', 60_000, 59_999)).count).toBe(2);
    expect((await store.hit('k', 60_000, 60_000)).count).toBe(1);
    expect((await store.hit('other', 60_000, 60_000)).count).toBe(1);
  });
});

describe('ipv6Prefix64', () => {
  it('groups addresses of the same /64 together, however they are written', () => {
    expect(ipv6Prefix64('2001:db8:1::5')).toBe('2001:db8:1:0::/64');
    expect(ipv6Prefix64('2001:db8:1:0:5:6:7:8')).toBe('2001:db8:1:0::/64');
    expect(ipv6Prefix64('2001:0db8:0001:0000:aaaa::1')).toBe('2001:db8:1:0::/64');
    expect(ipv6Prefix64('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('keeps different /64 networks apart', () => {
    expect(ipv6Prefix64('2001::5:6:7:8:9')).toBe('2001:0:0:5::/64');
    expect(ipv6Prefix64('2001:0:0:6::1')).toBe('2001:0:0:6::/64');
    expect(ipv6Prefix64('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
  });
});

describe('loadConfig', () => {
  it('parses a minimal environment with secure defaults', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.quota.freeMessagesPerMonth).toBe(3);
    expect(config.dpop.algorithms).not.toContain('HS256');
    expect(config.server.corsAllowedOrigins).toEqual([]);
  });

  it('fails fast on missing or unsafe settings', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE_ENV, OIDC_ALGORITHMS: 'HS256' })).toThrow(/HS256/);
    expect(() => loadConfig({ ...BASE_ENV, CORS_ALLOWED_ORIGINS: '*' })).toThrow(/CORS/);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'http://api.example.com',
      }),
    ).toThrow(/https/);
  });
});
