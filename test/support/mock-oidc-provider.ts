import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

export interface TokenOptions {
  sub?: string;
  roles?: string[];
  email?: string;
  /** IdP session id; `null` omits the claim. */
  sid?: string | null;
  jti?: string;
  /** Bind the token to a DPoP key (`cnf.jkt`), as a DPoP-enabled IdP does. */
  cnfJkt?: string;
  expiresInSec?: number;
  issuedAt?: number;
  issuer?: string;
  audience?: string | string[];
  typ?: string;
  extraClaims?: Record<string, unknown>;
  /** Sign with a key that is NOT published in the JWKS (forged token). */
  signWithUntrustedKey?: boolean;
}

/**
 * Test double for the external OAuth2/OIDC provider (Keycloak, Auth0, ...).
 * It serves real discovery metadata and a JWKS over HTTP, and signs RS256
 * access tokens, so the API exercises its production verification path
 * (discovery -> JWKS fetch -> signature/claims checks) end to end.
 */
export class MockOidcProvider {
  jwksRequests = 0;

  private constructor(
    readonly issuer: string,
    readonly audience: string,
    private readonly server: http.Server,
    private readonly signingKey: CryptoKey,
    private readonly untrustedKey: CryptoKey,
    private readonly kid: string,
  ) {}

  static async start(options: { audience?: string } = {}): Promise<MockOidcProvider> {
    const audience = options.audience ?? 'ggi-api';
    const trusted = await generateKeyPair('RS256', { extractable: true });
    const untrusted = await generateKeyPair('RS256', { extractable: true });
    const kid = randomUUID();
    const jwk = { ...(await exportJWK(trusted.publicKey)), kid, alg: 'RS256', use: 'sig' };

    let provider: MockOidcProvider | null = null;
    const server = http.createServer((req, res) => {
      const issuer = provider?.issuer ?? '';
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/openid-configuration') {
        res.end(
          JSON.stringify({
            issuer,
            jwks_uri: `${issuer}/protocol/openid-connect/certs`,
            authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
            token_endpoint: `${issuer}/protocol/openid-connect/token`,
            dpop_signing_alg_values_supported: ['ES256', 'RS256', 'PS256', 'EdDSA'],
          }),
        );
        return;
      }
      if (req.url === '/protocol/openid-connect/certs') {
        if (provider) provider.jwksRequests += 1;
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    provider = new MockOidcProvider(
      `http://127.0.0.1:${port}`,
      audience,
      server,
      trusted.privateKey,
      untrusted.privateKey,
      kid,
    );
    return provider;
  }

  async issueAccessToken(options: TokenOptions = {}): Promise<string> {
    const now = options.issuedAt ?? Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      roles: options.roles ?? ['user'],
      email: options.email ?? 'someone@example.com',
      azp: 'ggi-web',
      ...options.extraClaims,
    };
    if (options.sid !== null) claims.sid = options.sid ?? randomUUID();
    if (options.cnfJkt) claims.cnf = { jkt: options.cnfJkt };
    if (options.typ) claims.typ = options.typ;

    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid, typ: 'at+jwt' })
      .setIssuer(options.issuer ?? this.issuer)
      .setAudience(options.audience ?? this.audience)
      .setSubject(options.sub ?? randomUUID())
      .setJti(options.jti ?? randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + (options.expiresInSec ?? 300))
      .sign(options.signWithUntrustedKey ? this.untrustedKey : this.signingKey);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
