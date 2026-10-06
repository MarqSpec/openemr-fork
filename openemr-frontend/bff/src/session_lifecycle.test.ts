import {describe, expect, it} from 'vitest';
import type {Session} from './session.js';
import {
  REFRESH_MARGIN_MS,
  RefreshError,
  SessionLifecycle,
  type RefreshedTokens,
  type SessionLog,
} from './session_lifecycle.js';
import {MemoryStore} from './session_store.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const IDLE = 15 * MINUTE;
const MAX = 10 * HOUR;

/** A fake clock, a real in-memory store, a scripted API-5 and a captured log: nothing real, nothing timed. */
function harness(options: {refreshToken?: string | undefined} = {}) {
  let now = 1_700_000_000_000;
  const logs: {level: string; fields: object; message: string}[] = [];
  const log: SessionLog = {
    info: (fields, message) => logs.push({level: 'info', fields, message}),
    warn: (fields, message) => logs.push({level: 'warn', fields, message}),
  };
  const refreshCalls: string[] = [];
  let answer: (refreshToken: string) => Promise<RefreshedTokens> = token =>
    Promise.resolve({
      accessToken: `access-after-${token}`,
      expiresInSeconds: 3600,
      refreshToken: `rotated-from-${token}`,
    });
  const store = new MemoryStore<Session>({maxEntries: 100, now: () => now});
  const lifecycle = new SessionLifecycle({
    store,
    now: () => now,
    policy: {idleTimeoutMs: IDLE, maxSessionMs: MAX},
    refresh: refreshToken => {
      refreshCalls.push(refreshToken);
      return answer(refreshToken);
    },
    log,
  });
  const session = (): Session => ({
    subject: 'synthetic-user-0001',
    fhirUser: undefined,
    grantedScopes: ['openid', 'offline_access'],
    tokens: {
      accessToken: 'access-0',
      accessTokenExpiresAt: now + HOUR,
      refreshToken:
        'refreshToken' in options ? options.refreshToken : 'refresh-0',
      idToken: 'id-token-0',
    },
    createdAt: now,
    lastActiveAt: now,
  });
  return {
    lifecycle,
    store,
    logs,
    refreshCalls,
    session,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    answerWith: (fn: (refreshToken: string) => Promise<RefreshedTokens>) => {
      answer = fn;
    },
  };
}

/** Keeps a session active: one authenticated request every `step` until `total` has passed. */
async function stayActive(
  h: ReturnType<typeof harness>,
  id: string,
  total: number,
  step = 10 * MINUTE,
) {
  for (let spent = 0; spent < total; spent += step) {
    h.advance(step);
    await h.lifecycle.getAccessToken(id);
  }
}

