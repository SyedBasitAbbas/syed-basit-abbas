import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { Actor, type Role } from '../../domain/actor.js';
import type { Clock } from '../../domain/clock.js';
import { AppError, ForbiddenError } from '../../domain/errors.js';
import type {
  AuthSessionRepository,
  BindingSource,
  UserRepository,
} from '../../../modules/identity/repositories/identity.repository.js';
import type { DpopProofVerifier } from './dpop-proof-verifier.js';
import type { AccessTokenClaims, AccessTokenVerifier } from './oidc-token-verifier.js';

export interface AuthContext {
  actor: Actor;
  claims: AccessTokenClaims;
  sessionKey: string;
  jkt: string;
  bindingSource: BindingSource;
  sessionExpiresAt: Date;
}

export interface AuthenticateDependencies {
  tokens: AccessTokenVerifier;
  dpop: DpopProofVerifier;
  users: UserRepository;
  sessions: AuthSessionRepository;
  clock: Clock;
  publicBaseUrl: string;
  requireBoundTokens: boolean;
}

const MAX_TOKEN_LENGTH = 8_192;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Server-side session a token belongs to: the IdP session (`sid`) if known, else
 * the token itself. IdP-bound tokens also include their key, so every client
 * (device, tab, app) in one SSO session gets its own binding and its own logout.
 */
export function deriveSessionKey(claims: AccessTokenClaims, token: string): string {
  const scope = claims.sessionId
    ? `sid:${claims.sessionId}`
    : claims.tokenId
      ? `jti:${claims.tokenId}`
      : `tok:${createHash('sha256').update(token).digest('hex')}`;
  const key = claims.confirmationJkt ? `|jkt:${claims.confirmationJkt}` : '';
  return createHash('sha256').update(`${claims.issuer}|${scope}${key}`).digest('hex');
}

function requestUrl(req: Request, publicBaseUrl: string): string {
  const path = req.originalUrl.split('?')[0] ?? '/';
  return `${publicBaseUrl}${path}`;
}

/**
 * Authentication pipeline. A request is only authenticated when ALL of these hold:
 * 1. `Authorization: DPoP <jwt>` carries an access token from the configured IdP
 *    (signature via JWKS, issuer, audience, expiry, algorithm allowlist);
 * 2. a fresh, never-seen DPoP proof signed by the client's private key is bound to
 *    this method, URL and token (possession of the token alone is not enough);
 * 3. the proof key matches the token's `cnf.jkt` (IdP-bound DPoP) and/or the key
 *    the server bound to this IdP session on first use;
 * 4. that server-side session has not been revoked (logout).
 */
export function authenticate(deps: AuthenticateDependencies): RequestHandler {
  return async (req, res, next) => {
    // Already authenticated earlier in this request (e.g. router fall-through):
    // re-verifying would wrongly flag the same DPoP proof as a replay.
    if (res.locals.auth) {
      next();
      return;
    }
    const authorization = req.headers.authorization;
    if (!authorization) {
      throw new AppError(
        'UNAUTHENTICATED',
        'Authentication required: send "Authorization: DPoP <access token>" and a DPoP proof.',
      );
    }
    const match = /^(\S+) (\S+)$/.exec(authorization);
    if (!match?.[1] || !match[2])
      throw new AppError('INVALID_TOKEN', 'Malformed Authorization header.');
    const [, scheme, token] = match;
    if (scheme.toLowerCase() !== 'dpop') {
      throw new AppError(
        'INVALID_TOKEN',
        'Bearer tokens are not accepted: access tokens must be sender-constrained with DPoP (RFC 9449).',
      );
    }
    if (token.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(token)) {
      throw new AppError('INVALID_TOKEN', 'Access token is not a valid JWT.');
    }
    const proof = req.headers.dpop;
    if (typeof proof !== 'string' || proof.length === 0) {
      throw new AppError('INVALID_DPOP_PROOF', 'Missing DPoP proof header.');
    }

    const claims = await deps.tokens.verify(token);
    const verifiedProof = await deps.dpop.verify(proof, {
      method: req.method,
      url: requestUrl(req, deps.publicBaseUrl),
      accessToken: token,
      now: deps.clock.now(),
    });

    if (claims.confirmationJkt !== null && claims.confirmationJkt !== verifiedProof.jkt) {
      throw new AppError(
        'TOKEN_BINDING_MISMATCH',
        'DPoP key does not match the key the token is bound to.',
      );
    }
    if (claims.confirmationJkt === null && deps.requireBoundTokens) {
      throw new AppError('INVALID_TOKEN', 'Access token is not DPoP-bound (missing cnf.jkt).');
    }

    const user = await deps.users.ensureUser({
      issuer: claims.issuer,
      subject: claims.subject,
      email: claims.email,
    });
    const sessionKey = deriveSessionKey(claims, token);
    const bindingSource: BindingSource = claims.confirmationJkt !== null ? 'cnf' : 'first_use';
    const binding = await deps.sessions.bind({
      sessionKey,
      userId: user.id,
      jkt: verifiedProof.jkt,
      source: bindingSource,
      expiresAt: claims.expiresAt,
    });
    switch (binding.status) {
      case 'revoked':
        throw new AppError('SESSION_REVOKED', 'This session was signed out. Sign in again.');
      case 'key_mismatch':
        throw new AppError(
          'TOKEN_BINDING_MISMATCH',
          'This session is bound to a different DPoP key.',
        );
      case 'owner_mismatch':
        throw new AppError('INVALID_TOKEN', 'Session does not belong to this subject.');
      case 'bound':
        break;
    }

    res.locals.auth = {
      actor: Actor.of(user.id, claims.roles),
      claims,
      sessionKey,
      jkt: verifiedProof.jkt,
      bindingSource,
      sessionExpiresAt: binding.expiresAt,
    };
    next();
  };
}

/** Controller-level role gate. Domain policies re-check inside every use case. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (_req, res, next) => {
    const auth = res.locals.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', 'Authentication required.');
    if (!roles.some((role) => auth.actor.hasRole(role))) {
      throw new ForbiddenError(`This endpoint requires one of the roles: ${roles.join(', ')}.`);
    }
    next();
  };
}
