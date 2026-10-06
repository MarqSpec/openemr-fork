import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import {useId, useState, type ReactNode} from 'react';

import {ApiError, type ApiFailure} from '../../../api/api_error';
import {useLabResults} from '../../../api/fhir/hooks';
import type {FhirItem} from '../../../api/fhir/parse';
import type {LabResult} from '../../../api/fhir/schemas';
import {
  calendarDate,
  localCalendarDate,
  wallClock,
} from '../../../api/openemr_date';
import {DashboardCard} from '../DashboardCard';
import {fhirItemNoticeText} from '../fhir_item_notice';

// reference: REQUIREMENTS.md FR-CARD-LAB-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// INTERFACES.md API-22 · REQUIREMENTS.md SCR-DASH-LAB · REQUIREMENTS.md BUG-7, BUG-36, BUG-51, BUG-56,
// BUG-57, BUG-58 · REQUIREMENTS.md W-3, W-5

/** Each "Show older lab data" widens the `date` window by this much; OpenEMR cannot page (BUG-7). */
const WINDOW_MONTHS = 12;

/** OpenEMR's code for a result it sent with no LOINC code or no text: the name is gone (BUG-56). */
const NULL_FLAVOR = 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor';

/**
 * Words for OpenEMR's abnormal flags (`proc_res_abnormal`, coded from v3 ObservationInterpretation). `N` is its
 * "No" — not abnormal, so no words; `A` is its "Yes", which alone would not say what it means.
 */
const FLAG_WORDS: Readonly<Record<string, string | null>> = {
  N: null,
  A: 'Abnormal',
};

/** A status in words; `final` and `amended` need none. */
const STATUS_WORDS: Readonly<Partial<Record<LabResult['status'], string>>> = {
  registered: 'Registered',
  preliminary: 'Preliminary',
  cancelled: 'Cancelled',
  'entered-in-error': 'Entered in error',
  // Every OpenEMR status but final — preliminary, cancelled, error, corrected — arrives as `unknown` (BUG-57).
  unknown: 'Status unknown',
  corrected: 'Corrected',
};

const COLUMNS = ['Test', 'Result', 'Date'] as const;

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

/** The window's first day: `steps` × 12 months before today. */
function windowStart(now: Date, steps: number): string {
  return localCalendarDate(
    new Date(
      now.getFullYear(),
      now.getMonth() - WINDOW_MONTHS * steps,
      now.getDate(),
    ),
  );
}

type Coding = NonNullable<LabResult['code']['coding']>[number];
type Concept = LabResult['code'];

const trimmed = (value: string | undefined): string => value?.trim() ?? '';

/** The test's codings, the null flavour OpenEMR puts in place of a missing name left out. */
function testCodings(result: LabResult): Coding[] {
  return (result.code.coding ?? []).filter(
    coding => coding.system !== NULL_FLAVOR && trimmed(coding.code) !== '',
  );
}

/** Which test a result is of: its code, else its name; one OpenEMR sent unnamed is a test of its own (BUG-56). */
function testKey(result: LabResult): string {
  const [coding] = testCodings(result);
  if (coding !== undefined) {
    return `code ${trimmed(coding.system)}|${trimmed(coding.code)}`;
  }
  const text = trimmed(result.code.text);
  return text === '' ? `id ${result.id}` : `text ${text.toLowerCase()}`;
}

/** The result's name as OpenEMR sent it — the coding's display (its `result_text`), else the code. */
function testName(result: LabResult): string | undefined {
  const text = trimmed(result.code.text);
  if (text !== '') return text;
  const codings = testCodings(result);
  const display = codings
    .map(coding => trimmed(coding.display))
    .find(value => value !== '');
  return display ?? codings.map(coding => trimmed(coding.code)).at(0);
}

function conceptText(concept: Concept): string | undefined {
  const text = trimmed(concept.text);
  if (text !== '') return text;
  const codings = concept.coding ?? [];
  const display = codings
    .map(coding => trimmed(coding.display))
    .find(value => value !== '');
  if (display !== undefined) return display;
  return codings
    .map(coding => trimmed(coding.code))
    .find(value => value !== '');
}

/** The value as OpenEMR sent it: a number with its unit, text as written (it carries no unit — BUG-56), or a code. */
function resultValue(result: LabResult): string | undefined {
  const quantity = result.valueQuantity;
  if (quantity?.value !== undefined) {
    const unit = trimmed(quantity.unit);
    return unit === ''
      ? String(quantity.value)
      : `${String(quantity.value)} ${unit}`;
  }
  const text = trimmed(result.valueString);
  if (text !== '') return text;
  return result.valueCodeableConcept === undefined
    ? undefined
    : conceptText(result.valueCodeableConcept);
}

