import {
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  SignJWT,
} from 'jose';
import {describe, expect, it} from 'vitest';

import {SignInError, verifyIdToken} from './oauth.js';

// reference: INTERFACES.md API-41 · a separate change (!110 review: pin RS256 on its own)

const ISSUER = 'https://example.test/oauth2/default';
const CLIENT_ID = 'synthetic-client';
const NONCE = 'synthetic-nonce';
const KID = 'test-signing-key';
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const IAT = Math.floor(NOW / 1000);

interface Fixture {
  keys: ReturnType<typeof createLocalJWKSet>;
  sign: (alg: 'RS256' | 'PS256' | 'HS256') => Promise<string>;
}

async function fixture(): Promise<Fixture> {
  const trusted = await generateKeyPair('RS256', {extractable: true});
  const publicJwk = {
    ...(await exportJWK(trusted.publicKey)),
    kid: KID,
    use: 'sig',
  };
  const keys = createLocalJWKSet({keys: [publicJwk]});
  const ps256Key = await importPKCS8(
    await exportPKCS8(trusted.privateKey),
    'PS256',
  );
  const hsSecret = new TextEncoder().encode(
    'synthetic-shared-secret-32-bytes!!',
  );

  async function sign(alg: 'RS256' | 'PS256' | 'HS256'): Promise<string> {
    const claims = {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'synthetic-subject',
      iat: IAT,
      exp: IAT + 3600,
      nonce: NONCE,
    };
    const header = {alg, kid: KID};
    if (alg === 'HS256') {
      return new SignJWT(claims).setProtectedHeader(header).sign(hsSecret);
    }
    const key = alg === 'PS256' ? ps256Key : trusted.privateKey;
    return new SignJWT(claims).setProtectedHeader(header).sign(key);
  }

  return {keys, sign};
}

describe('given verifyIdToken validates the sign-in id_token', () => {
  it('when the token is RS256 and every claim matches, then identity is returned', async () => {
    const {keys, sign} = await fixture();
    const idToken = await sign('RS256');

    await expect(
      verifyIdToken(idToken, keys, {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        nonce: NONCE,
        now: NOW,
      }),
    ).resolves.toEqual({
      subject: 'synthetic-subject',
      fhirUser: undefined,
    });
  });

  it.each([
    ['PS256', 'PS256' as const],
    ['HS256', 'HS256' as const],
  ])(
    'when the algorithm is %s, then sign-in is refused (only RS256 is allowed)',
    async (_label, alg) => {
      const {keys, sign} = await fixture();
      const idToken = await sign(alg);

      await expect(
        verifyIdToken(idToken, keys, {
          issuer: ISSUER,
          clientId: CLIENT_ID,
          nonce: NONCE,
          now: NOW,
        }),
      ).rejects.toMatchObject({
        name: 'SignInError',
        reason: 'id_token_invalid',
        outcome: 'failed',
      } satisfies Partial<SignInError>);
    },
  );
});
