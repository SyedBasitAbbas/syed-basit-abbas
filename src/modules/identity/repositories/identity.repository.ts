export interface ExternalIdentity {
  issuer: string;
  subject: string;
  email: string | null;
}

/** Maps an identity from the external IdP to the local user record (JIT provisioning). */
export interface UserRepository {
  ensureUser(identity: ExternalIdentity): Promise<{ id: string }>;
}

export type BindingSource = 'cnf' | 'first_use';

export type SessionBindingOutcome =
  | { status: 'bound'; expiresAt: Date }
  | { status: 'key_mismatch' }
  | { status: 'owner_mismatch' }
  | { status: 'revoked' };

/**
 * Server-side record that ties an IdP session (or a single token) to one DPoP key.
 * It is what makes a stolen access token useless without the private key, and
 * what lets logout revoke a token before it expires.
 */
export interface AuthSessionRepository {
  bind(input: {
    sessionKey: string;
    userId: string;
    jkt: string;
    source: BindingSource;
    expiresAt: Date;
  }): Promise<SessionBindingOutcome>;
  revoke(sessionKey: string, now: Date): Promise<boolean>;
}
