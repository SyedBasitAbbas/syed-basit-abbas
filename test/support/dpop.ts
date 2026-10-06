import { createHash, randomBytes } from 'node:crypto';
import {
  base64url,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';

export interface ProofOptions {
  method: string;
  url: string;
  accessToken?: string;
  iat?: number;
  jti?: string;
  typ?: string;
  /** Embed the private key in the header (must be rejected). */
  leakPrivateKey?: boolean;
  ath?: string;
  /** Server-provided DPoP nonce, when the authorization server demands one. */
  nonce?: string;
}

/** A client-held DPoP key pair, as a browser or mobile app would keep it. */
export class DpopKey {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly privateJwk: JWK,
    readonly publicJwk: JWK,
    readonly jkt: string,
    readonly alg: string,
  ) {}

  static async generate(alg: 'ES256' | 'RS256' | 'EdDSA' = 'ES256'): Promise<DpopKey> {
    const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    return new DpopKey(
      privateKey,
      privateJwk,
      publicJwk,
      await calculateJwkThumbprint(publicJwk),
      alg,
    );
  }

  async proof(options: ProofOptions): Promise<string> {
    const payload: Record<string, unknown> = {
      htm: options.method,
      htu: options.url,
      jti: options.jti ?? randomBytes(16).toString('base64url'),
      iat: options.iat ?? Math.floor(Date.now() / 1000),
    };
    if (options.nonce !== undefined) payload.nonce = options.nonce;
    if (options.ath !== undefined) payload.ath = options.ath;
    else if (options.accessToken !== undefined) {
      payload.ath = base64url.encode(createHash('sha256').update(options.accessToken).digest());
    }
    return new SignJWT(payload)
      .setProtectedHeader({
        alg: this.alg,
        typ: options.typ ?? 'dpop+jwt',
        jwk: options.leakPrivateKey ? this.privateJwk : this.publicJwk,
      })
      .sign(this.privateKey);
  }
}
