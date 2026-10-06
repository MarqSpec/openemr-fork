import {QueryClientProvider, useQuery} from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {flushSync} from 'react-dom';

import {sessionQuery} from '../api/auth/hooks';
import {ApiError} from '../api/api_error';
import {createQueryClient} from '../api/query_client';
import {AutoLogoff, type SessionClock} from './AutoLogoff';
import {PrivacyCover, usePrivacyCover} from './PrivacyCover';
import {PRIVACY_GRACE_SECONDS} from './session_config';
import {submitSignOut, type SignOutOptions} from './sign_out';

// reference: REQUIREMENTS.md FR-AUTH-3, FR-AUTH-4, FR-AUTH-5, FR-UI-3, FR-UI-4 · INTERFACES.md API-42 ·
// a separate change (note 85517) · a separate change (note 87776: back/forward cache) · a separate change (note 87130) · FR-PWA-4, a separate change (offline)

/** What the app knows about the session; the shell draws the sign-in screen for everything but `signed-in`. */
export type SessionState =
  | {readonly kind: 'checking'}
  | {readonly kind: 'signed-in'; readonly displayName: string | null}
  /** `ended`: a live session ended under the user (a 401 after sign-in), rather than nobody having signed in. */
  | {readonly kind: 'signed-out'; readonly ended: boolean}
  /** No connection: the read never got an answer. Retried by the user, or by itself when the device is back online. */
  | {readonly kind: 'offline'; readonly retry: () => void}
  /** The session read failed with an answer that says nothing (5xx, malformed): unknown until the user retries. */
  | {readonly kind: 'unavailable'; readonly retry: () => void};

const SessionContext = createContext<SessionState>({kind: 'checking'});

/** The session state from the nearest {@link SessionProvider}. */
export function useSession(): SessionState {
  return useContext(SessionContext);
}

/**
 * Owns the app's QueryClient and the session. The first 401 from any read clears every cached query (the client
 * does that) and flips the state to `signed-out` here, so whatever renders patient data unmounts at once — clearing
 * the cache alone would leave it in the DOM. A client never comes back from a 401: sign-in reloads the app.
 * `children` stay mounted across state changes; only what they choose to render for a state comes and goes.
 *
 * The back/forward cache would otherwise hand a signed-in page, patient data and all, to whoever presses Back after
 * sign-out, without a request. So leaving the page (`pagehide`) unmounts patient data and empties the cache before
 * the browser freezes it, and a page restored from the cache (`pageshow` with `persisted`) reloads, which reads the
 * session afresh. By `pagehide` the navigation has committed, so this cannot cancel the sign-out form post.
 *
 * While someone is signed in it also runs automatic logoff (W-6, {@link AutoLogoff}) and the privacy cover (W-7,
 * {@link usePrivacyCover}). Either one ending the session empties the cache, unmounts patient data synchronously and
 * then signs out through the same form post as the account menu.
 */
