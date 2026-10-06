import { sql, type Kysely } from 'kysely';

/**
 * Initial schema. Business invariants are also enforced by the database
 * (CHECK constraints), so even a bug in application code cannot over-consume
 * a quota or create a contradictory subscription state.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE users (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      idp_issuer  text NOT NULL,
      idp_subject text NOT NULL,
      email       text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT users_identity_uq UNIQUE (idp_issuer, idp_subject)
    )`.execute(db);

  await sql`
    CREATE TABLE auth_sessions (
      session_key    text PRIMARY KEY,
      user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      jkt            text NOT NULL,
      binding_source text NOT NULL CHECK (binding_source IN ('cnf', 'first_use')),
      expires_at     timestamptz NOT NULL,
      revoked_at     timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at)`.execute(db);

  await sql`
    CREATE TABLE dpop_proof_replays (
      proof_key  text PRIMARY KEY,
      expires_at timestamptz NOT NULL
    )`.execute(db);
  await sql`CREATE INDEX dpop_proof_replays_expires_idx ON dpop_proof_replays (expires_at)`.execute(
    db,
  );

  await sql`CREATE TYPE subscription_tier AS ENUM ('basic', 'pro', 'enterprise')`.execute(db);
  await sql`CREATE TYPE billing_cycle AS ENUM ('monthly', 'yearly')`.execute(db);
  await sql`CREATE TYPE subscription_status AS ENUM ('active', 'inactive')`.execute(db);
  await sql`CREATE TYPE subscription_inactive_reason AS ENUM ('cancelled', 'payment_failed', 'expired')`.execute(
    db,
  );

  await sql`
    CREATE TABLE subscriptions (
      id              uuid PRIMARY KEY,
      user_id         uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      tier            subscription_tier NOT NULL,
      billing_cycle   billing_cycle NOT NULL,
      max_messages    integer CHECK (max_messages IS NULL OR max_messages > 0),
      price_cents     integer NOT NULL CHECK (price_cents >= 0),
      currency        char(3) NOT NULL,
      auto_renew      boolean NOT NULL,
      status          subscription_status NOT NULL,
      inactive_reason subscription_inactive_reason,
      start_date      timestamptz NOT NULL,
      end_date        timestamptz NOT NULL,
      renewal_date    timestamptz,
      cancelled_at    timestamptz,
      created_at      timestamptz NOT NULL,
      updated_at      timestamptz NOT NULL,
      CONSTRAINT subscriptions_period_ck CHECK (end_date > start_date),
      CONSTRAINT subscriptions_status_reason_ck CHECK ((status = 'active') = (inactive_reason IS NULL)),
      CONSTRAINT subscriptions_renewal_ck CHECK (renewal_date IS NULL OR (status = 'active' AND auto_renew))
    )`.execute(db);
  await sql`CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, created_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX subscriptions_created_idx ON subscriptions (created_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX subscriptions_billing_due_idx ON subscriptions (end_date) WHERE status = 'active'`.execute(
    db,
  );

  await sql`
    CREATE TABLE subscription_usage (
      subscription_id uuid NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
      period_start    timestamptz NOT NULL,
      used            integer NOT NULL CHECK (used >= 0),
      max_messages    integer,
      updated_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (subscription_id, period_start),
      CONSTRAINT subscription_usage_within_allowance_ck CHECK (max_messages IS NULL OR used <= max_messages)
    )`.execute(db);

  await sql`
    CREATE TABLE free_usage_monthly (
      user_id      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      period_month date NOT NULL CHECK (extract(day FROM period_month) = 1),
      used         integer NOT NULL CHECK (used >= 0),
      free_limit   integer NOT NULL CHECK (free_limit >= 0),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, period_month),
      CONSTRAINT free_usage_within_limit_ck CHECK (used <= free_limit)
    )`.execute(db);

  await sql`CREATE TYPE chat_message_status AS ENUM ('pending', 'completed', 'failed')`.execute(db);
  await sql`CREATE TYPE quota_source AS ENUM ('free', 'subscription')`.execute(db);

  await sql`
    CREATE TABLE chat_messages (
      id                   uuid PRIMARY KEY,
      user_id              uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      question             text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 4000),
      answer               text,
      status               chat_message_status NOT NULL,
      quota_source         quota_source NOT NULL,
      subscription_id      uuid REFERENCES subscriptions (id) ON DELETE RESTRICT,
      quota_period_start   timestamptz NOT NULL,
      model                text,
      provider_response_id text,
      prompt_tokens        integer CHECK (prompt_tokens >= 0),
      completion_tokens    integer CHECK (completion_tokens >= 0),
      total_tokens         integer CHECK (total_tokens >= 0),
      latency_ms           integer CHECK (latency_ms >= 0),
      failure_code         text,
      request_id           text NOT NULL,
      created_at           timestamptz NOT NULL,
      completed_at         timestamptz,
      CONSTRAINT chat_messages_source_ck CHECK ((quota_source = 'subscription') = (subscription_id IS NOT NULL)),
      CONSTRAINT chat_messages_completed_ck CHECK (status <> 'completed' OR (answer IS NOT NULL AND total_tokens IS NOT NULL))
    )`.execute(db);
  await sql`CREATE INDEX chat_messages_user_idx ON chat_messages (user_id, created_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX chat_messages_created_idx ON chat_messages (created_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX chat_messages_subscription_idx ON chat_messages (subscription_id) WHERE subscription_id IS NOT NULL`.execute(
    db,
  );

  await sql`CREATE TYPE payment_kind AS ENUM ('initial', 'renewal')`.execute(db);
  await sql`CREATE TYPE payment_status AS ENUM ('succeeded', 'failed')`.execute(db);

  await sql`
    CREATE TABLE payments (
      id                 uuid PRIMARY KEY,
      subscription_id    uuid NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
      user_id            uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      kind               payment_kind NOT NULL,
      amount_cents       integer NOT NULL CHECK (amount_cents >= 0),
      currency           char(3) NOT NULL,
      status             payment_status NOT NULL,
      failure_reason     text,
      provider_reference text,
      period_start       timestamptz NOT NULL,
      period_end         timestamptz NOT NULL,
      created_at         timestamptz NOT NULL
    )`.execute(db);
  await sql`CREATE INDEX payments_subscription_idx ON payments (subscription_id, created_at DESC)`.execute(
    db,
  );

  // Ephemeral counters: UNLOGGED skips WAL, losing them on a crash only resets windows.
  await sql`
    CREATE UNLOGGED TABLE rate_limit_buckets (
      bucket_key   text NOT NULL,
      window_start timestamptz NOT NULL,
      hits         integer NOT NULL,
      expires_at   timestamptz NOT NULL,
      PRIMARY KEY (bucket_key, window_start)
    )`.execute(db);
  await sql`CREATE INDEX rate_limit_buckets_expires_idx ON rate_limit_buckets (expires_at)`.execute(
    db,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'rate_limit_buckets',
    'payments',
    'chat_messages',
    'free_usage_monthly',
    'subscription_usage',
    'subscriptions',
    'dpop_proof_replays',
    'auth_sessions',
    'users',
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
  }
  for (const type of [
    'payment_status',
    'payment_kind',
    'quota_source',
    'chat_message_status',
    'subscription_inactive_reason',
    'subscription_status',
    'billing_cycle',
    'subscription_tier',
  ]) {
    await sql`DROP TYPE IF EXISTS ${sql.id(type)}`.execute(db);
  }
}
