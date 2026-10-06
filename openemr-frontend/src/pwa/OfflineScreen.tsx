import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {useCallback} from 'react';

import {OpenEmrLogo} from '../brand/OpenEmrLogo';
import {TOUCH_TARGET} from '../theme/tokens';

// reference: REQUIREMENTS.md FR-PWA-4, NFR-SEC-1 · REQUIREMENTS.md W-8

interface OfflineScreenProps {
  /** Reads the session again. The app also does that by itself when the connection returns. */
  readonly onRetry: () => void;
}

/**
 * W-8: the shell opened with no connection. Fixed text only — no patient data, nothing from a previous session.
 * Focus starts on Retry so it is never stranded.
 */
export function OfflineScreen({onRetry}: OfflineScreenProps) {
  const focusOnMount = useCallback((node: HTMLButtonElement | null) => {
    node?.focus();
  }, []);

  return (
    <Stack
      spacing={2}
      sx={{alignItems: 'center', textAlign: 'center', px: 2, py: 6}}
    >
      <OpenEmrLogo size={72} />
      <Typography component="h1" variant="h5" sx={{fontWeight: 700}}>
        No connection
      </Typography>
      <Typography color="textSecondary" sx={{maxWidth: 420}}>
        Patient data isn&apos;t available offline. The dashboard will reload
        when you&apos;re back online; you may need to sign in again.
      </Typography>
      <Button
        ref={focusOnMount}
        type="button"
        variant="outlined"
        onClick={onRetry}
        sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET, px: 3}}
      >
        Retry
      </Button>
    </Stack>
  );
}
