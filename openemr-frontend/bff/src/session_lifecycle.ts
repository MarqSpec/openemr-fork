import type {SessionLimits} from './config.js';
import {RefreshError, type RefreshedTokens} from './oauth.js';
import type {Session} from './session.js';
import {newOpaqueId, type ExpiringStore} from './session_store.js';

export {RefreshError, type RefreshedTokens};

/** Refresh this long before the access token expires, so a token handed out is never about to lapse mid-call. */
export const REFRESH_MARGIN_MS = 60 * 1000;

/** Why a session ended other than by sign-out; logged as `reason`, never with a token or the session id. */
export type SessionEndReason =
  | 'idle_timeout'
  | 'max_session'
  | 'access_token_expired'
  | RefreshError['reason'];

/** The two log levels the lifecycle uses; Fastify's logger fits. */
export interface SessionLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface SessionLifecycleDeps {
  store: ExpiringStore<Session>;
  now: () => number;
  policy: SessionLimits;
  /** API-5 for one refresh token; throws {@link RefreshError}. */
  refresh: (refreshToken: string) => Promise<RefreshedTokens>;
  log: SessionLog;
}

/** A live session and when it will end if nothing else happens: the earlier of idle and maximum. */
export interface SessionStatus {
  session: Session;
  expiresAt: number;
}

export interface AccessOptions {
  /** Default true: the request is the user's, so it restarts the inactivity timeout. */
  activity?: boolean;
}

/**
 * FR-BFF-4: every session read or write goes through here. Idle and maximum limits are checked on each use
 * (the store's time-to-live mirrors them), the access token is refreshed lazily inside its margin, and each
 * session's operations run one at a time — so concurrent callers share one refresh (BUG-19) and a sign-out
 * during a refresh is never undone by it.
 * reference: REQUIREMENTS.md FR-BFF-4, FR-AUTH-4; REQUIREMENTS.md Q-2; REQUIREMENTS.md BUG-19
 */