export function SessionProvider({
  children,
  reload = reloadPage,
  signOut = submitSignOut,
  privacyGraceSeconds = PRIVACY_GRACE_SECONDS,
}: SessionProviderProps) {
  const [over, setOver] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [ending, setEnding] = useState(false);
  const [read, setRead] = useState<SessionState>(CHECKING);
  const [clock, setClock] = useState<SessionClock | null>(null);
  const [everSignedIn, setEverSignedIn] = useState(false);
  const [client] = useState(() =>
    createQueryClient({
      onSessionOver: () => {
        setOver(true);
      },
    }),
  );
  const onRead = useCallback(
    (state: SessionState, readClock: SessionClock | null) => {
      setRead(state);
      if (readClock !== null) setClock(readClock);
      if (state.kind === 'signed-in') setEverSignedIn(true);
    },
    [],
  );
  const state = useMemo((): SessionState => {
    if (leaving) return {kind: 'signed-out', ended: false};
    if (ending) return {kind: 'signed-out', ended: true};
    return over ? {kind: 'signed-out', ended: everSignedIn} : read;
  }, [leaving, ending, over, everSignedIn, read]);

  const ended = useRef(false);
  const endSession = useCallback(() => {
    if (ended.current) return;
    ended.current = true;
    client.clear();
    // Synchronously: patient data leaves the DOM before the form post navigates or the OS snapshots the page.
    flushSync(() => {
      setEnding(true);
    });
    signOut({reason: 'idle'});
  }, [client, signOut]);

  const signedIn = state.kind === 'signed-in';
  const covered = usePrivacyCover({
    active: signedIn,
    graceMs: privacyGraceSeconds * 1000,
    onExpire: endSession,
  });

  useEffect(() => {
    const onPageHide = () => {
      client.clear();
      // Synchronously: the snapshot is taken as soon as this handler returns.
      flushSync(() => {
        setLeaving(true);
      });
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reload();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [client, reload]);

  return (
    <QueryClientProvider client={client}>
      {!over && !leaving && !ending && <SessionReader onRead={onRead} />}
      <SessionContext.Provider value={state}>
        {/* `hidden` takes the covered tree out of the rendering; `display: contents` keeps it layout-neutral. */}
        <div
          hidden={covered}
          style={covered ? undefined : {display: 'contents'}}
        >
          {children}
        </div>
        {signedIn && clock !== null && (
          <AutoLogoff clock={clock} onExpire={endSession} />
        )}
        {covered && <PrivacyCover />}
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

const CHECKING: SessionState = {kind: 'checking'};

interface SessionProviderProps {
  readonly children: ReactNode;
  /** Reloads the page; tests pass a spy, since jsdom's `location.reload` cannot be replaced. */
  readonly reload?: () => void;
  /** Signs out by form post (API-43) after an automatic logoff; tests pass a spy (jsdom cannot submit a form). */
  readonly signOut?: (options?: SignOutOptions) => void;
  /** Seconds the app may stay hidden before it signs out (W-7); the build's `VITE_PRIVACY_GRACE_SECONDS`. */
  readonly privacyGraceSeconds?: number;
}

function reloadPage(): void {
  window.location.reload();
}

/**
 * Reads API-42 once (sessionQuery) while the session may be live, and reports what it learns. It unmounts on the
 * first 401, so nothing re-creates the session query in the cache that 401 just cleared.
 */
function SessionReader({
  onRead,
}: {
  readonly onRead: (state: SessionState, clock: SessionClock | null) => void;
}) {
  const query = useQuery(sessionQuery());
  const {isSuccess, isError, data, dataUpdatedAt, error, refetch} = query;

  const state = useMemo((): SessionState => {
    if (isSuccess) return {kind: 'signed-in', displayName: data.displayName};
    if (!isError) return CHECKING;
    // A 401 is the provider's to handle (it is about to unmount this reader); never offer a retry for it.
    if (error instanceof ApiError && error.failure.kind === 'session-over') {
      return {kind: 'signed-out', ended: false};
    }
    if (error instanceof ApiError && error.failure.kind === 'network-error') {
      return {
        kind: 'offline',
        retry: () => {
          void refetch();
        },
      };
    }
    return {
      kind: 'unavailable',
      retry: () => {
        void refetch();
      },
    };
  }, [isSuccess, isError, data, error, refetch]);

  const clock = useMemo(
    (): SessionClock | null =>
      data === undefined
        ? null
        : {
            idleTimeoutSeconds: data.idleTimeoutSeconds,
            readAt: dataUpdatedAt,
            serverDeadline: dataUpdatedAt + data.expiresInMs,
          },
    [data, dataUpdatedAt],
  );

  useEffect(() => {
    onRead(state, clock);
  }, [state, clock, onRead]);

  // Resumes by itself when the connection returns (FR-PWA-4): signed in if the session lived, sign-in if not.
  useEffect(() => {
    if (state.kind !== 'offline') return;
    window.addEventListener('online', state.retry);
    return () => {
      window.removeEventListener('online', state.retry);
    };
  }, [state]);

  return null;
}
