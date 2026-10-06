import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import {useCallback, useId, useRef, useState} from 'react';

import {BFF_LOGOUT_PATH} from '../api/auth/paths';
import {VISUALLY_HIDDEN} from './visually_hidden';
import {TOUCH_TARGET} from '../theme/tokens';

// reference: REQUIREMENTS.md W-9, W-12c · REQUIREMENTS.md FR-UI-3, FR-UI-7, FR-AUTH-3

/** "Dr. Avery Demo" → "AD": the first and last words, skipping titles such as "Dr.". */
function initialsOf(displayName: string): string {
  const words = displayName
    .split(/\s+/)
    .filter(word => word !== '' && !word.endsWith('.'));
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

interface AccountMenuProps {
  /** From API-42; `null` when OpenEMR would not give the name (BUG-10). */
  readonly displayName: string | null;
  /** The build's version (FR-UI-3), e.g. "v0.1.0 · 04a9991". */
  readonly version: string;
}

/**
 * The app bar's account button — who is signed in — and its menu. Sign out asks first (W-12c): a modal
 * alertdialog with Cancel focused, so Enter or Escape is harmless; confirming form-posts to the token handler
 * (API-43), which ends the session and OpenEMR's, and the browser leaves the app.
 */
export function AccountMenu({displayName, version}: AccountMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const titleId = useId();
  const bodyId = useId();
  const focusOnMount = useCallback((node: HTMLButtonElement | null) => {
    node?.focus();
  }, []);
  const initials = displayName === null ? '' : initialsOf(displayName);

  const cancel = () => {
    setConfirming(false);
  };

  return (
    <>
      <Button
        ref={accountButton}
        color="inherit"
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? 'true' : undefined}
        onClick={event => {
          setAnchor(event.currentTarget);
        }}
        sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET, gap: 1}}
      >
        {initials !== '' && (
          <Avatar
            aria-hidden="true"
            sx={{
              width: 32,
              height: 32,
              fontSize: '0.875rem',
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
            }}
          >
            {initials}
          </Avatar>
        )}
        {displayName === null ? (
          'Signed in'
        ) : (
          <>
            <Box component="span" sx={VISUALLY_HIDDEN}>
              Signed in as
            </Box>{' '}
            {displayName}
          </>
        )}
      </Button>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null);
        }}
        // The version item is aria-disabled; this keeps it reachable by the Arrow keys, so it is heard, not skipped.
        slotProps={{
          list: {'aria-label': 'Account', disabledItemsFocusable: true},
        }}
      >
        <MenuItem
          onClick={() => {
            setAnchor(null);
            setConfirming(true);
          }}
          // MenuItem drops to `minHeight: auto` from the sm breakpoint up; the tablet target stays 48 dp.
          sx={{minHeight: {xs: TOUCH_TARGET, sm: TOUCH_TARGET}}}
        >
          Sign out
        </MenuItem>
        {/* Information, not an action: aria-disabled, but at full contrast (disabled MUI items fade to 38 %). */}
        <MenuItem
          disabled
          sx={{
            minHeight: {xs: TOUCH_TARGET, sm: TOUCH_TARGET},
            color: 'text.secondary',
            '&.Mui-disabled': {opacity: 1},
            // MUI never marks a disabled item focusVisible, so draw the keyboard focus here (WCAG 2.4.7): the
            // primary token is at least 3:1 against the menu surface in both themes.
            '&.Mui-disabled:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: '-2px',
            },
          }}
        >
          Version {version}
        </MenuItem>
      </Menu>
      <Dialog
        open={confirming}
        onClose={cancel}
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        disableRestoreFocus
        slotProps={{
          transition: {
            onExited: () => {
              accountButton.current?.focus();
            },
          },
        }}
      >
        <DialogTitle id={titleId}>Sign out?</DialogTitle>
        <DialogContent>
          <DialogContentText id={bodyId}>
            Patient data will be cleared from this tablet.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            ref={focusOnMount}
            type="button"
            onClick={cancel}
            sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
          >
            Cancel
          </Button>
          <Box component="form" method="post" action={BFF_LOGOUT_PATH}>
            <Button
              type="submit"
              variant="contained"
              disableElevation
              sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
            >
              Sign out
            </Button>
          </Box>
        </DialogActions>
      </Dialog>
    </>
  );
}
