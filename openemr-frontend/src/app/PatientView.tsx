import {useCallback, useRef, useState, type ReactNode} from 'react';

import {Dashboard} from '../features/dashboard/Dashboard';
import {PatientApps} from '../features/patient-apps/PatientApps';
import {
  PATIENT_APPS,
  type PatientApp,
} from '../features/patient-apps/patient_apps';
import {PatientHeader} from '../features/patient-header/PatientHeader';

// reference: REQUIREMENTS.md FR-HDR-1, FR-UI-7 · REQUIREMENTS.md W-3, W-12c

export interface PatientViewProps {
  readonly patientId: string;
  /** "Now", for ages; tests pass a fixed clock. */
  readonly clock?: () => Date;
  /** Receives the header's h1 whenever one is drawn. */
  readonly headingRef?: (node: HTMLElement | null) => void;
  /** The patient-apps slot's entries (FR-APP-1); defaults to this build's `VITE_PATIENT_APPS`. */
  readonly apps?: readonly PatientApp[];
}

/**
 * One open chart: the pinned patient header, the configured patient apps (FR-APP-1), then the dashboard cards
 * scrolling beneath them (FR-HDR-1). `Workspace` mounts it for `/patient/:id`, keyed by the patient id, so a new
 * patient starts every card afresh. The header's h1 takes focus the first time it is drawn — once the patient has
 * loaded, not before (W-12c) — but only if focus is still where the chart found it: on the page itself, or on the
 * control that opened the chart. A slow patient read never pulls focus back from a card control the user has since
 * moved to.
 */
export function PatientView(props: PatientViewProps): ReactNode {
  const {headingRef} = props;
  // Where focus was as the chart opened: the tapped row, or the dialog's "Open chart".
  const [opener] = useState(() => document.activeElement);
  const arrived = useRef(false);
  const heading = useCallback(
    (node: HTMLElement | null) => {
      headingRef?.(node);
      if (node === null || arrived.current) return;
      arrived.current = true;
      const focused = document.activeElement;
      if (focused === null || focused === document.body || focused === opener)
        node.focus();
    },
    [headingRef, opener],
  );
  return (
    <>
      <PatientHeader
        patientId={props.patientId}
        headingRef={heading}
        {...(props.clock === undefined ? {} : {clock: props.clock})}
      />
      <PatientApps
        patientId={props.patientId}
        apps={props.apps ?? PATIENT_APPS}
      />
      <Dashboard patientId={props.patientId} />
    </>
  );
}
