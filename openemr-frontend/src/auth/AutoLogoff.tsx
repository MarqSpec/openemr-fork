import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import {useQueryClient, type QueryKey} from '@tanstack/react-query';
import {useCallback, useEffect, useId, useRef, useState} from 'react';

import {ApiError} from '../api/api_error';
import {keepAliveQuery, sessionCheckQuery} from '../api/auth/hooks';
import {authKeys} from '../api/auth/query_keys';
import {VISUALLY_HIDDEN} from './visually_hidden';
import {TOUCH_TARGET} from '../theme/tokens';

// reference: REQUIREMENTS.md FR-AUTH-4, NFR-SEC-3 · INTERFACES.md API-42, API-46 ·
// REQUIREMENTS.md W-6, W-12c · a separate change (note 87130), a separate change

/** The warning shows this long before sign-out (FR-AUTH-4). */
export const WARNING_MS = 60 * 1000;

/** A re-read or keep-alive unanswered after this long is a failure (cancelled): well inside the warning minute. */
export const REQUEST_LIMIT_MS = 10 * 1000;

/** What the idle clock starts from: the session read that signed the clinician in. */
export interface SessionClock {
  /** API-42's `idleTimeoutSeconds`: the token handler's own idle timeout, so both clocks use one period. */
  readonly idleTimeoutSeconds: number;
  /** When that read arrived, on the tablet clock: the idle clock's starting point. */
  readonly readAt: number;
  /** When the server session ends, on the tablet clock (the read's arrival plus its server-clock time left). */
  readonly serverDeadline: number;
}

interface AutoLogoffProps {
  readonly clock: SessionClock;
  /** Clears patient data and signs out (the provider's). */
  readonly onExpire: () => void;
}

type Problem = 'unreachable' | 'at-limit';

// `scroll` also sees scrolls the page causes itself (layout, focus restore). Harmless: an event only marks input,
// which buys at most one keep-alive, and the keep-alive and re-read render nothing, so they cannot cause another.
const ACTIVITY_EVENTS = [
  'pointerdown',
  'touchstart',
  'keydown',
  'wheel',
  'scroll',
] as const;

/** How a re-read or keep-alive ended: `over` means a 401 has already ended the session in the query client. */
type Outcome = 'ok' | 'over' | 'failed';

function outcomeOf(error: unknown): Outcome {
  return error instanceof ApiError && error.failure.kind === 'session-over'
    ? 'over'
    : 'failed';
}

/**
 * Automatic logoff (W-6). The client idle clock restarts on touch, key or scroll; the server's restarts only on an
 * authenticated request, and reading API-42 is not one. A minute before the **earlier** of the two deadlines the
 * session is re-read (not activity) in case other requests moved the server deadline. If there has been real input
 * since the last automatic keep-alive and the client clock still has more than a minute to run, one keep-alive is
 * sent instead of the warning (FR-AUTH-4: input is activity) — at most one per input, so an unattended tablet still
 * times out. Otherwise the warning shows. "Stay signed in" (or Escape) sends the keep-alive
 * (API-46), whose answer is the new server deadline; at zero, or on "Sign out now", `onExpire` signs out. A re-read or
 * keep-alive that gets no usable answer keeps the last known server deadline and never changes the session state the
 * shell draws from. Sign-out never waits on the network:
 * each request is cut off after {@link REQUEST_LIMIT_MS}, and while one is in flight a timer at the last known
 * deadline signs out regardless.
 */