describe('given a signed-in session and its access token (FR-BFF-4)', () => {
  it('when the token is well inside its lifetime, then it is handed out as is and OpenEMR is not asked', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 50 * MINUTE);

    h.advance(10 * MINUTE - REFRESH_MARGIN_MS - 1);

    expect(await h.lifecycle.getAccessToken(id)).toBe('access-0');
    expect(h.refreshCalls).toEqual([]);
  });

  it('when the token is within the refresh margin of expiry, then it is refreshed server-side first (API-5)', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 50 * MINUTE);
    expect(h.refreshCalls).toEqual([]);

    h.advance(10 * MINUTE - REFRESH_MARGIN_MS);
    expect(await h.lifecycle.getAccessToken(id)).toBe('access-after-refresh-0');
    expect(h.refreshCalls).toEqual(['refresh-0']);
  });

  it('when many requests need the token at once, then exactly one refresh is made and all get its token (BUG-19)', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 50 * MINUTE);
    h.advance(10 * MINUTE);
    let release: () => void = () => undefined;
    h.answerWith(
      token =>
        new Promise(resolve => {
          release = () => {
            resolve({
              accessToken: `access-after-${token}`,
              expiresInSeconds: 3600,
              refreshToken: `rotated-from-${token}`,
            });
          };
        }),
    );

    const pending = Array.from({length: 5}, () =>
      h.lifecycle.getAccessToken(id),
    );
    await new Promise(resolve => setImmediate(resolve));
    release();

    expect(await Promise.all(pending)).toEqual(
      Array.from({length: 5}, () => 'access-after-refresh-0'),
    );
    expect(h.refreshCalls).toEqual(['refresh-0']);
  });

  it('when OpenEMR rotates the refresh token, then the new one is stored and used for the next refresh', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, HOUR);
    expect(h.refreshCalls).toEqual(['refresh-0']);

    await stayActive(h, id, HOUR);

    expect(h.refreshCalls).toEqual(['refresh-0', 'rotated-from-refresh-0']);
    const stored = await h.store.get(id);
    expect(stored?.tokens.refreshToken).toBe(
      'rotated-from-rotated-from-refresh-0',
    );
  });

  it('when a refresh answers without a new refresh token, then the previous one is kept', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    h.answerWith(() =>
      Promise.resolve({
        accessToken: 'access-1',
        expiresInSeconds: 3600,
        refreshToken: undefined,
      }),
    );
    await stayActive(h, id, HOUR);

    expect((await h.store.get(id))?.tokens.refreshToken).toBe('refresh-0');
  });

  it('when a refresh succeeds, then the id_token kept for sign-out is the sign-in one, whose nonce OpenEMR checks (BUG-5)', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, HOUR);

    expect((await h.store.get(id))?.tokens.idToken).toBe('id-token-0');
  });

  it.each([
    ['refresh_rejected', 'invalid_grant'],
    ['refresh_unavailable', '500'],
    ['refresh_invalid_response', undefined],
  ] as const)(
    'when the refresh fails (%s), then the session ends — this and every later request get no token — and the log names the reason, never a token',
    async (reason, detail) => {
      const h = harness();
      const id = await h.lifecycle.start(h.session());
      await stayActive(h, id, 50 * MINUTE);
      h.answerWith(() => Promise.reject(new RefreshError(reason, detail)));

      h.advance(9 * MINUTE + 30 * 1000);
      expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
      expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
      expect(await h.lifecycle.read(id)).toBeUndefined();
      expect(await h.store.get(id)).toBeUndefined();

      expect(h.refreshCalls).toEqual(['refresh-0']);
      const line = h.logs.find(l => l.message.includes('refresh'));
      expect(line?.fields).toEqual(
        detail === undefined ? {reason} : {reason, detail},
      );
      const everything = JSON.stringify(h.logs);
      for (const secret of ['access-0', 'refresh-0', 'id-token-0', id]) {
        expect(everything).not.toContain(secret);
      }
    },
  );

  it('when OpenEMR granted no refresh token (offline_access declined), then the session ends when the access token does', async () => {
    const h = harness({refreshToken: undefined});
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 50 * MINUTE);

    h.advance(9 * MINUTE + 59 * 1000);
    expect(await h.lifecycle.getAccessToken(id)).toBe('access-0');

    h.advance(1000);
    expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
    expect(h.refreshCalls).toEqual([]);
    expect(h.logs.at(-1)?.fields).toEqual({reason: 'access_token_expired'});
  });

  it('when the session is signed out while a refresh is in flight, then the refresh does not bring it back', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 50 * MINUTE);
    let release: () => void = () => undefined;
    h.answerWith(
      () =>
        new Promise(resolve => {
          release = () => {
            resolve({
              accessToken: 'access-1',
              expiresInSeconds: 3600,
              refreshToken: 'refresh-1',
            });
          };
        }),
    );

    h.advance(10 * MINUTE);
    const inFlight = h.lifecycle.getAccessToken(id);
    await new Promise(resolve => setImmediate(resolve));
    const ending = h.lifecycle.end(id);
    release();

    expect(await inFlight).toBe('access-1');
    expect(await ending).toBeDefined();
    expect(await h.store.get(id)).toBeUndefined();
    expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
  });
});

