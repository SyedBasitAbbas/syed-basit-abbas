# Secure AI Chat Backend

A security-first TypeScript backend for an AI chat product with monthly free quotas and paid
subscription bundles. Built with Clean Architecture / DDD, PostgreSQL, an external OpenID Connect
provider, and DPoP (RFC 9449) proof-of-possession on every request.

> The assessment brief is included at [`docs/GGI - BACKEND TEST POSTURE.pdf`](docs/GGI%20-%20BACKEND%20TEST%20POSTURE.pdf).

- **Stack:** Node.js 22, TypeScript 6 (strict), Express 5, PostgreSQL, Kysely (typed SQL and
  migrations), Zod 4 (schemas), jose (JWT, JWKS, DPoP), pino (structured logs), Vitest + Supertest.
- **Identity provider:** Keycloak (realm included, runs in `docker compose`), or any OIDC provider
  such as Auth0. Email/password sign-up and Google/GitHub login happen at the provider; the API
  contains no custom authentication code.
- **Quality gates:** `npm run check` runs the typecheck, ESLint (type-aware, with architecture
  boundary rules), Prettier and 136 tests (unit, plus integration tests against a real
  PostgreSQL). CI runs the same, plus an end-to-end job against a real Keycloak.

## Contents

1. [Quick start](#quick-start)
2. [Architecture decisions](#architecture-decisions)
3. [Security model](#security-model)
4. [Quota and billing design](#quota-and-billing-design)
5. [API reference](#api-reference)
6. [Testing](#testing)
7. [Configuration](#configuration)
8. [Assumptions and interpretations](#assumptions-and-interpretations)
9. [Trade-offs and next steps](#trade-offs-and-next-steps)

## Quick start

Prerequisites: Node.js 22.12+ and npm. Docker is optional.

### Option A: full stack with Docker (PostgreSQL + Keycloak + API)

```bash
docker compose up --build -d
npm ci
npm run demo
```

`npm run demo` signs in at Keycloak with email and password using a DPoP-bound token request,
then walks through the main flows (free quota, quota exhausted, buying a bundle, admin metrics,
logout) and prints every result. Demo accounts (local realm only):

| Account             | Password               | Roles         |
| ------------------- | ---------------------- | ------------- |
| `user@example.com`  | `Demo-User-Pass-2026`  | `user`        |
| `admin@example.com` | `Demo-Admin-Pass-2026` | `user, admin` |

New accounts can self-register on the Keycloak login page (email + password). Google and GitHub
login are preconfigured as identity brokers: export `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
(or the GitHub pair) from your OAuth app before `docker compose up`, with the redirect URI
`http://localhost:8080/realms/ggi/broker/google/endpoint`.

### Option B: run the API locally

```bash
npm ci
cp .env.example .env
npm run db:dev                   # terminal 1: embedded PostgreSQL in .data/pg (no Docker needed)
npm run migrate
docker compose up -d keycloak    # or point OIDC_* in .env at your own provider (see below)
npm run dev                      # terminal 2: API on http://localhost:3000
npm run demo
```

### Tests

```bash
npm test          # unit + integration (starts a throwaway embedded PostgreSQL automatically)
npm run check     # typecheck + lint + format check + tests
```

Set `TEST_DATABASE_URL` to run the integration tests against an existing PostgreSQL instead (CI
does this with a service container).

## Architecture decisions

### Layers (Clean Architecture, DDD-style)

```
src/
  modules/
    chat/                      # Module 1: AI chat, usage and quotas
      domain/
        entities/              # ChatMessage, Question, FreeMonthlyUsage, BundleAllowance
        services/              # quota.service.ts: pure quota decision rules
        policies/              # chat.policy.ts: domain-level authorization
      application/             # use cases (AskQuestion, ChatQueries, ReapAbandonedReservations) + ports
      repositories/            # repository interfaces (ports) + postgres/ implementations
      infrastructure/          # mock OpenAI client (adapter for the AI port)
      controllers/             # HTTP adapter: zod schemas, presenters, routes
    subscriptions/             # Module 2: subscription bundles and the billing simulation
      domain/{entities,services,policies}
      application/             # SubscriptionCommands, SubscriptionQueries, RunBillingCycle + payment port
      repositories/ infrastructure/ controllers/
    identity/                  # local user records (JIT from the IdP) + session binding store
    analytics/                 # admin metrics
  shared/
    domain/                    # shared kernel: typed errors, Actor and roles, clock, calendar math
    application/               # UnitOfWork, IdGenerator and pagination ports
    infrastructure/            # database, HTTP middleware, security, logging, background jobs
  config/env.ts                # environment parsing and validation (fail fast)
  container.ts                 # composition root (manual dependency injection)
  app.ts                       # HTTP pipeline assembly
  main.ts / migrate.ts         # entry points
```

- **The dependency rule is enforced by the linter**, not just by convention. `eslint.config.js`
  forbids `domain/**` from importing Express, Kysely, pg, jose, zod, pino or any outer layer, and
  forbids `application/**` from importing HTTP or SQL adapters. Business rules therefore run (and
  are unit tested) without a framework, a database or a network.
- **Entities protect their invariants.** `Subscription` owns its lifecycle (create, renew, expire,
  payment failure, cancel, auto-renew), and illegal transitions throw. `ChatMessage` only moves
  `pending -> completed | failed` and checks its token arithmetic. `Question` normalizes and
  bounds input.
- **Use cases depend on ports.** Repositories, the AI provider, the payment gateway, the clock and
  the id generator are interfaces; adapters are wired in `container.ts`. Tests swap the clock, the
  AI provider and the payment gateway; they never swap authentication.
- **Transactions through a Unit of Work port.** Use cases call `uow.run(repos => ...)` and get
  repositories bound to one database transaction (retried on serialization failures and
  deadlocks). The application layer never sees Kysely.
- **Modules are independent.** `chat/` sees subscriptions only through its own `BundleAllowance`
  value object (a view of "how many messages can this bundle still give"). Lifecycle rules live
  only in `subscriptions/`.
- **Kysely over an ORM:** precise control of locking (`FOR SHARE OF`, `SKIP LOCKED`, advisory
  locks), guarded atomic updates and data-modifying CTEs, while keeping type safety. Migrations
  are versioned TypeScript files applied with Kysely's locking migrator.
- **The database is the last line of defense.** CHECK constraints make over-consumption
  (`used <= max_messages`, `used <= free_limit`) and contradictory states (`status` vs
  `inactive_reason`, a renewal date without auto-renew) impossible even if application code had a
  bug. Foreign keys use `ON DELETE RESTRICT`, so history cannot be lost.

## Security model

### Authentication: external OIDC provider + proof-of-possession

```
client                        Identity provider (Keycloak / Auth0)              API
  |-- sign in (email+password, Google, GitHub) -->|                              |
  |   token request carries a DPoP proof          |                              |
  |<-- access token (iss, aud=ggi-api, exp, roles, cnf.jkt = key thumbprint) ---|
  |                                                                              |
  |-- Authorization: DPoP <token> ; DPoP: <proof signed with private key> ----->|
  |                                     1. token: signature via JWKS, iss, aud, exp, nbf,
  |                                        alg allowlist, max lifetime, not an ID token
  |                                     2. proof: signature, typ, htm, htu, iat window,
  |                                        ath = hash(token), jti never seen before
  |                                     3. binding: proof key == cnf.jkt
  |                                     4. session (sid + key) not revoked (logout)
  |<---------------------------------------- response / 401 + WWW-Authenticate: DPoP --|
```

- **Server-side token verification.** Keys come from the provider's JWKS, discovered from
  `/.well-known/openid-configuration` (the issuer must match) and cached with rotation and
  cooldown. Issuer, audience, expiry and not-before are enforced; only asymmetric algorithms are
  allowed (`none` and `HS*` are rejected when the config loads); tokens living longer than
  `OIDC_MAX_TOKEN_LIFETIME_SEC` and Keycloak ID/refresh tokens are refused.
- **A token alone is not enough.** Four mechanisms combine:
  - **Proof-of-possession (DPoP, RFC 9449):** each request carries a JWT signed by a private key
    that never leaves the client. The proof is bound to the HTTP method and URL (`htu` is checked
    against `PUBLIC_BASE_URL`, never the `Host` header) and to the exact token (`ath`).
  - **Timestamp and nonce validation:** proofs older than `DPOP_PROOF_MAX_AGE_SEC` (or from the
    future) are rejected, and every proof `jti` is stored in PostgreSQL until it expires, so a
    replayed proof fails on any API instance.
  - **Sender-constrained tokens:** by default (`DPOP_REQUIRE_BOUND_TOKENS=true`) the API only
    accepts tokens the IdP bound to the client's key (`cnf.jkt`, which Keycloak issues with DPoP
    enabled), and the proof key must match it. A stolen token is useless without the private key.
  - **Session-bound checks and revocation:** every token is tied to a server-side session (IdP
    session `sid` + key). `POST /auth/logout` revokes it, and every token of that session is
    rejected immediately (`SESSION_REVOKED`), before it expires. Other devices in the same SSO
    session keep their own sessions.
- For identity providers without DPoP support, `DPOP_REQUIRE_BOUND_TOKENS=false` is a
  compatibility mode: the API binds each IdP session to the first key that uses it, and a token
  used later with any other key gets `TOKEN_BINDING_MISMATCH`.
- Plain `Bearer` tokens are always rejected. Users are provisioned just-in-time from `(iss, sub)`.

**Why the API has no `/login` or `/register` endpoint.** Sign-up, email/password login and
Google/GitHub login all happen at the identity provider (authorization code + PKCE in a real
client; the CLI demo uses the password grant). The API never receives a password, which is what
"custom authentication implementations are not allowed" calls for, and every API route stays
behind a token. Credential brute-force protection therefore lives at the IdP (the Keycloak realm
locks an account after 5 failures), while the API's authentication endpoints (`/auth/me`,
`/auth/logout`) carry the strictest per-user limits.

### Authorization at two levels

- **Controller level:** every route group is gated by `requireRole(...)` (`/admin/**` needs
  `admin`; everything else needs `user` or `admin`).
- **Domain policy level:** `ChatPolicy`, `SubscriptionPolicy` and `AnalyticsPolicy` are evaluated
  inside the use cases that act on a specific resource or on system-wide data (asking, reading or
  changing a message or subscription, admin listings, billing, metrics). "My messages" and
  "my subscriptions" listings are scoped to the caller by construction. Other users' resources
  return 404 so ids cannot be probed; admins have system-wide access and analytics.
- Roles come only from the IdP (`OIDC_ROLES_CLAIM`, e.g. a flattened Keycloak realm-roles claim).
  Unknown role names are ignored, so a token cannot self-elevate.

### No open or bypassable endpoints

Every route, including `/api/v1/health` and unknown paths, sits behind the full authentication
pipeline; anonymous callers get `401` and learn nothing about routing. The only requests answered
without a token are genuine CORS preflights (`OPTIONS` with `Origin` and
`Access-Control-Request-Method`), which carry no data and are still rate limited. The
`endpoint()` wrapper also refuses to run a handler without an authenticated principal, as a
second guard against wiring mistakes. (Container liveness uses a TCP check; see the Dockerfile.)

### HTTP hardening

| Control             | Implementation                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secure headers      | helmet: CSP `default-src 'none'; frame-ancestors 'none'`, HSTS (1 year, preload), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CORP/COOP, `Cache-Control: no-store`, no `X-Powered-By` |
| Restricted CORS     | explicit origin allowlist (a wildcard is refused at startup), no credentials, fixed methods and headers; requests from other browser origins get `403 CORS_ORIGIN_DENIED`                                     |
| Request size limit  | `BODY_LIMIT_BYTES` (16 KiB) -> `413 PAYLOAD_TOO_LARGE`; compressed bodies are refused (no zip bombs)                                                                                                          |
| Strict content type | bodies only on POST/PATCH/PUT and only as `application/json` (UTF-8); otherwise `415` or `400 BODY_NOT_ALLOWED`                                                                                               |
| Global timeout      | `REQUEST_TIMEOUT_MS` -> structured `503 REQUEST_TIMEOUT`; the abort signal cancels the AI call, and a timed-out request is never charged (see below); socket-level `requestTimeout`/`headersTimeout` too      |
| Schema validation   | zod strict schemas on body, query and params; unknown fields and query parameters are rejected (no mass assignment); endpoints without a schema reject any body or query                                      |
| XSS                 | free text (questions, and AI output, which is untrusted too) is stripped of all markup; a literal `<` is stored HTML-escaped                                                                                  |
| Injection           | only parameterized SQL (Kysely); ids must be UUIDs; JSON `__proto__` keys are rejected as unknown fields; header values built from errors are reduced to printable ASCII                                      |
| Rate limiting       | see below                                                                                                                                                                                                     |
| Secrets in logs     | `Authorization`, `DPoP` and cookies are never logged (custom serializers + redaction)                                                                                                                         |

### Rate limiting

Fixed-window counters stored in PostgreSQL (an `UNLOGGED` table, so limits hold across API
instances behind a load balancer; an in-memory store exists for single-process use). The global
per-IP limit runs first, before CORS and authentication. Each route group then has its own
per-IP limit (still before authentication, so anonymous floods never reach token verification)
and a per-user limit right after authentication. IPv6 clients are grouped per `/64`.
`TRUST_PROXY` controls which proxy hops are trusted for the client address. Responses carry
`RateLimit-Limit/Remaining/Reset`, and `429`s carry `Retry-After` plus a typed error body.

| Policy        | Routes                    | Per IP / minute | Per user / minute | Variables                                      |
| ------------- | ------------------------- | --------------- | ----------------- | ---------------------------------------------- |
| global        | everything                | 600             |                   | `RL_GLOBAL_IP`                                 |
| auth          | `/api/v1/auth/*`          | 20              | 10                | `RL_AUTH_IP`, `RL_AUTH_USER`                   |
| chat          | `/api/v1/chat/*`          | 60              | 20                | `RL_CHAT_IP`, `RL_CHAT_USER`                   |
| subscriptions | `/api/v1/subscriptions/*` | 60              | 30                | `RL_SUBSCRIPTIONS_IP`, `RL_SUBSCRIPTIONS_USER` |
| admin         | `/api/v1/admin/*`         | 120             | 120               | `RL_ADMIN_IP`, `RL_ADMIN_USER`                 |
| system        | `/api/v1/health`          | 60              | 60                | `RL_SYSTEM_IP`, `RL_SYSTEM_USER`               |

### Errors and observability

All errors are JSON with a stable, typed code (`ErrorCode` union and `ErrorDetailsByCode` map in
`src/shared/domain/errors.ts`), mapped to HTTP status in one exhaustive table:

```json
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "Monthly free quota is used up and no active subscription bundle has messages left.",
    "details": {
      "period": "2026-10",
      "free": { "limit": 3, "used": 3, "remaining": 0, "resetsAt": "2026-11-01T00:00:00.000Z" },
      "bundles": { "active": 1, "withRemainingQuota": 0 }
    },
    "requestId": "6f0c2b8e-..."
  }
}
```

500 responses carry a generic message only, and the error handler cannot fall back to an HTML
error page. Every request is logged as one JSON line with `requestId` (taken from a safe
`X-Request-Id` or generated, and echoed back), `userId`, method, path, status and
`responseTimeMs`.

## Quota and billing design

### Atomic, concurrency-safe deduction

`POST /api/v1/chat/messages` uses a **reserve, call, settle** flow:

1. **Reserve (one short transaction).** Take the user's quota lock
   (`pg_advisory_xact_lock`, held until the transaction ends), so concurrent requests of one user
   are serialized while other users are unaffected. Active bundles are read `FOR SHARE`, so
   cancellation and billing cannot change them mid-decision. The pure domain service decides the
   source; one unit is deducted with a **guarded atomic update** (`... WHERE used < limit`),
   backed by CHECK constraints; the message is stored as `pending`.
2. **Call the AI provider outside any transaction.** No lock or pooled connection is held while
   waiting on the (simulated) OpenAI latency.
3. **Settle.** Success stores the answer, token usage and model. Failure, cancellation or a
   timeout marks the message `failed` and refunds the unit. Settling only succeeds while the
   message is still `pending`, so a unit is never refunded twice, and an answer that arrives
   after the client was told "timeout" is not charged. A background reaper refunds reservations
   orphaned by a crashed process.

The integration suite fires 25 concurrent requests at a user with 3 free messages and a Basic
bundle (10) and asserts exactly 13 successes, 12 `QUOTA_EXCEEDED`, and matching counters.

### Rules

- **Free quota first:** 3 messages per calendar month (UTC). Usage rows are keyed by month, so the
  quota resets automatically on the 1st with no cron job, and past months stay as history.
- **Then bundles:** deduct from the bundle with the latest remaining quota, i.e. the **most
  recently purchased** active bundle that still has messages in its current cycle; when it runs
  out, the next most recent one is used. Enterprise bundles are unlimited.
- **Per-cycle allowance:** a monthly bundle has the tier allowance (Basic 10, Pro 100) per month;
  a yearly bundle carries 12 months of it for the year (Basic 120, Pro 1,200). Usage is keyed by
  `(subscription, cycle start)`, so a renewal starts a fresh allowance while every past cycle's
  usage is preserved.
- **No quota:** `402 QUOTA_EXCEEDED` with the typed details shown above.

### Subscription lifecycle and billing simulation

- `POST /subscriptions` takes `tier` (`basic`, `pro`, `enterprise`), `billingCycle` (`monthly`,
  `yearly`) and `autoRenew`. Price, allowance, owner and dates are always derived server-side
  from the plan catalog. Each subscription has `maxMessages`, `price`, `startDate`, `endDate`,
  `renewalDate` and `status` (`active`/`inactive`, plus `inactiveReason`).
- The first cycle is charged at purchase. The charge, the subscription and its payment record
  share one transaction. A declined payment stores the subscription as `inactive`
  (`payment_failed`) with the failed payment for the audit trail and returns
  `402 PAYMENT_FAILED`.
- A background job (every `BILLING_INTERVAL_MS`, also `POST /admin/billing/run`) settles every
  active subscription whose cycle has ended. With auto-renew on, it charges and starts the next
  contiguous cycle, or marks the subscription inactive when the payment is declined (declines
  happen randomly at `PAYMENT_FAILURE_RATE`). With auto-renew off, the subscription expires.
  Each subscription is claimed with `FOR UPDATE SKIP LOCKED` in its own transaction, so several
  instances never bill twice, and charges carry idempotency keys.
- **Cancellation** ends the current billing cycle immediately, disables renewal, and keeps all
  history (usage rows, chat messages, payments). To stop at the end of the cycle instead, turn off
  auto-renew.

## API reference

Base path `/api/v1`. Every request needs `Authorization: DPoP <access token>` and a `DPoP` proof.

| Method | Path                         | Access       | Description                                         |
| ------ | ---------------------------- | ------------ | --------------------------------------------------- |
| GET    | `/auth/me`                   | user, admin  | Verified identity, roles and session binding        |
| POST   | `/auth/logout`               | user, admin  | Revoke the server-side session (all its tokens)     |
| POST   | `/chat/messages`             | user, admin  | Ask a question: `{ "question": "..." }`             |
| GET    | `/chat/messages`             | user, admin  | Own messages, newest first (`limit`, `cursor`)      |
| GET    | `/chat/messages/:id`         | owner, admin | One message                                         |
| GET    | `/chat/usage`                | user, admin  | Free quota, bundles, total remaining, next charge   |
| GET    | `/subscriptions/plans`       | user, admin  | Plan catalog                                        |
| POST   | `/subscriptions`             | user, admin  | Buy: `{ "tier", "billingCycle", "autoRenew"? }`     |
| GET    | `/subscriptions`             | user, admin  | Own subscriptions (`status`, `limit`, `cursor`)     |
| GET    | `/subscriptions/:id`         | owner, admin | One subscription with its current-cycle usage       |
| PATCH  | `/subscriptions/:id`         | owner, admin | `{ "autoRenew": true \| false }`                    |
| POST   | `/subscriptions/:id/cancel`  | owner, admin | Cancel                                              |
| GET    | `/admin/metrics`             | admin        | Users, usage, tokens, subscriptions, billing totals |
| GET    | `/admin/chat/messages`       | admin        | All messages (`userId`, `limit`, `cursor`)          |
| GET    | `/admin/users/:userId/usage` | admin        | Any user's quota                                    |
| GET    | `/admin/subscriptions`       | admin        | All subscriptions (`userId`, `status`, paging)      |
| POST   | `/admin/billing/run`         | admin        | Run the billing job now                             |
| GET    | `/health`                    | user, admin  | Liveness and database check                         |

Example `POST /api/v1/chat/messages` response (`201`):

```json
{
  "message": {
    "id": "4b0d0c55-...",
    "question": "What is DDD?",
    "answer": "This is a simulated answer to: \"What is DDD?\". ...",
    "status": "completed",
    "model": "gpt-4o-mini (mock)",
    "usage": { "promptTokens": 21, "completionTokens": 45, "totalTokens": 66 },
    "charge": {
      "source": "free",
      "subscriptionId": null,
      "periodStart": "2026-10-01T00:00:00.000Z"
    },
    "providerResponseId": "chatcmpl-mock-...",
    "requestId": "6f0c2b8e-...",
    "createdAt": "2026-10-06T08:24:51.217Z",
    "completedAt": "2026-10-06T08:24:51.828Z"
  },
  "quota": { "source": "free", "subscriptionId": null, "remainingInSource": 2 }
}
```

Error codes: `VALIDATION_FAILED` 400, `MALFORMED_JSON` 400, `BODY_NOT_ALLOWED` 400,
`UNAUTHENTICATED` / `INVALID_TOKEN` / `INVALID_DPOP_PROOF` / `DPOP_PROOF_REPLAYED` /
`TOKEN_BINDING_MISMATCH` / `SESSION_REVOKED` 401, `QUOTA_EXCEEDED` / `PAYMENT_FAILED` 402,
`FORBIDDEN` / `CORS_ORIGIN_DENIED` 403, `NOT_FOUND` / `ROUTE_NOT_FOUND` 404,
`SUBSCRIPTION_NOT_ACTIVE` 409, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415,
`RATE_LIMITED` 429, `INTERNAL_ERROR` 500, `AI_PROVIDER_UNAVAILABLE` 502,
`REQUEST_TIMEOUT` / `SERVICE_UNAVAILABLE` 503.

## Testing

| Suite                                  | Covers                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/chat/quota.service`         | free-first rule, latest-bundle selection and fallback, unlimited bundles, cycle windows, typed exhaustion details, monthly reset                                                      |
| `test/unit/subscriptions/*`            | full subscription lifecycle, illegal transitions, month-end and leap-year billing dates                                                                                               |
| `test/unit/domain/*`                   | domain policies, `Question` and `ChatMessage` invariants                                                                                                                              |
| `test/unit/security/*`                 | DPoP verifier: algorithms, htm/htu/ath/iat/typ/jti checks, private-key and signature tampering, replay                                                                                |
| `test/unit/infrastructure/*`           | sanitizer, mock OpenAI (latency, abort, failures), payment simulation, rate-limit store, IPv6 /64 grouping, config validation                                                         |
| `test/integration/auth`                | expired, foreign, forged and `alg=none` tokens, hostile token headers, missing or invalid proofs, replay, unbound and stolen tokens, per-device sessions, logout, RBAC at both levels |
| `test/integration/rate-limit`          | per-user and per-IP limits, different limits per endpoint group, limits before authentication, proxy-aware IPs, a shared Postgres store across two API instances                      |
| `test/integration/security-middleware` | headers, request ids, CORS, size limit, content types, compressed and malformed bodies, unknown fields, XSS, SQL injection, timeouts with refunds                                     |
| `test/integration/chat-quota`          | stored question/answer/tokens/metadata, 3 free per month, monthly reset, latest-bundle deduction, unlimited, 25-way concurrency, AI failure refund, crash reaper                      |
| `test/integration/subscriptions`       | catalog, purchase, mass assignment, payment failure, auto-renew toggle, cancellation with preserved history, renewal, renewal failure, expiry, admin-only billing                     |

**The authentication provider is mocked, not bypassed.** `test/support/mock-oidc-provider.ts` is
a real HTTP server serving OIDC discovery metadata and a JWKS, and it signs RS256 access tokens.
The API discovers and fetches its keys exactly as it does with Keycloak in production, and test
clients hold real DPoP key pairs. Integration tests run against a real PostgreSQL (embedded
binaries locally, a service container in CI), because row locks, constraints and transactions
are part of what is being tested.

## Configuration

All configuration comes from environment variables, validated at startup (`src/config/env.ts`);
the process refuses to start on invalid or unsafe values (for example `http` URLs or an in-memory
rate-limit store in production, symmetric JWT algorithms, or a `*` CORS origin). See
[`.env.example`](.env.example) for every variable and its default.

**Using Auth0 instead of Keycloak:** create an API with identifier `ggi-api`, enable the
Username-Password database connection and the Google social connection, add a post-login Action
that copies the user's roles into a namespaced claim, then set
`OIDC_ISSUER=https://<tenant>.auth0.com/` (trailing slash included, as Auth0 issues it),
`OIDC_AUDIENCE=ggi-api` and `OIDC_ROLES_CLAIM=https://<your-namespace>/roles`. If DPoP-bound
tokens are not enabled on the tenant, also set `DPOP_REQUIRE_BOUND_TOKENS=false`.

## Assumptions and interpretations

1. Calendar months and billing dates are evaluated in UTC; the free quota resets at
   `00:00 UTC` on the 1st.
2. The free quota is always consumed before any bundle.
3. "The bundle with the latest remaining quota" means the most recently purchased active bundle
   that still has messages left in its current cycle (then the next most recent one). The rule
   lives in one function, `selectBundleForDeduction`.
4. Tier allowances (Basic 10, Pro 100, Enterprise unlimited) are per month. `maxMessages` is the
   allowance of one billing cycle, so a yearly bundle carries 12 months of allowance and is priced
   as 10 months. Prices are illustrative and stored in integer cents.
5. Cancellation ends the current cycle immediately (the brief: "Ends the current billing cycle");
   stopping at the end of the cycle is what disabling auto-renew does.
6. The initial purchase is charged too; failed AI calls and timeouts are never charged.
7. Every authenticated identity is at least a `user`; `admin` must come from the IdP.
8. "No open endpoints" includes the health check, which is therefore authenticated.
9. The OpenAI response is mocked (canned answer, about 4 characters per token, configurable latency
   and failure rate). Using the real API only means implementing `AiCompletionPort`.
10. Text is sanitized on input, so stored text is HTML-safe; clients should render it as text.
11. The Keycloak realm includes demo accounts and enables the password grant on the public client
    so the CLI demo works; a real deployment would use authorization code + PKCE only.

## Trade-offs and next steps

- **Payments:** the simulated gateway is called inside the purchase and renewal transactions for
  clarity. With a real payment provider this becomes an outbox plus webhook confirmation (charges
  already carry idempotency keys).
- **Rate limiting** uses PostgreSQL to avoid extra infrastructure; at high traffic it would move to
  Redis (the store is an interface).
- **DPoP server nonces** (`DPoP-Nonce`) would further tighten proof freshness.
- An `Idempotency-Key` header on `POST /subscriptions`, an OpenAPI document, OpenTelemetry
  tracing, Prometheus-format metrics, and archiving or partitioning of `chat_messages`.
