import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CssBaseline from '@mui/material/CssBaseline';
import {ThemeProvider} from '@mui/material/styles';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import {useEffect, useMemo, useState, type ReactNode} from 'react';

import {AccountMenu} from '../auth/AccountMenu';
import type {Notice} from '../auth/notice';
import {SessionProvider, useSession} from '../auth/SessionProvider';
import {isSignedOutPath, signedOutNotice} from '../auth/signed_out';
import {SignInScreen} from '../auth/SignInScreen';
import {OpenEmrLogo} from '../brand/OpenEmrLogo';
import {OfflineScreen} from '../pwa/OfflineScreen';
import {serviceWorkerContainer} from '../pwa/update';
import {UpdatePrompt} from '../pwa/UpdatePrompt';
import {createAppTheme, type ThemeMode} from '../theme/theme';
import {ThemeMenu} from '../theme/ThemeMenu';
import {
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
} from '../theme/theme_preference';
import {navigate, useLocationPath} from './navigation';
import {parseRoute} from './route';
import {APP_VERSION} from './version';
import {Workspace} from './Workspace';
import {TOUCH_TARGET} from '../theme/tokens';

// reference: REQUIREMENTS.md FR-UI-2, FR-UI-3, FR-AUTH-1, FR-AUTH-3, FR-AUTH-5, FR-PAT-2, FR-PWA-3,
// FR-PWA-4 · REQUIREMENTS.md W-1, W-2, W-8, W-9

const SESSION_ENDED: Notice = {
  severity: 'warning',
  title: 'Your session has ended',
  body: 'Patient data has been cleared from this tablet. Sign in again to continue.',
};

const SESSION_UNKNOWN: Notice = {
  severity: 'error',
  title: "Couldn't check your sign-in",
  body: "The sign-in service didn't answer. Try again, or sign in.",
};

/**
 * The app shell: OpenEMR app bar, theme selection and the session. `/signed-out` is where the token handler lands
 * the browser after sign-out (or a failed sign-in) and never reads the session; every other path reads it once and
 * shows sign-in (W-1) until someone is signed in. Signed in, `Workspace` routes patient search (W-2) and charts.
 */
export function App() {
  const [preference, setPreference] =
    useState<ThemePreference>(readThemePreference);
  const [signedOutPage] = useState(() =>
    isSignedOutPath(window.location.pathname)
      ? signedOutNotice(window.location.search)
      : undefined,
  );
  const deviceDark = useMediaQuery('(prefers-color-scheme: dark)', {
    noSsr: true,
  });
  const mode: ThemeMode =
    preference === 'system' ? (deviceDark ? 'dark' : 'light') : preference;
  const theme = useMemo(() => createAppTheme(mode), [mode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode);
  }, [mode]);

  const choose = (next: ThemePreference) => {
    setPreference(next);
    writeThemePreference(next);
  };
  const themeMenu = <ThemeMenu preference={preference} onChange={choose} />;
  const [workers] = useState(serviceWorkerContainer);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {signedOutPage === undefined ? (
        <SessionProvider>
          <SessionShell themeMenu={themeMenu} />
        </SessionProvider>
      ) : (
        <Shell actions={themeMenu}>
          <SignInScreen version={APP_VERSION} notice={signedOutPage} />
        </Shell>
      )}
      <UpdatePrompt container={workers} />
    </ThemeProvider>
  );
}

/** Draws the app bar and main area for the current session state. */
function SessionShell({themeMenu}: {readonly themeMenu: ReactNode}) {
  const session = useSession();
  const onChart = parseRoute(useLocationPath()).kind === 'patient';
  switch (session.kind) {
    case 'checking':
      return (
        <Shell actions={themeMenu}>
          <Typography role="status" color="textSecondary" sx={{p: 2}}>
            Checking your sign-in…
          </Typography>
        </Shell>
      );
    case 'signed-out':
      return (
        <Shell actions={themeMenu}>
          <SignInScreen
            version={APP_VERSION}
            notice={session.ended ? SESSION_ENDED : undefined}
          />
        </Shell>
      );
    case 'offline':
      return (
        <Shell actions={themeMenu}>
          <OfflineScreen onRetry={session.retry} />
        </Shell>
      );
    case 'unavailable':
      return (
        <Shell actions={themeMenu}>
          <SignInScreen
            version={APP_VERSION}
            notice={SESSION_UNKNOWN}
            onRetry={session.retry}
          />
        </Shell>
      );
    case 'signed-in':
      return (
        <Shell
          actions={
            <>
              {onChart && (
                <Button
                  color="inherit"
                  onClick={() => {
                    navigate('/');
                  }}
                  sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
                >
                  Patients
                </Button>
              )}
              {themeMenu}
              <AccountMenu
                displayName={session.displayName}
                version={APP_VERSION}
              />
            </>
          }
        >
          <Workspace />
        </Shell>
      );
  }
}

interface ShellProps {
  readonly actions: ReactNode;
  readonly children: ReactNode;
}

function Shell({actions, children}: ShellProps) {
  return (
    <>
      <AppBar position="sticky">
        <Toolbar sx={{gap: 1.5}}>
          <OpenEmrLogo />
          <Typography component="span" variant="h6">
            OpenEMR
          </Typography>
          <Box sx={{flex: 1}} />
          {actions}
        </Toolbar>
      </AppBar>
      <Box component="main">{children}</Box>
    </>
  );
}
