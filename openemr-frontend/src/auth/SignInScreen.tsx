import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {useCallback} from 'react';

import {BFF_LOGIN_PATH} from '../api/auth/paths';
import {OpenEmrLogo} from '../brand/OpenEmrLogo';
import type {Notice} from './notice';
import {TOUCH_TARGET} from '../theme/tokens';

interface SignInScreenProps {
  /** Why the user is here (signed out, session ended, sign-in failed); fixed text only. */
  readonly notice?: Notice | undefined;
  /** Offered when the session could not be checked: reads it again. */
  readonly onRetry?: (() => void) | undefined;
  /** The build's version (FR-UI-3), shown small under the action. */
  readonly version?: string | undefined;
}

/**
 * W-1: one action, a top-level form post to the token handler (API-40). Credentials and consent are OpenEMR's own
 * screens, so there is no field here (FR-AUTH-1). Focus starts on the action, so it is never lost when a session
 * ends under the user.
 */
export function SignInScreen({notice, onRetry, version}: SignInScreenProps) {
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
        Patient Dashboard
      </Typography>
      <Typography color="textSecondary">
        Sign in with your OpenEMR account to continue.
      </Typography>
      {notice !== undefined && (
        <Alert
          severity={notice.severity}
          sx={{maxWidth: 560, textAlign: 'left'}}
        >
          <AlertTitle>{notice.title}</AlertTitle>
          {notice.body}
        </Alert>
      )}
      <Box component="form" method="post" action={BFF_LOGIN_PATH}>
        <Button
          ref={focusOnMount}
          type="submit"
          variant="contained"
          disableElevation
          sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET, px: 3}}
        >
          Sign in with OpenEMR
        </Button>
      </Box>
      {onRetry !== undefined && (
        <Button
          type="button"
          variant="outlined"
          onClick={onRetry}
          sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
        >
          Try again
        </Button>
      )}
      {version !== undefined && (
        <Typography variant="body2" color="textSecondary">
          Version {version}
        </Typography>
      )}
    </Stack>
  );
}