describe('given the inactivity timeout (FR-AUTH-4, default 15 min)', () => {
  it('when no authenticated request comes for the idle timeout, then the session ends even though the refresh token is valid', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());

    h.advance(IDLE - 1);
    expect(await h.lifecycle.read(id)).toBeDefined();

    h.advance(1);
    expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
    expect(await h.lifecycle.read(id)).toBeUndefined();
    expect(h.refreshCalls).toEqual([]);
  });

  it('when authenticated requests keep coming, then each one restarts the idle clock', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());

    for (let i = 0; i < 6; i++) {
      h.advance(IDLE - 1000);
      expect(await h.lifecycle.getAccessToken(id)).toBeDefined();
    }
  });

  it('when the session is only read (the SPA polling /bff/session), then the idle clock does not restart', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());

    for (let i = 0; i < 14; i++) {
      h.advance(MINUTE);
      expect(await h.lifecycle.read(id)).toBeDefined();
    }
    h.advance(MINUTE);

    expect(await h.lifecycle.read(id)).toBeUndefined();
  });

  it('when a token is fetched without counting as activity, then the idle clock does not restart', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());

    h.advance(10 * MINUTE);
    expect(
      await h.lifecycle.getAccessToken(id, {activity: false}),
    ).toBeDefined();
    h.advance(5 * MINUTE);

    expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
  });

  it('when read, then the session expires at the idle deadline, or the maximum if that comes first', async () => {
    const h = harness();
    const start = h.now();
    const id = await h.lifecycle.start(h.session());

    expect((await h.lifecycle.read(id))?.expiresAt).toBe(start + IDLE);

    await stayActive(h, id, MAX - 5 * MINUTE, 5 * MINUTE);
    expect((await h.lifecycle.read(id))?.expiresAt).toBe(start + MAX);
  });
});

describe('given the maximum session length (PRD Q-2: one clinic day, 10 h)', () => {
  it('when 10 h have passed since sign-in, then the session ends however active it was and however valid its refresh token', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());

    await stayActive(h, id, MAX - 10 * MINUTE);
    h.advance(10 * MINUTE - 1);
    expect(await h.lifecycle.getAccessToken(id)).toBeDefined();

    h.advance(1);
    expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
    expect(await h.lifecycle.read(id)).toBeUndefined();
    expect(await h.store.get(id)).toBeUndefined();
  });

  it('when a refresh would outlive the maximum, then the session still ends at the maximum', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, MAX - 5 * MINUTE, 5 * MINUTE);
    const refreshes = h.refreshCalls.length;
    expect(refreshes).toBeGreaterThanOrEqual(9);

    h.advance(5 * MINUTE);
    expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
    expect(h.refreshCalls).toHaveLength(refreshes);
  });
});

describe('given a session that ends', () => {
  it('when it is ended (sign-out), then it is returned once and gone afterwards', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());

    expect((await h.lifecycle.end(id))?.tokens.idToken).toBe('id-token-0');
    expect(await h.lifecycle.end(id)).toBeUndefined();
    expect(await h.lifecycle.getAccessToken(id)).toBeUndefined();
  });

  it('when a display name is remembered, then it is read back without touching the idle clock', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    h.advance(10 * MINUTE);

    await h.lifecycle.rememberDisplayName(id, 'Synthetic Q Clinician');
    h.advance(5 * MINUTE - 1);

    expect((await h.lifecycle.read(id))?.session.displayName).toBe(
      'Synthetic Q Clinician',
    );
    h.advance(1);
    expect(await h.lifecycle.read(id)).toBeUndefined();
  });
});