export function AutoLogoff({clock, onExpire}: AutoLogoffProps) {
  const client = useQueryClient();
  const idleMs = clock.idleTimeoutSeconds * 1000;
  const lastActivity = useRef(clock.readAt);
  const lastAutoExtend = useRef(clock.readAt);
  const serverDeadline = useRef(clock.serverDeadline);
  const [warningUntil, setWarningUntil] = useState<number | null>(null);
  const [now, setNow] = useState(clock.readAt);
  const [secondsAtOpen, setSecondsAtOpen] = useState(0);
  const [problem, setProblem] = useState<Problem | null>(null);
  const extending = useRef(false);

  const deadline = useCallback(
    () => Math.min(lastActivity.current + idleMs, serverDeadline.current),
    [idleMs],
  );

  /** `work`'s outcome, or `failed` (and the request cancelled) when it is still unanswered after the limit. */
  const withinLimit = useCallback(
    (key: QueryKey, work: () => Promise<Outcome>): Promise<Outcome> =>
      new Promise(resolve => {
        const limit = setTimeout(() => {
          resolve('failed');
          void client.cancelQueries({queryKey: key});
        }, REQUEST_LIMIT_MS);
        void work().then(outcome => {
          clearTimeout(limit);
          resolve(outcome);
        });
      }),
    [client],
  );

  /** Re-reads API-42 on its own key to learn where the server deadline is now; a failure keeps the last known. */
  const rereadSession = useCallback(
    (): Promise<Outcome> =>
      withinLimit(authKeys.sessionCheck(), async () => {
        try {
          const session = await client.query(sessionCheckQuery());
          serverDeadline.current = Date.now() + session.expiresInMs;
          return 'ok';
        } catch (error) {
          return outcomeOf(error);
        }
      }),
    [client, withinLimit],
  );

  /** API-46: the server idle clock restarts, and its answer is the new server deadline (no re-read needed). */
  const keepAlive = useCallback(
    (): Promise<Outcome> =>
      withinLimit(authKeys.keepAlive(), async () => {
        try {
          const extension = await client.query(keepAliveQuery());
          serverDeadline.current = Date.now() + extension.expiresInMs;
          return 'ok';
        } catch (error) {
          return outcomeOf(error);
        }
      }),
    [client, withinLimit],
  );

  // Watching: count activity and wake a minute before the earlier deadline.
  useEffect(() => {
    if (warningUntil !== null) return;
    // Read through a function: after an await, TS would still narrow a plain flag to its earlier `false`.
    const run = {cancelled: false};
    const cancelled = () => run.cancelled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const onActivity = () => {
      lastActivity.current = Date.now();
    };
    const schedule = () => {
      timer = setTimeout(
        () => void check(),
        Math.max(0, deadline() - WARNING_MS - Date.now()),
      );
    };
    const open = (why: Problem | null) => {
      const at = Date.now();
      const until = deadline();
      setProblem(why);
      setNow(at);
      setSecondsAtOpen(Math.max(1, Math.ceil((until - at) / 1000)));
      setWarningUntil(until);
    };
    const check = async () => {
      if (deadline() - Date.now() > WARNING_MS) {
        schedule();
        return;
      }
      // Whatever the requests below do, the session ends by the deadline known now.
      backstop = setTimeout(onExpire, Math.max(0, deadline() - Date.now()));
      await watch();
      clearTimeout(backstop);
    };
    const watch = async () => {
      if ((await rereadSession()) === 'over' || cancelled()) return;
      if (deadline() - Date.now() > WARNING_MS) {
        schedule();
        return;
      }
      const at = Date.now();
      const inputSinceLastExtend =
        lastActivity.current > lastAutoExtend.current;
      if (
        inputSinceLastExtend &&
        lastActivity.current + idleMs - at > WARNING_MS
      ) {
        lastAutoExtend.current = at;
        const outcome = await keepAlive();
        if (outcome === 'over' || cancelled()) return;
        if (outcome === 'ok' && deadline() - Date.now() > WARNING_MS) {
          schedule();
          return;
        }
        open(outcome === 'failed' ? 'unreachable' : 'at-limit');
        return;
      }
      open(null);
    };
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, {capture: true, passive: true});
    }
    schedule();
    return () => {
      run.cancelled = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, {capture: true});
      }
    };
  }, [warningUntil, deadline, idleMs, rereadSession, keepAlive, onExpire]);

  // Warning: tick each second and sign out at zero.
  useEffect(() => {
    if (warningUntil === null) return;
    const tick = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= warningUntil) onExpire();
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, [warningUntil, onExpire]);

  const stay = async () => {
    if (extending.current) return;
    extending.current = true;
    setProblem(null);
    try {
      const outcome = await keepAlive();
      if (outcome === 'over') return;
      if (outcome === 'failed') {
        setProblem('unreachable');
        return;
      }
      const at = Date.now();
      lastActivity.current = at;
      lastAutoExtend.current = at;
      if (deadline() - at > WARNING_MS) {
        setWarningUntil(null);
      } else {
        setProblem('at-limit');
      }
    } finally {
      extending.current = false;
    }
  };

  const titleId = useId();
  const bodyId = useId();
  const focusOnMount = useCallback((node: HTMLButtonElement | null) => {
    node?.focus();
  }, []);

  if (warningUntil === null) return null;
  const secondsLeft = Math.max(0, Math.ceil((warningUntil - now) / 1000));
  const shown = `${String(Math.floor(secondsLeft / 60))}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const announcement =
    secondsLeft <= 10
      ? '10 seconds left'
      : secondsLeft <= 30
        ? '30 seconds left'
        : '';

  return (
    <Dialog
      open
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={(_event, reason) => {
        // Escape is the safe action (W-12c): stay. A tap on the scrim is not an answer.
        if (reason === 'escapeKeyDown') void stay();
      }}
    >
      <DialogTitle id={titleId}>Still there?</DialogTitle>
      <DialogContent>
        <Box id={bodyId} sx={VISUALLY_HIDDEN}>
          For privacy you&apos;ll be signed out in{' '}
          {secondsAtOpen >= 60
            ? '1 minute'
            : `${String(secondsAtOpen)} seconds`}{' '}
          unless you stay signed in.
        </Box>
        <DialogContentText aria-hidden="true">
          For privacy you&apos;ll be signed out in <b>{shown}</b>.
        </DialogContentText>
        <Box role="status" sx={VISUALLY_HIDDEN}>
          {announcement}
        </Box>
        {problem !== null && (
          <Alert severity="error" sx={{mt: 2}}>
            {problem === 'unreachable'
              ? "Couldn't keep you signed in. Check the connection and try again."
              : "This session has reached its time limit and can't be extended. Sign in again to continue."}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          type="button"
          onClick={onExpire}
          sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
        >
          Sign out now
        </Button>
        <Button
          ref={focusOnMount}
          type="button"
          variant="contained"
          disableElevation
          onClick={() => void stay()}
          sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
        >
          Stay signed in
        </Button>
      </DialogActions>
    </Dialog>
  );
}
