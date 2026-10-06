import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { isRole, type Role } from '../../domain/actor.js';
import { AppError } from '../../domain/errors.js';

export interface AccessTokenClaims {
  issuer: string;
  subject: string;
  roles: Role[];
  email: string | null;
  /** IdP session id (`sid`), when the provider includes it. */
  sessionId: string | null;
  tokenId: string | null;
  issuedAt: Date;
  expiresAt: Date;
  /** DPoP key thumbprint the IdP bound the token to (`cnf.jkt`), if any. */
  confirmationJkt: string | null;
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  jwksUri?: string | undefined;
  algorithms: string[];
  rolesClaim: string;
  clockToleranceSec: number;
  maxTokenLifetimeSec: number;
  fetchTimeoutMs?: number;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}

const ACCEPTED_TOKEN_TYPES = new Set(['at+jwt', 'application/at+jwt', 'jwt']);

function invalidToken(message: string, cause?: unknown): AppError<'INVALID_TOKEN'> {
  return new AppError('INVALID_TOKEN', message, undefined, { cause });
}

/**
 * Verifies OAuth2/OIDC access tokens issued by the external identity provider.
 * Signature keys come from the provider's JWKS (discovered from the issuer
 * metadata and cached with rotation support); issuer, audience, expiry,
 * not-before and the algorithm allowlist are all enforced.
 */
export class OidcAccessTokenVerifier implements AccessTokenVerifier {
  private keySet: Promise<JWTVerifyGetKey> | null = null;

  constructor(private readonly options: OidcVerifierOptions) {}

  async verify(token: string): Promise<AccessTokenClaims> {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch (error) {
      throw invalidToken('Access token is not a valid JWT.', error);
    }
    if (header.typ !== undefined && !ACCEPTED_TOKEN_TYPES.has(header.typ.toLowerCase())) {
      throw invalidToken('Access token has an unexpected type (typ header).');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await this.getKeySet(), {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.options.algorithms,
        clockTolerance: this.options.clockToleranceSec,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (error) {
      throw this.mapVerificationError(error);
    }

    // Reject ID or refresh tokens minted by the same issuer (Keycloak marks them in `typ`).
    if (payload.typ === 'ID' || payload.typ === 'Refresh') {
      throw invalidToken('An ID or refresh token was presented instead of an access token.');
    }

    const issuedAt = payload.iat ?? 0;
    const expiresAt = payload.exp ?? 0;
    if (expiresAt - issuedAt > this.options.maxTokenLifetimeSec) {
      throw invalidToken('Access token lifetime exceeds the allowed maximum.');
    }

    const cnf = payload.cnf as { jkt?: unknown } | undefined;
    return {
      issuer: payload.iss ?? this.options.issuer,
      subject: payload.sub ?? '',
      roles: this.extractRoles(payload),
      email: typeof payload.email === 'string' ? payload.email : null,
      sessionId: typeof payload.sid === 'string' ? payload.sid : null,
      tokenId: payload.jti ?? null,
      issuedAt: new Date(issuedAt * 1000),
      expiresAt: new Date(expiresAt * 1000),
      confirmationJkt: typeof cnf?.jkt === 'string' ? cnf.jkt : null,
    };
  }

  private getKeySet(): Promise<JWTVerifyGetKey> {
    if (!this.keySet) {
      this.keySet = this.resolveJwksUri().then((uri) =>
        createRemoteJWKSet(new URL(uri), {
          timeoutDuration: this.options.fetchTimeoutMs ?? 3_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
        }),
      );
      // A failed discovery must not be cached forever.
      this.keySet.catch(() => {
        this.keySet = null;
      });
    }
    return this.keySet;
  }

  private async resolveJwksUri(): Promise<string> {
    if (this.options.jwksUri) return this.options.jwksUri;
    const url = `${this.options.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.options.fetchTimeoutMs ?? 3_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}`);
    const metadata = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
    if (metadata.issuer !== this.options.issuer) {
      throw new Error('OIDC discovery returned a different issuer');
    }
    if (typeof metadata.jwks_uri !== 'string') throw new Error('OIDC discovery has no jwks_uri');
    return metadata.jwks_uri;
  }

  private mapVerificationError(error: unknown): AppError {
    if (error instanceof joseErrors.JWTExpired)
      return invalidToken('Access token has expired.', error);
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      return invalidToken(`Access token claim "${error.claim}" is invalid.`, error);
    }
    if (
      error instanceof joseErrors.JWKSNoMatchingKey ||
      error instanceof joseErrors.JWSSignatureVerificationFailed ||
      error instanceof joseErrors.JOSEAlgNotAllowed ||
      error instanceof joseErrors.JWSInvalid ||
      error instanceof joseErrors.JWTInvalid ||
      error instanceof joseErrors.JOSENotSupported
    ) {
      return invalidToken('Access token signature or format is invalid.', error);
    }
    // JWKS endpoint unreachable, discovery failure, timeouts: not the caller's fault.
    return new AppError(
      'SERVICE_UNAVAILABLE',
      'Identity provider keys are temporarily unavailable.',
      undefined,
      { cause: error },
    );
  }

  private extractRoles(payload: JWTPayload): Role[] {
    const claim = this.options.rolesClaim;
    let value: unknown = payload[claim];
    if (value === undefined && claim.includes('.')) {
      value = claim.split('.').reduce<unknown>((node, key) => {
        return typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined;
      }, payload);
    }
    const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(' ') : [];
    const roles = [...new Set(raw.filter(isRole))];
    // Every authenticated identity of this audience is at least a regular user;
    // elevated roles only ever come from the IdP.
    return roles.length > 0 ? roles : ['user'];
  }
}
