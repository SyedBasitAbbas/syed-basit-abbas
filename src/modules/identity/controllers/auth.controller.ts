import { Router } from 'express';
import type { Clock } from '../../../shared/domain/clock.js';
import { endpoint } from '../../../shared/infrastructure/http/endpoint.js';
import type { AuthSessionRepository } from '../repositories/identity.repository.js';

/**
 * Authentication endpoints. Sign-up, password login and social login happen at
 * the external identity provider (no custom auth code here); these endpoints
 * expose the verified identity and manage the server-side session binding.
 */
export function authRoutes(deps: { sessions: AuthSessionRepository; clock: Clock }): Router {
  const router = Router();

  router.get(
    '/me',
    endpoint({}, ({ auth }) =>
      Promise.resolve({
        status: 200,
        body: {
          user: {
            id: auth.actor.userId,
            email: auth.claims.email,
            roles: [...auth.actor.roles],
          },
          identity: { issuer: auth.claims.issuer, subject: auth.claims.subject },
          session: {
            binding: auth.bindingSource,
            dpopKeyThumbprint: auth.jkt,
            tokenExpiresAt: auth.claims.expiresAt.toISOString(),
            sessionExpiresAt: auth.sessionExpiresAt.toISOString(),
          },
        },
      }),
    ),
  );

  // Revokes the server-side session: every token of this IdP session stops
  // working immediately, even before it expires.
  router.post(
    '/logout',
    endpoint({}, async ({ auth }) => {
      await deps.sessions.revoke(auth.sessionKey, deps.clock.now());
      return { status: 204 };
    }),
  );

  return router;
}
