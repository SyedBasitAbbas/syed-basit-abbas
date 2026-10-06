import type { Db } from '../database/database.js';
import type { ReplayCache } from './dpop-proof-verifier.js';

/** Shared across all API instances: a proof replayed against another node is still rejected. */
export class PostgresReplayCache implements ReplayCache {
  constructor(private readonly db: Db) {}

  async markUsed(key: string, expiresAt: Date): Promise<boolean> {
    const inserted = await this.db
      .insertInto('dpop_proof_replays')
      .values({ proof_key: key, expires_at: expiresAt })
      .onConflict((oc) => oc.column('proof_key').doNothing())
      .returning('proof_key')
      .executeTakeFirst();
    return inserted !== undefined;
  }
}

export class InMemoryReplayCache implements ReplayCache {
  private readonly seen = new Map<string, number>();

  markUsed(key: string, expiresAt: Date): Promise<boolean> {
    const now = Date.now();
    for (const [entry, expiry] of this.seen) if (expiry <= now) this.seen.delete(entry);
    if (this.seen.has(key)) return Promise.resolve(false);
    this.seen.set(key, expiresAt.getTime());
    return Promise.resolve(true);
  }
}