/** The abnormal flag in words, or `undefined` when there is none or it says "not abnormal". */
function flagWords(result: LabResult): string | undefined {
  for (const concept of result.interpretation ?? []) {
    const coding = (concept.coding ?? []).find(
      entry => trimmed(entry.code) !== '',
    );
    if (coding?.code !== undefined) {
      const words = FLAG_WORDS[coding.code.trim()];
      if (words === null) continue;
      return words ?? conceptText(concept);
    }
    const text = conceptText(concept);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** A result shown on the card: the latest of its test, with the report date OpenEMR recorded (BUG-51). */
interface Shown {
  readonly result: LabResult;
  /** The wall-clock report time, for ordering; `''` when OpenEMR sent none (BUG-58). */
  readonly key: string;
  readonly date: string | undefined;
}

/**
 * The latest result of each test, newest first by the wall-clock report time OpenEMR stored — never the instant its
 * offset implies (BUG-51); a result it sent undated still shows, after the dated ones, unless its test has a dated
 * one. A result that did not parse, or whose date is not a calendar date, is counted for "Could not display this
 * item" (FR-CARD-3); a search that says it holds more than it sent marks the result partial.
 */
function latestOfEachTest(items: readonly FhirItem<LabResult>[]): {
  shown: Shown[];
  unplaced: number;
  partial: boolean;
} {
  const latest = new Map<string, Shown>();
  let unplaced = 0;
  let partial = false;
  for (const item of items) {
    switch (item.kind) {
      case 'more-not-shown':
        partial = true;
        continue;
      case 'could-not-display':
        unplaced += 1;
        continue;
      case 'ok':
        break;
      default: {
        const unexpected: never = item;
        return unexpected;
      }
    }
    const {resource} = item;
    const recorded = resource.effectiveDateTime;
    const date = calendarDate(recorded);
    if (recorded !== undefined && date === undefined) {
      unplaced += 1;
      continue;
    }
    const shown: Shown = {
      result: resource,
      key: wallClock(recorded) ?? '',
      date,
    };
    const test = testKey(resource);
    const kept = latest.get(test);
    if (kept === undefined || shown.key > kept.key) latest.set(test, shown);
  }
  const shown = [...latest.values()].sort((a, b) =>
    a.key === b.key ? 0 : a.key < b.key ? 1 : -1,
  );
  return {shown, unplaced, partial};
}

function ResultRow(props: {shown: Shown}): ReactNode {
  const {result, date} = props.shown;
  const name = testName(result);
  const value = resultValue(result);
  const notes = [flagWords(result), STATUS_WORDS[result.status]].filter(
    (note): note is string => note !== undefined,
  );
  return (
    <TableRow>
      <TableCell component="th" scope="row">
        {name ?? (
          <Box component="span" sx={{color: 'text.secondary'}}>
            Name not sent by OpenEMR
          </Box>
        )}
      </TableCell>
      <TableCell>
        {value ?? (
          <Box component="span" sx={{color: 'text.secondary'}}>
            No value sent; check OpenEMR
          </Box>
        )}
        {notes.map(note => (
          <Box component="span" key={note} sx={{fontWeight: 700}}>
            {` · ${note}`}
          </Box>
        ))}
      </TableCell>
      <TableCell sx={{whiteSpace: 'nowrap'}}>
        {date ?? 'Date not recorded'}
      </TableCell>
    </TableRow>
  );
}

/** A row for an item the card cannot show as a result, worded as {@link CardItems} words it. */
function NoticeRow(props: {
  kind: 'could-not-display' | 'more-not-shown';
}): ReactNode {
  return (
    <TableRow>
      <TableCell colSpan={COLUMNS.length}>
        <Typography component="span" color="textSecondary">
          <span aria-hidden="true">⚠ </span>
          {fhirItemNoticeText(props.kind, 'lab data')}
        </Typography>
      </TableCell>
    </TableRow>
  );
}

function ResultTable(props: {
  shown: readonly Shown[];
  unplaced: number;
  partial: boolean;
  busy: boolean;
}): ReactNode {
  const headingId = useId();
  return (
    <>
      <Typography id={headingId} sx={{fontWeight: 700}}>
        {props.partial
          ? 'Lab data (more not shown; these may not be the latest results)'
          : 'Most recent lab data'}
      </Typography>
      <TableContainer>
        <Table size="small" aria-labelledby={headingId} aria-busy={props.busy}>
          <TableHead>
            <TableRow>
              {COLUMNS.map(column => (
                <TableCell key={column} sx={{fontWeight: 700}}>
                  {column}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {props.shown.map(shown => (
              <ResultRow key={shown.result.id} shown={shown} />
            ))}
            {Array.from({length: props.unplaced}, (_, index) => (
              // Items that did not parse have no id to key on; their count is stable.
              <NoticeRow
                key={`could-not-display-${String(index)}`}
                kind="could-not-display"
              />
            ))}
            {props.partial ? <NoticeRow kind="more-not-shown" /> : null}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

/** Words for a failure a retry may fix (as CardItems words them). */
function failureDetail(failure: ApiFailure | undefined): string {
  switch (failure?.kind) {
    case 'server-error':
      return ' (server error)';
    case 'network-error':
      return ' (no connection)';
    default:
      return '';
  }
}

export interface LabsCardProps {
  readonly patientId: string;
  /** "Now", for the date window; tests pass a fixed clock. */
  readonly clock?: () => Date;
}

/**
 * The Labs card (SCR-DASH-LAB): legacy's "Most recent lab data", as the latest result of each test with its report
 * date. OpenEMR cannot page (BUG-7) and a search without a date returns the whole history (BUG-36), so the read is a
 * 12-month `date` window; legacy shows the last lab however old, so "Show older lab data" widens it by 12 months.
 */
export function LabsCard(props: LabsCardProps): ReactNode {
  const {patientId, clock = () => new Date()} = props;
  // The widened window belongs to one patient and is anchored on the day it opened (as Encounter History's).
  const [widened, setWidened] = useState(() => ({
    patientId,
    steps: 1,
    anchor: clock(),
  }));
  if (widened.patientId !== patientId) {
    setWidened({patientId, steps: 1, anchor: clock()});
  }
  const steps = widened.patientId === patientId ? widened.steps : 1;
  const now = widened.anchor;
  const since = windowStart(now, steps);
  const query = useLabResults(patientId, since);

  let body: ReactNode = null;
  if (query.isPending) {
    if (query.fetchStatus !== 'idle') {
      body = (
        <Box aria-busy="true">
          <Box component="span" sx={VISUALLY_HIDDEN}>
            Loading lab data…
          </Box>
          <Skeleton variant="text" width="80%" />
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="text" width="70%" />
        </Box>
      );
    }
  } else if (query.isError) {
    const failure =
      query.error instanceof ApiError ? query.error.failure : undefined;
    if (failure?.kind === 'not-authorised') {
      body = (
        <Alert severity="warning">
          You&apos;re not authorised to view lab data. Access is controlled in
          OpenEMR.
        </Alert>
      );
    } else if (failure?.kind !== 'session-over') {
      body = (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              disabled={query.isFetching}
              sx={{minHeight: 48, minWidth: 48}}
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          }
        >
          Couldn&apos;t load lab data{failureDetail(failure)}.
        </Alert>
      );
    }
  } else {
    const widening = query.isPlaceholderData;
    const shownSince = widening ? windowStart(now, steps - 1) : since;
    const {shown, unplaced, partial} = latestOfEachTest(query.data);
    body = (
      <Box aria-busy={widening}>
        {shown.length === 0 && unplaced === 0 && !partial ? (
          <Typography color="textSecondary">
            {`No lab data documented since ${shownSince}.`}
          </Typography>
        ) : (
          <>
            <ResultTable
              shown={shown}
              unplaced={unplaced}
              partial={partial}
              busy={widening}
            />
            <Typography color="textSecondary" sx={{mt: 1}}>
              {partial
                ? `Showing results since ${shownSince}; more not shown, so a later result of a test may be missing.`
                : `Showing the latest result of each test since ${shownSince}.`}
            </Typography>
          </>
        )}
        <Button
          disabled={widening}
          sx={{minHeight: 48, mt: 0.5}}
          onClick={() => {
            setWidened({patientId, steps: steps + 1, anchor: now});
          }}
        >
          {widening ? 'Loading older lab data…' : 'Show older lab data'}
        </Button>
      </Box>
    );
  }

  return <DashboardCard title="Labs">{body}</DashboardCard>;
}
