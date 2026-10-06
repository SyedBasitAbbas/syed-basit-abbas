import { sql } from 'kysely';
import type { DbExecutor } from '../../../../shared/infrastructure/database/database.js';
import type {
  AuthSessionRepository,
  BindingSource,
  ExternalIdentity,
  SessionBindingOutcome,
  UserRepository,
} from '../identity.repository.js';

const USER_CACHE_LIMIT = 10_000;

export class PostgresUserRepository implements UserRepository {
  /** issuer|subject -> local user id. Ids never change, so caching is safe. */
  private readonly cache = new Map<string, string>();

  constructor(private readonly db: DbExecutor) {}

  async ensureUser(identity: ExternalIdentity): Promise<{ id: string }> {
    const cacheKey = `${identity.issuer}|${identity.subject}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { id: cached };

    const inserted = await this.db
      .insertInto('users')
      .values({ idp_issuer: identity.issuer, idp_subject: identity.subject, email: identity.email })
      .onConflict((oc) => oc.columns(['idp_issuer', 'idp_subject']).doNothing())
      .returning('id')
      .executeTakeFirst();
    const id =
      inserted?.id ??
      (
        await this.db
          .selectFrom('users')
          .select('id')
          .where('idp_issuer', '=', identity.issuer)
          .where('idp_subject', '=', identity.subject)
          .executeTakeFirstOrThrow()
      ).id;

    if (this.cache.size >= USER_CACHE_LIMIT) this.cache.clear();
    this.cache.set(cacheKey, id);
    return { id };
  }
}

export class PostgresAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly db: DbExecutor) {}

  async bind(input: {
    sessionKey: string;
    userId: string;
    jkt: string;
    source: BindingSource;
    expiresAt: Date;
  }): Promise<SessionBindingOutcome> {
    // First use binds the session to the presented key; later requests must
    // present the same key. Expiry only ever moves forward, and only for the
    // legitimate key holder.
    const { rows } = await sql<{
      user_id: string;
      jkt: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>`
      INSERT INTO auth_sessions (session_key, user_id, jkt, binding_source, expires_at)
      VALUES (${input.sessionKey}, ${input.userId}, ${input.jkt}, ${input.source}, ${input.expiresAt})
      ON CONFLICT (session_key) DO UPDATE
         SET expires_at = CASE
               WHEN auth_sessions.jkt = EXCLUDED.jkt AND auth_sessions.user_id = EXCLUDED.user_id
               THEN GREATEST(auth_sessions.expires_at, EXCLUDED.expires_at)
               ELSE auth_sessions.expires_at
             END
      RETURNING user_id, jkt, revoked_at, expires_at`.execute(this.db);

    const row = rows[0];
    if (!row) throw new Error('Session binding upsert returned no row');
    if (row.user_id !== input.userId) return { status: 'owner_mismatch' };
    if (row.revoked_at !== null) return { status: 'revoked' };
    if (row.jkt !== input.jkt) return { status: 'key_mismatch' };
    return { status: 'bound', expiresAt: row.expires_at };
  }

  async revoke(sessionKey: string, now: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('session_key', '=', sessionKey)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
