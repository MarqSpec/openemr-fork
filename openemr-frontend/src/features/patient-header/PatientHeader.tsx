import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import type {SxProps, Theme} from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import type {ReactNode} from 'react';

import {ApiError} from '../../api/api_error';
import {usePatient} from '../../api/fhir/hooks';
import type {Patient} from '../../api/fhir/schemas';
import {localCalendarDate, wallClockDate} from '../../api/openemr_date';
import {
  ageOn,
  displayName,
  mrnOf,
  patientStatus,
  sexLabel,
} from './patient_format';
import {TOUCH_TARGET} from '../../theme/tokens';

// reference: REQUIREMENTS.md FR-HDR-1…4, FR-AUTH-5, FR-CARD-3 · REQUIREMENTS.md BUG-6, BUG-51, BUG-61 ·
// REQUIREMENTS.md W-3, W-12c (the name is the page's h1)

export interface PatientHeaderProps {
  readonly patientId: string;
  /** "Now", for ages; tests pass a fixed clock. */
  readonly clock?: () => Date;
  /** Receives the page's h1 whenever one is drawn, so the chart can move focus to it (W-12c). */
  readonly headingRef?: HeadingRef;
}

/** A callback ref for the page's h1. */
type HeadingRef = (node: HTMLElement | null) => void;

const VISUALLY_HIDDEN = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

// Pinned just below the sticky app bar: MUI's Toolbar heights plus the bar's 1 px bottom border. The queries do
// not overlap, so their order in the generated CSS cannot let the landscape one win on a tablet.
const PINNED: SxProps<Theme> = theme => ({
  position: 'sticky',
  top: 57,
  [`${theme.breakpoints.down('sm')} and (orientation: landscape)`]: {top: 49},
  [theme.breakpoints.up('sm')]: {top: 65},
  zIndex: theme.zIndex.appBar - 1,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: 2,
  rowGap: 1,
  px: 2,
  py: 1,
  bgcolor: 'background.paper',
  borderBottom: 1,
  borderColor: 'divider',
});

/** Edge of the photo slot, in CSS px: two text lines tall, so the pinned bar stays one row on a landscape tablet. */
const PHOTO_SIZE = 40;

/**
 * The default silhouette in the photo slot (FR-HDR-4). Always drawn: the photo itself is deferred and never read
 * (BUG-61), so nothing about the patient reaches this slot.
 */
function PatientSilhouette(): ReactNode {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        flex: '0 0 auto',
        width: PHOTO_SIZE,
        height: PHOTO_SIZE,
        overflow: 'hidden',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.default',
        color: 'text.secondary',
      }}
    >
      <svg
        viewBox="0 0 40 40"
        role="img"
        aria-label="Photo not shown"
        width={PHOTO_SIZE}
        height={PHOTO_SIZE}
        fill="currentColor"
      >
        <circle cx="20" cy="15" r="7.5" />
        <path d="M5 40c0-8.3 6.7-14 15-14s15 5.7 15 14z" />
      </svg>
    </Box>
  );
}

/** "—" on screen; `label` for assistive tech (FR-HDR-3). */
function NotRecorded(props: {label: string}): ReactNode {
  return (
    <>
      <span aria-hidden="true">—</span>
      <Box component="span" sx={VISUALLY_HIDDEN}>
        {props.label}
      </Box>
    </>
  );
}

function valueOr(value: string | undefined, missing: string): ReactNode {
  return value ?? <NotRecorded label={missing} />;
}

function Fact(props: {
  term: string;
  hideTerm?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <Box sx={{display: 'flex', alignItems: 'center', gap: 0.75}}>
      <Box
        component="dt"
        sx={
          props.hideTerm === true ? VISUALLY_HIDDEN : {color: 'text.secondary'}
        }
      >
        {props.term}
      </Box>
      <Box component="dd" sx={{m: 0}}>
        {props.children}
      </Box>
    </Box>
  );
}

/** The page's h1: the patient's name, or a PHI-free title when none can be shown (W-12c focuses it). */
function PageHeading({
  children,
  headingRef,
}: {
  children: ReactNode;
  headingRef: HeadingRef | undefined;
}): ReactNode {
  return (
    <Typography
      ref={headingRef}
      tabIndex={-1}
      component="h1"
      variant="h5"
      sx={{fontSize: '1.25rem', fontWeight: 700}}
    >
      {children}
    </Typography>
  );
}

const UNAVAILABLE = 'Patient unavailable';

function StatusChip(props: {patient: Patient}): ReactNode {
  const status = patientStatus(props.patient);
  if (status.kind === 'active') {
    return (
      <Chip
        size="small"
        variant="outlined"
        color="success"
        label="Active (as reported by OpenEMR)"
      />
    );
  }
  // An unknown age at death is said once, on the DOB line, which knows why it is unknown.
  const ageAtDeath = ageOn(props.patient.birthDate, status.date);
  return (
    <Chip
      size="small"
      color="error"
      sx={{fontWeight: 700}}
      label={
        <>
          Deceased {valueOr(status.date, 'Date of death not recorded')}
          {ageAtDeath === undefined
            ? null
            : ` · age at death ${String(ageAtDeath)}`}
        </>
      }
    />
  );
}

