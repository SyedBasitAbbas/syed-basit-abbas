import { createHash } from 'node:crypto';
import {
  base64url,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  EmbeddedJWK,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { AppError } from '../../domain/errors.js';

/** Remembers DPoP proof ids until they expire; returns false for a replay. */
export interface ReplayCache {
  markUsed(key: string, expiresAt: Date): Promise<boolean>;
}

export interface DpopVerifierOptions {
  algorithms: string[];
  maxAgeSec: number;
  clockSkewSec: number;
  replayCache: ReplayCache;
}

export interface DpopRequestContext {
  method: string;
  /** Absolute URL of the request as the client addressed it (no query/fragment needed). */
  url: string;
  accessToken: string;
  now: Date;
}

export interface VerifiedDpopProof {
  jkt: string;
  jti: string;
  issuedAt: Date;
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

function invalidProof(message: string, cause?: unknown): AppError<'INVALID_DPOP_PROOF'> {
  return new AppError('INVALID_DPOP_PROOF', message, undefined, { cause });
}

export function sha256Base64Url(value: string): string {
  return base64url.encode(createHash('sha256').update(value).digest());
}

/** Normalizes an http(s) URL to scheme://host[:port]/path as RFC 9449 compares it. */
export function normalizeHtu(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * DPoP (RFC 9449) proof verification: the client signs every request with a
 * private key it never sends. A proof is only accepted when its signature is
 * valid for the embedded public key, it is bound to this exact method and URL,
 * it is fresh (`iat`), it hashes this exact access token (`ath`), and its `jti`
 * has not been seen before (replay protection).
 */
export class DpopProofVerifier {
  constructor(private readonly options: DpopVerifierOptions) {}

  async verify(proof: string, context: DpopRequestContext): Promise<VerifiedDpopProof> {
    if (proof.length > 4_096 || !JWT_SHAPE.test(proof)) {
      throw invalidProof('DPoP proof is not a compact JWS.');
    }

    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(proof);
    } catch (error) {
      throw invalidProof('DPoP proof header is malformed.', error);
    }
    if (header.typ !== 'dpop+jwt') throw invalidProof('DPoP proof must have typ "dpop+jwt".');
    if (!header.alg || !this.options.algorithms.includes(header.alg)) {
      throw invalidProof('DPoP proof uses an unsupported algorithm.');
    }
    const jwk = header.jwk;
    if (!jwk || typeof jwk !== 'object') throw invalidProof('DPoP proof must embed a public JWK.');
    if (PRIVATE_JWK_MEMBERS.some((member) => member in jwk)) {
      throw invalidProof('DPoP proof JWK must be a public key.');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(proof, EmbeddedJWK, {
        typ: 'dpop+jwt',
        algorithms: this.options.algorithms,
      }));
    } catch (error) {
      throw invalidProof('DPoP proof signature is invalid.', error);
    }

    const { jti, htm, htu, iat, ath } = payload as JWTPayload & {
      htm?: unknown;
      htu?: unknown;
      ath?: unknown;
    };
    if (typeof jti !== 'string' || jti.length < 16 || jti.length > 256) {
      throw invalidProof('DPoP proof must carry a unique jti (16 to 256 characters).');
    }
    if (htm !== context.method)
      throw invalidProof('DPoP proof htm does not match the request method.');
    const expectedHtu = normalizeHtu(context.url);
    if (typeof htu !== 'string' || expectedHtu === null || normalizeHtu(htu) !== expectedHtu) {
      throw invalidProof('DPoP proof htu does not match the request URL.');
    }
    if (typeof iat !== 'number') throw invalidProof('DPoP proof must carry iat.');
    const nowSec = context.now.getTime() / 1000;
    if (iat > nowSec + this.options.clockSkewSec)
      throw invalidProof('DPoP proof is issued in the future.');
    if (nowSec - iat > this.options.maxAgeSec) throw invalidProof('DPoP proof is too old.');
    if (ath !== sha256Base64Url(context.accessToken)) {
      throw invalidProof('DPoP proof ath does not match the access token.');
    }

    const jkt = await calculateJwkThumbprint(jwk, 'sha256');
    const replayKey = createHash('sha256').update(`${jkt}:${jti}`).digest('hex');
    const fresh = await this.options.replayCache.markUsed(
      replayKey,
      new Date((iat + this.options.maxAgeSec + this.options.clockSkewSec) * 1000),
    );
    if (!fresh) {
      throw new AppError('DPOP_PROOF_REPLAYED', 'This DPoP proof was already used.');
    }
    return { jkt, jti, issuedAt: new Date(iat * 1000) };
  }
}
