import { describe, expect, it } from 'vitest';
import {
  DpopProofVerifier,
  normalizeHtu,
} from '../../../src/shared/infrastructure/security/dpop-proof-verifier.js';
import { InMemoryReplayCache } from '../../../src/shared/infrastructure/security/replay-cache.js';
import { AppError } from '../../../src/shared/domain/errors.js';
import { DpopKey } from '../../support/dpop.js';

const URL_ = 'https://api.example.com/api/v1/chat/messages';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';

function verifier() {
  return new DpopProofVerifier({
    algorithms: ['ES256', 'EdDSA', 'RS256', 'PS256'],
    maxAgeSec: 60,
    clockSkewSec: 5,
    replayCache: new InMemoryReplayCache(),
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof AppError ? error.code : 'UNEXPECTED';
  }
}

describe('DpopProofVerifier', () => {
  it.each(['ES256', 'EdDSA', 'RS256'] as const)(
    'accepts a valid %s proof and returns the key thumbprint',
    async (alg) => {
      const key = await DpopKey.generate(alg);
      const proof = await key.proof({ method: 'POST', url: URL_, accessToken: TOKEN });
      const result = await verifier().verify(proof, {
        method: 'POST',
        url: URL_,
        accessToken: TOKEN,
        now: new Date(),
      });
      expect(result.jkt).toBe(key.jkt);
    },
  );

  it('ignores query strings when matching htu', async () => {
    const key = await DpopKey.generate();
    const proof = await key.proof({ method: 'GET', url: URL_, accessToken: TOKEN });
    const result = verifier().verify(proof, {
      method: 'GET',
      url: `${URL_}?limit=5`,
      accessToken: TOKEN,
      now: new Date(),
    });
    await expect(result).resolves.toBeTruthy();
  });

  it('rejects mismatched method, url, token hash, age, typ and missing jti', async () => {
    const key = await DpopKey.generate();
    const now = new Date();
    const ctx = { method: 'POST', url: URL_, accessToken: TOKEN, now };
    const v = verifier();
    expect(
      await codeOf(
        v.verify(await key.proof({ method: 'GET', url: URL_, accessToken: TOKEN }), ctx),
      ),
    ).toBe('INVALID_DPOP_PROOF');
    expect(
      await codeOf(
        v.verify(await key.proof({ method: 'POST', url: `${URL_}/x`, accessToken: TOKEN }), ctx),
      ),
    ).toBe('INVALID_DPOP_PROOF');
    expect(
      await codeOf(
        v.verify(await key.proof({ method: 'POST', url: URL_, accessToken: 'other' }), ctx),
      ),
    ).toBe('INVALID_DPOP_PROOF');
    expect(
      await codeOf(
        v.verify(
          await key.proof({
            method: 'POST',
            url: URL_,
            accessToken: TOKEN,
            iat: Math.floor(now.getTime() / 1000) - 120,
          }),
          ctx,
        ),
      ),
    ).toBe('INVALID_DPOP_PROOF');
    expect(
      await codeOf(
        v.verify(
          await key.proof({
            method: 'POST',
            url: URL_,
            accessToken: TOKEN,
            iat: Math.floor(now.getTime() / 1000) + 120,
          }),
          ctx,
        ),
      ),
    ).toBe('INVALID_DPOP_PROOF');
    expect(
      await codeOf(
        v.verify(
          await key.proof({ method: 'POST', url: URL_, accessToken: TOKEN, typ: 'jwt' }),
          ctx,
        ),
      ),
    ).toBe('INVALID_DPOP_PROOF');
    expect(
      await codeOf(
        v.verify(
          await key.proof({ method: 'POST', url: URL_, accessToken: TOKEN, jti: 'short' }),
          ctx,
        ),
      ),
    ).toBe('INVALID_DPOP_PROOF');
    expect(await codeOf(v.verify('not-a-jwt', ctx))).toBe('INVALID_DPOP_PROOF');
  });

  it('rejects a proof carrying a private key', async () => {
    const key = await DpopKey.generate();
    const proof = await key.proof({
      method: 'POST',
      url: URL_,
      accessToken: TOKEN,
      leakPrivateKey: true,
    });
    expect(
      await codeOf(
        verifier().verify(proof, {
          method: 'POST',
          url: URL_,
          accessToken: TOKEN,
          now: new Date(),
        }),
      ),
    ).toBe('INVALID_DPOP_PROOF');
  });

  it('rejects a tampered signature', async () => {
    const key = await DpopKey.generate();
    const proof = await key.proof({ method: 'POST', url: URL_, accessToken: TOKEN });
    const [h, p] = proof.split('.');
    const other = await (
      await DpopKey.generate()
    ).proof({ method: 'POST', url: URL_, accessToken: TOKEN });
    const forged = `${h}.${p}.${other.split('.')[2]}`;
    expect(
      await codeOf(
        verifier().verify(forged, {
          method: 'POST',
          url: URL_,
          accessToken: TOKEN,
          now: new Date(),
        }),
      ),
    ).toBe('INVALID_DPOP_PROOF');
  });

  it('rejects replays of the same proof', async () => {
    const key = await DpopKey.generate();
    const v = verifier();
    const ctx = { method: 'POST', url: URL_, accessToken: TOKEN, now: new Date() };
    const proof = await key.proof({ method: 'POST', url: URL_, accessToken: TOKEN });
    await v.verify(proof, ctx);
    expect(await codeOf(v.verify(proof, ctx))).toBe('DPOP_PROOF_REPLAYED');
  });

  it('normalizes htu per RFC 9449', () => {
    expect(normalizeHtu('HTTPS://API.Example.com/a/b?x=1#frag')).toBe(
      'https://api.example.com/a/b',
    );
    expect(normalizeHtu('ftp://example.com/a')).toBeNull();
    expect(normalizeHtu('not a url')).toBeNull();
  });
});