/** Why a deceased patient's age at death cannot be given: no date of death, or only part of a birth date. */
function ageAtDeathMissing(
  birthDate: string,
  deathDate: string | undefined,
): string {
  if (deathDate === undefined) return 'Age at death not recorded';
  return /^\d{4}-\d{2}-\d{2}/.test(birthDate)
    ? 'Age at death unknown'
    : 'Age at death unknown: date of birth is partial';
}

/**
 * DOB with age. A deceased patient's age is the age at death, as the legacy bar shows it (SCREEN_AUDIT
 * SCR-PATBAR) — never an age today they did not reach; without a date of death it is "—".
 */
function DateOfBirth(props: {patient: Patient; today: string}): ReactNode {
  const {patient, today} = props;
  const birthDate = wallClockDate(patient.birthDate);
  if (birthDate === undefined) {
    return <NotRecorded label="Date of birth not recorded" />;
  }
  const status = patientStatus(patient);
  if (status.kind === 'deceased') {
    const ageAtDeath = ageOn(birthDate, status.date);
    return (
      <>
        {birthDate} (age at death{' '}
        {valueOr(
          ageAtDeath === undefined ? undefined : String(ageAtDeath),
          ageAtDeathMissing(birthDate, status.date),
        )}
        )
      </>
    );
  }
  const age = ageOn(birthDate, today);
  return age === undefined ? birthDate : `${birthDate} (age ${String(age)})`;
}

function Identity(props: {
  patient: Patient;
  today: string;
  headingRef: HeadingRef | undefined;
}): ReactNode {
  const {patient, today} = props;
  return (
    <>
      <PatientSilhouette />
      <PageHeading headingRef={props.headingRef}>
        {valueOr(displayName(patient.name), 'Name not recorded')}
      </PageHeading>
      <Box
        component="dl"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: 2,
          rowGap: 0.5,
          m: 0,
        }}
      >
        <Fact term="DOB">
          <DateOfBirth patient={patient} today={today} />
        </Fact>
        <Fact term="Sex">{valueOr(sexLabel(patient), 'Sex not recorded')}</Fact>
        <Fact term="MRN">
          {valueOr(mrnOf(patient.identifier), 'MRN not recorded')}
        </Fact>
        <Fact term="Status" hideTerm>
          <StatusChip patient={patient} />
        </Fact>
      </Box>
    </>
  );
}

/**
 * The persistent patient header (FR-HDR-1): the default silhouette (FR-HDR-4), name, DOB with age, sex, MRN and a
 * labelled status, pinned while the cards scroll. Reads API-12 through the API layer. A 401 renders nothing — the app's session-over handler owns it.
 */
export function PatientHeader(props: PatientHeaderProps): ReactNode {
  const {patientId, clock = () => new Date(), headingRef} = props;
  const query = usePatient(patientId);

  if (query.isPending) {
    if (query.fetchStatus === 'idle') return null;
    return (
      <Box
        component="section"
        aria-label="Patient"
        aria-busy="true"
        sx={PINNED}
      >
        <Box component="span" sx={VISUALLY_HIDDEN}>
          Loading patient…
        </Box>
        <Skeleton variant="text" width={220} sx={{fontSize: '1.25rem'}} />
        <Skeleton variant="text" width={360} />
      </Box>
    );
  }

  if (query.isError) {
    const kind =
      query.error instanceof ApiError ? query.error.failure.kind : undefined;
    if (kind === 'session-over') return null;
    return (
      <Box component="section" aria-label="Patient" sx={PINNED}>
        <PageHeading headingRef={headingRef}>{UNAVAILABLE}</PageHeading>
        {kind === 'not-authorised' ? (
          <Alert severity="warning">
            You&apos;re not authorised to view this patient. Access is
            controlled in OpenEMR.
          </Alert>
        ) : (
          <Alert
            severity="error"
            action={
              <Button
                color="inherit"
                sx={{minHeight: TOUCH_TARGET}}
                onClick={() => void query.refetch()}
              >
                Try again
              </Button>
            }
          >
            Couldn&apos;t load this patient.
          </Alert>
        )}
      </Box>
    );
  }

  const item = query.data;
  return (
    <Box component="section" aria-label="Patient" sx={PINNED}>
      {item.kind === 'ok' ? (
        <Identity
          patient={item.resource}
          today={localCalendarDate(clock())}
          headingRef={headingRef}
        />
      ) : (
        <>
          <PageHeading headingRef={headingRef}>{UNAVAILABLE}</PageHeading>
          <Typography>
            Could not display this patient&apos;s details.
          </Typography>
        </>
      )}
    </Box>
  );
}