describe('given "Stay signed in" (API-46: activity with no OpenEMR call)', () => {
  it('when activity is recorded, then the idle deadline restarts from now and the new expiry is returned', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    h.advance(10 * MINUTE);

    const status = await h.lifecycle.recordActivity(id);

    expect(status?.expiresAt).toBe(h.now() + IDLE);
    expect((await h.lifecycle.read(id))?.expiresAt).toBe(h.now() + IDLE);
    h.advance(IDLE - 1);
    expect(await h.lifecycle.read(id)).toBeDefined();
  });

  it('when activity is recorded with the access token inside its refresh margin, then OpenEMR is not asked (guards a keep-alive that calls OpenEMR)', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, HOUR - REFRESH_MARGIN_MS - 10 * MINUTE);
    const refreshes = h.refreshCalls.length;
    h.advance(10 * MINUTE);

    expect(await h.lifecycle.recordActivity(id)).toBeDefined();
    expect(h.refreshCalls).toHaveLength(refreshes);
  });

  it('when the session has passed its idle deadline, then it is not revived: undefined, and it stays gone', async () => {
    const h = harness();
    const id = await h.lifecycle.start(h.session());
    h.advance(IDLE);

    expect(await h.lifecycle.recordActivity(id)).toBeUndefined();
    expect(await h.store.get(id)).toBeUndefined();
    expect(await h.lifecycle.recordActivity(id)).toBeUndefined();
  });

  it('when the id names no session, then it is undefined and nothing is stored', async () => {
    const h = harness();

    expect(await h.lifecycle.recordActivity('A'.repeat(43))).toBeUndefined();
    expect(await h.store.get('A'.repeat(43))).toBeUndefined();
  });

  it('when activity keeps coming, then the expiry never passes the 10 h maximum and the session still ends there (PRD Q-2)', async () => {
    const h = harness();
    const start = h.now();
    const id = await h.lifecycle.start(h.session());
    for (let spent = 0; spent < MAX - 5 * MINUTE; spent += 5 * MINUTE) {
      h.advance(5 * MINUTE);
      expect(await h.lifecycle.recordActivity(id)).toBeDefined();
    }

    expect((await h.lifecycle.recordActivity(id))?.expiresAt).toBe(start + MAX);
    h.advance(5 * MINUTE);
    expect(await h.lifecycle.recordActivity(id)).toBeUndefined();
  });

  it('when OpenEMR granted no refresh token and the access token has lapsed, then the session ends rather than being kept alive with nothing to act on', async () => {
    const h = harness({refreshToken: undefined});
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, HOUR - 5 * MINUTE, 5 * MINUTE);

    h.advance(5 * MINUTE);

    expect(await h.lifecycle.recordActivity(id)).toBeUndefined();
    expect(await h.store.get(id)).toBeUndefined();
    expect(h.refreshCalls).toEqual([]);
  });
});

describe('given OpenEMR granted no refresh token (offline_access declined): the access token is the session’s last word', () => {
  it('when read with the idle deadline past the access token’s lapse, then the expiry reported is the lapse (guards an SPA told it has time the session does not)', async () => {
    const h = harness({refreshToken: undefined});
    const start = h.now();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 50 * MINUTE);

    expect((await h.lifecycle.read(id))?.expiresAt).toBe(start + HOUR);
  });

  it('when "Stay signed in" is recorded with the idle deadline past the lapse, then the new expiry is the lapse, not the idle deadline (API-46)', async () => {
    const h = harness({refreshToken: undefined});
    const start = h.now();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 40 * MINUTE);
    h.advance(10 * MINUTE);

    expect((await h.lifecycle.recordActivity(id))?.expiresAt).toBe(
      start + HOUR,
    );
    expect(h.refreshCalls).toEqual([]);
  });

  it('when only read (the SPA’s poll) once the access token has lapsed, then the session is over and the reason logged', async () => {
    const h = harness({refreshToken: undefined});
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 50 * MINUTE);

    h.advance(10 * MINUTE);

    expect(await h.lifecycle.read(id)).toBeUndefined();
    expect(await h.store.get(id)).toBeUndefined();
    expect(h.logs.at(-1)?.fields).toEqual({reason: 'access_token_expired'});
  });

  it('when a refresh token was granted, then the expiry is not capped by the access token: it is refreshed instead', async () => {
    const h = harness();
    const start = h.now();
    const id = await h.lifecycle.start(h.session());
    await stayActive(h, id, 50 * MINUTE);

    expect((await h.lifecycle.read(id))?.expiresAt).toBe(
      start + 50 * MINUTE + IDLE,
    );
  });
});
