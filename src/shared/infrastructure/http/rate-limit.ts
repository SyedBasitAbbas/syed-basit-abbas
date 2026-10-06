import { isIPv4, isIPv6 } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { sql } from 'kysely';
import { AppError } from '../../domain/errors.js';
import type { Db } from '../database/database.js';

export interface RateLimitHit {
  count: number;
  resetAtMs: number;
}

/** Fixed-window counter store. */
export interface RateLimitStore {
  hit(key: string, windowMs: number, nowMs: number): Promise<RateLimitHit>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { windowStart: number; hits: number }>();

  hit(key: string, windowMs: number, nowMs: number): Promise<RateLimitHit> {
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    if (this.buckets.size > 50_000) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.windowStart + windowMs <= nowMs) this.buckets.delete(bucketKey);
      }
    }
    const bucket = this.buckets.get(key);
    if (bucket?.windowStart !== windowStart) {
      this.buckets.set(key, { windowStart, hits: 1 });
      return Promise.resolve({ count: 1, resetAtMs: windowStart + windowMs });
    }
    bucket.hits += 1;
    return Promise.resolve({ count: bucket.hits, resetAtMs: windowStart + windowMs });
  }
}

/** Shared by every API instance, so limits hold behind a load balancer. */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly db: Db) {}

  async hit(key: string, windowMs: number, nowMs: number): Promise<RateLimitHit> {
    const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);
    const expiresAt = new Date(windowStart.getTime() + windowMs);
    const { rows } = await sql<{ hits: number }>`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, hits, expires_at)
      VALUES (${key}, ${windowStart}, 1, ${expiresAt})
      ON CONFLICT (bucket_key, window_start)
      DO UPDATE SET hits = rate_limit_buckets.hits + 1
      RETURNING hits`.execute(this.db);
    return { count: rows[0]?.hits ?? 1, resetAtMs: expiresAt.getTime() };
  }
}

/** The /64 network of an IPv6 address, e.g. `2001:db8:1::5` -> `2001:db8:1:0::/64`. */
export function ipv6Prefix64(address: string): string {
  const [withoutZone = address] = address.split('%');
  const [head = '', tail] = withoutZone.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  // An embedded IPv4 suffix (a.b.c.d) occupies two 16-bit groups.
  const width = (groups: string[]) =>
    groups.reduce((sum, group) => sum + (group.includes('.') ? 2 : 1), 0);
  const zeros =
    tail === undefined ? [] : Array<string>(8 - width(headGroups) - width(tailGroups)).fill('0');
  const groups = [...headGroups, ...zeros, ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Client address used as the per-IP key. IPv6 clients are grouped by /64,
 * because a single host can rotate through a whole /64 at will.
 */
export function clientAddressKey(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(ip)) return ip;
  if (isIPv6(ip)) return ipv6Prefix64(ip);
  return ip;
}

export interface RateLimitRule {
  /** Policy name, e.g. "chat". Different policies have independent counters. */
  policy: string;
  scope: 'ip' | 'user';
  limit: number;
  windowMs: number;
}

export function rateLimit(
  rule: RateLimitRule,
  store: RateLimitStore,
  now: () => number = Date.now,
): RequestHandler {
  return async (req, res, next) => {
    const subject = rule.scope === 'ip' ? clientAddressKey(req) : res.locals.auth?.actor.userId;
    if (subject === undefined) {
      // Wiring error: a per-user limiter must run after authentication.
      throw new Error(`Rate limiter "${rule.policy}" (user scope) mounted before authentication`);
    }
    const nowMs = now();
    const { count, resetAtMs } = await store.hit(
      `${rule.policy}:${rule.scope}:${subject}`,
      rule.windowMs,
      nowMs,
    );
    const resetSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
    res.setHeader('RateLimit-Limit', String(rule.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, rule.limit - count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    if (count > rule.limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      throw new AppError('RATE_LIMITED', 'Too many requests. Slow down and retry later.', {
        policy: rule.policy,
        scope: rule.scope,
        limit: rule.limit,
        windowSeconds: Math.round(rule.windowMs / 1000),
        retryAfterSeconds: resetSeconds,
      });
    }
    next();
  };
}
