import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';

import {useServiceWorkerUpdate, type WorkerContainer} from './update';
import {TOUCH_TARGET} from '../theme/tokens';

// reference: REQUIREMENTS.md FR-PWA-3 · REQUIREMENTS.md W-8

interface UpdatePromptProps {
  /** The browser's worker container; `undefined` where there is no worker (development, tests, old browsers). */
  readonly container: WorkerContainer | undefined;
  /** Reloads the page; tests pass a spy. */
  readonly reload?: () => void;
}

/**
 * W-8's "Update available — Reload" snackbar. It stays until the clinician acts — no timeout, no dismissal by
 * tapping elsewhere — and it is a polite `status`, so it never takes focus or interrupts.
 */
export function UpdatePrompt({
  container,
  reload = reloadPage,
}: UpdatePromptProps) {
  const {ready, apply} = useServiceWorkerUpdate(container, reload);
  return (
    <Snackbar
      open={ready}
      anchorOrigin={{vertical: 'bottom', horizontal: 'center'}}
      message="Update available"
      slotProps={{content: {role: 'status'}}}
      action={
        <Button
          type="button"
          color="inherit"
          onClick={apply}
          sx={{
            minHeight: TOUCH_TARGET,
            minWidth: TOUCH_TARGET,
            fontWeight: 700,
          }}
        >
          Reload
        </Button>
      }
    />
  );
}

function reloadPage(): void {
  window.location.reload();
}
