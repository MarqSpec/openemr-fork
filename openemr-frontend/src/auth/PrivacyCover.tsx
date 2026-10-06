import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import {useEffect, useRef, useState} from 'react';
import {flushSync} from 'react-dom';

import {OpenEmrLogo} from '../brand/OpenEmrLogo';

// reference: REQUIREMENTS.md FR-UI-4, NFR-SEC-3 · REQUIREMENTS.md W-7 · REQUIREMENTS.md §8.4

interface PrivacyCoverOptions {
  /** True while patient data may be on screen (someone is signed in). */
  readonly active: boolean;
  readonly graceMs: number;
  /** Signs out; called once the app has been hidden for longer than the grace. */
  readonly onExpire: () => void;
}

/**
 * Whether patient data must be covered. A PWA cannot set FLAG_SECURE, so when the app is hidden (`visibilitychange`)
 * the cover goes up synchronously — before the handler returns and Android takes its recents snapshot. Back within
 * the grace, it comes down; hidden longer (a timer, or the clock on return if the page was frozen), it signs out.
 */
export function usePrivacyCover({
  active,
  graceMs,
  onExpire,
}: PrivacyCoverOptions): boolean {
  const [covered, setCovered] = useState(false);
  const expire = useRef(onExpire);

  useEffect(() => {
    expire.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (!active) return;
    let hiddenAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (hiddenAt !== undefined) return;
        hiddenAt = Date.now();
        flushSync(() => {
          setCovered(true);
        });
        timer = setTimeout(() => {
          expire.current();
        }, graceMs);
        return;
      }
      if (hiddenAt === undefined) return;
      clearTimeout(timer);
      const away = Date.now() - hiddenAt;
      hiddenAt = undefined;
      if (away >= graceMs) {
        expire.current();
      } else {
        setCovered(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
    };
  }, [active, graceMs]);

  return active && covered;
}

/**
 * W-7: an opaque layer over the whole viewport, above dialogs and menus (which portal outside the covered tree),
 * showing no patient data.
 */
export function PrivacyCover() {
  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: theme => theme.zIndex.tooltip + 1,
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        textAlign: 'center',
        p: 2,
      }}
    >
      <OpenEmrLogo size={64} />
      <Typography component="p" variant="h6">
        Patient data hidden
      </Typography>
      <Typography color="textSecondary">
        Return to the app to continue
      </Typography>
    </Box>
  );
}
