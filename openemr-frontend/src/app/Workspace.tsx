import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import {useCallback, useId, useRef, useState} from 'react';

import {
  EMPTY_PATIENT_SEARCH,
  PatientSearch,
  type OpenedPatient,
  type PatientSearchState,
} from '../features/patient-search/PatientSearch';
import {navigate, useLocationPath} from './navigation';
import {PatientView} from './PatientView';
import {parseRoute, patientPath} from './route';
import {TOUCH_TARGET} from '../theme/tokens';

// The signed-in main area: patient search at `/`, the chart (header + dashboard, `PatientView`) at `/patient/:id`,
// keyed by that id so every card and its boundary start again for a new patient. Search state lives here, in
// memory, so Back from a chart returns to the same results; it goes when the session does.
// reference: REQUIREMENTS.md FR-PAT-1, FR-PAT-2, FR-HDR-1, FR-UI-7 · REQUIREMENTS.md W-2, W-3, W-12c ·

/**
 * Routes the signed-in app. Opening a different patient while a chart is open asks first ("Open another chart?",
 * W-12c) with Cancel focused; Cancel or Escape leaves the current chart and returns focus to the tapped row, and
 * "Open chart" lands focus on the new chart's h1 (the patient header's name).
 */
export function Workspace() {
  const route = parseRoute(useLocationPath());
  const routedId = route.kind === 'patient' ? route.patientId : undefined;
  const [search, setSearch] =
    useState<PatientSearchState>(EMPTY_PATIENT_SEARCH);
  const [openId, setOpenId] = useState(routedId);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [pending, setPending] = useState<OpenedPatient | undefined>();
  const titleId = useId();
  const bodyId = useId();
  const focusOnMount = useCallback((node: HTMLElement | null) => {
    node?.focus();
  }, []);
  // The dialog restores focus itself once it has closed (MUI's own restore races the route change).
  const opener = useRef<HTMLElement | null>(null);
  const chartHeading = useRef<HTMLElement | null>(null);
  const confirmed = useRef(false);
  const headingRef = useCallback((node: HTMLElement | null) => {
    chartHeading.current = node;
  }, []);

  // Back and Forward can land on a chart too; whatever chart the URL shows is the open one.
  if (routedId !== undefined && routedId !== openId) setOpenId(routedId);

  const go = (patient: OpenedPatient) => {
    if (patient.name !== undefined) {
      const {name} = patient;
      setNames(known => new Map(known).set(patient.id, name));
    }
    setOpenId(patient.id);
    navigate(patientPath(patient.id));
  };

  const choose = (patient: OpenedPatient) => {
    if (openId === undefined || openId === patient.id) {
      go(patient);
      return;
    }
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    confirmed.current = false;
    setPending(patient);
  };

  const current = openId === undefined ? undefined : names.get(openId);
  const next = pending?.name;

  return (
    <>
      {route.kind === 'patient' ? (
        <PatientView
          key={route.patientId}
          patientId={route.patientId}
          headingRef={headingRef}
        />
      ) : (
        <PatientSearch
          state={search}
          onStateChange={setSearch}
          onOpen={choose}
        />
      )}
      <Dialog
        open={pending !== undefined}
        onClose={() => {
          setPending(undefined);
        }}
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        disableRestoreFocus
        slotProps={{
          transition: {
            onExited: () => {
              (confirmed.current ? chartHeading : opener).current?.focus();
            },
          },
        }}
      >
        <DialogTitle id={titleId}>Open another chart?</DialogTitle>
        <DialogContent>
          <DialogContentText id={bodyId}>
            {current === undefined ? (
              'Opening this patient closes the chart that is open.'
            ) : (
              <>
                You&apos;re viewing <b>{current}</b>. Opening{' '}
                <b>{next ?? 'this patient'}</b> closes this chart.
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            ref={focusOnMount}
            onClick={() => {
              setPending(undefined);
            }}
            sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            disableElevation
            onClick={() => {
              confirmed.current = true;
              if (pending !== undefined) go(pending);
              setPending(undefined);
            }}
            sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
          >
            Open chart
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