export class SessionLifecycle {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SessionLifecycleDeps) {}

  get limits(): SessionLimits {
    return this.deps.policy;
  }

  /** Stores a new session under a fresh opaque id and returns the id for the cookie. */
  async start(session: Session): Promise<string> {
    const id = newOpaqueId();
    await this.save(id, session);
    return id;
  }

  /**
   * The access token for a live session, refreshed first if it is inside its margin; `undefined` means the
   * session is over (the caller answers 401). By default the call counts as activity.
   */
  getAccessToken(
    id: string,
    options: AccessOptions = {},
  ): Promise<string | undefined> {
    return this.serialize(id, async () => {
      let session = await this.live(id);
      if (session === undefined) return undefined;
      session = await this.fresh(id, session);
      if (session === undefined) return undefined;
      if (options.activity ?? true) {
        session = {...session, lastActiveAt: this.deps.now()};
        await this.save(id, session);
      }
      return session.tokens.accessToken;
    });
  }

  /**
   * "Stay signed in" (API-46): restarts the idle clock of a live session and returns its new expiry, still capped
   * by the maximum (and, with no refresh token, by the access token). Never refreshes, so it never calls OpenEMR;
   * an ended session stays ended (`undefined`), and so does one whose access token has lapsed with no refresh
   * token to renew it.
   * reference: INTERFACES.md API-46;
   */
  recordActivity(id: string): Promise<SessionStatus | undefined> {
    return this.serialize(id, async () => {
      const session = await this.live(id);
      if (session === undefined) return undefined;
      const active: Session = {...session, lastActiveAt: this.deps.now()};
      await this.save(id, active);
      return {session: active, expiresAt: this.expiresAt(active)};
    });
  }

  /** The session and its expiry, without refreshing and without counting as activity (the SPA's poll). */
  async read(id: string): Promise<SessionStatus | undefined> {
    const session = await this.live(id);
    return session === undefined
      ? undefined
      : {session, expiresAt: this.expiresAt(session)};
  }

  /** Records the clinician's display name (or `null`: none to be had) without touching the idle clock. */
  rememberDisplayName(id: string, displayName: string | null): Promise<void> {
    return this.serialize(id, async () => {
      const session = await this.live(id);
      if (session !== undefined) await this.save(id, {...session, displayName});
    });
  }

  /** Sign-out: removes the session and returns it once (its id_token is API-6's hint). */
  end(id: string): Promise<Session | undefined> {
    return this.serialize(id, () => this.deps.store.take(id));
  }

  /**
   * The earlier of the idle deadline and the maximum session length — and, with no refresh token to renew it, the
   * access token's lapse, which ends the session too.
   */
  expiresAt(session: Session): number {
    const {tokens} = session;
    return tokens.refreshToken === undefined
      ? Math.min(this.limitsEnd(session), tokens.accessTokenExpiresAt)
      : this.limitsEnd(session);
  }

  /** The earlier of the idle deadline and the maximum session length. */
  private limitsEnd(session: Session): number {
    const {idleTimeoutMs, maxSessionMs} = this.deps.policy;
    return Math.min(
      session.lastActiveAt + idleTimeoutMs,
      session.createdAt + maxSessionMs,
    );
  }

  /** The stored session if no limit has passed; otherwise it is deleted and the reason logged. */
  private async live(id: string): Promise<Session | undefined> {
    const session = await this.deps.store.get(id);
    if (session === undefined) return undefined;
    const now = this.deps.now();
    const {idleTimeoutMs, maxSessionMs} = this.deps.policy;
    const {tokens} = session;
    if (now >= session.createdAt + maxSessionMs) {
      return this.expire(id, 'max_session');
    }
    if (now >= session.lastActiveAt + idleTimeoutMs) {
      return this.expire(id, 'idle_timeout');
    }
    if (
      tokens.refreshToken === undefined &&
      now >= tokens.accessTokenExpiresAt
    ) {
      // offline_access not granted: the token served until it lapsed, and the session ends with it.
      return this.expire(id, 'access_token_expired');
    }
    return session;
  }

  /** The session with an access token outside its refresh margin, refreshing it if needed (API-5). */
  private async fresh(
    id: string,
    session: Session,
  ): Promise<Session | undefined> {
    const now = this.deps.now();
    const {tokens} = session;
    if (now < tokens.accessTokenExpiresAt - REFRESH_MARGIN_MS) return session;
    // offline_access not granted: live() has already ended the session if the token lapsed.
    if (tokens.refreshToken === undefined) return session;
    let refreshed: RefreshedTokens;
    try {
      refreshed = await this.deps.refresh(tokens.refreshToken);
    } catch (error: unknown) {
      await this.deps.store.delete(id);
      if (!(error instanceof RefreshError)) throw error;
      this.deps.log.warn(
        error.detail === undefined
          ? {reason: error.reason}
          : {reason: error.reason, detail: error.detail},
        'session ended: refresh failed',
      );
      return undefined;
    }
    const updated: Session = {
      ...session,
      tokens: {
        ...tokens,
        accessToken: refreshed.accessToken,
        accessTokenExpiresAt:
          this.deps.now() + refreshed.expiresInSeconds * 1000,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      },
    };
    await this.save(id, updated);
    return updated;
  }

  private async expire(
    id: string,
    reason: SessionEndReason,
  ): Promise<undefined> {
    await this.deps.store.delete(id);
    this.deps.log.info({reason}, 'session ended');
    return undefined;
  }

  /**
   * The store's own expiry mirrors the idle and maximum limits, so an abandoned session is swept without being
   * asked for. Not the access token's lapse: live() ends that one itself, so its reason is logged.
   */
  private save(id: string, session: Session): Promise<void> {
    return this.deps.store.set(
      id,
      session,
      Math.max(this.limitsEnd(session) - this.deps.now(), 1),
    );
  }

  /** Runs one session's operations in arrival order; the queue is dropped once it drains. */
  private serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return run;
  }
}
