import {createTheme, type Theme} from '@mui/material/styles';

import {DARK_TOKENS, LIGHT_TOKENS} from './tokens';

export type ThemeMode = 'light' | 'dark';

/** Builds the MUI theme for a mode from the OpenEMR token set — Material components, OpenEMR's look. */
export function createAppTheme(mode: ThemeMode): Theme {
  const tokens = mode === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
  return createTheme({
    palette: {
      mode,
      primary: {main: tokens.primary, contrastText: tokens.onPrimary},
      warning: {main: tokens.warning, contrastText: tokens.onWarning},
      error: {main: tokens.danger, contrastText: tokens.onDanger},
      success: {main: tokens.success},
      info: {main: tokens.info},
      background: {default: tokens.page, paper: tokens.surface},
      text: {primary: tokens.text, secondary: tokens.muted},
      divider: tokens.line,
    },
    typography: {
      fontFamily: '"Lato", "Helvetica", "Arial", sans-serif',
      // App-bar product name: OpenEMR's navbar brand is bold at body size.
      h6: {fontSize: '1rem', fontWeight: 700},
    },
    shape: {borderRadius: 4},
    components: {
      MuiAppBar: {
        defaultProps: {elevation: 0, color: 'inherit'},
        styleOverrides: {
          root: {
            backgroundColor: tokens.surface,
            borderBottom: `1px solid ${tokens.line}`,
          },
        },
      },
      // OpenEMR's Bootstrap buttons are sentence case, as the wireframes draw them; Material's default is capitals.
      MuiButton: {
        styleOverrides: {root: {textTransform: 'none'}},
      },
      MuiCard: {
        styleOverrides: {root: {borderRadius: 0}},
      },
      MuiLink: {
        styleOverrides: {root: {color: tokens.link}},
      },
    },
  });
}
