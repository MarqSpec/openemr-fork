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
import {useState, type ReactNode} from 'react';

import {ApiError, type ApiFailure} from '../../../api/api_error';
import {useEncounters} from '../../../api/fhir/hooks';
import type {FhirItem} from '../../../api/fhir/parse';
import type {Encounter, Practitioner} from '../../../api/fhir/schemas';
import {
  calendarDate,
  localCalendarDate,
  wallClock,
} from '../../../api/openemr_date';
import {DashboardCard} from '../DashboardCard';
import {fhirItemNoticeText} from '../fhir_item_notice';
import {ReferenceName} from '../ReferenceName';

// reference: REQUIREMENTS.md FR-CARD-ENC-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5, NFR-PERF-3 ·
// INTERFACES.md API-18, API-19, API-20 · REQUIREMENTS.md SCR-ENC-HIST · REQUIREMENTS.md BUG-7, BUG-9,
// BUG-10, BUG-50, BUG-51 · REQUIREMENTS.md W-3, W-5

/** Each "Show older encounters" widens the `date` window by this much; OpenEMR cannot page (BUG-7). */
const WINDOW_MONTHS = 24;

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

/** The window's first day: `steps` × 24 months before today. */
function windowStart(now: Date, steps: number): string {
  return localCalendarDate(
    new Date(
      now.getFullYear(),
      now.getMonth() - WINDOW_MONTHS * steps,
      now.getDate(),
    ),
  );
}

/** The wall-clock start OpenEMR stored, for sorting (BUG-51); `''` for none, so it sorts last. */
function startKey(encounter: Encounter): string {
  return wallClock(encounter.period?.start) ?? '';
}

/** A start that is present but not a whole calendar date makes the encounter undisplayable (FR-CARD-3). */
function hasDisplayableStart(encounter: Encounter): boolean {
  const start = encounter.period?.start;
  return start === undefined || calendarDate(start) !== undefined;
}

/** Legacy's tie-break, `fe.id DESC`; the FHIR id is the nearest stand-in the card has. */
function byIdDescending(a: Encounter, b: Encounter): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Newest first, as legacy lists them (`ORDER BY fe.date DESC, fe.id DESC`), by the wall-clock start OpenEMR
 * stored — never the instant its offset implies (BUG-51); a tie goes to the higher id. An item that did not
 * parse, or whose date cannot be shown, goes last — kept, never dropped (FR-CARD-3).
 */
function newestFirst(
  items: readonly FhirItem<Encounter>[],
): FhirItem<Encounter>[] {
  const ok = items.flatMap(item =>
    item.kind === 'ok' && hasDisplayableStart(item.resource) ? [item] : [],
  );
  const bad = items.flatMap((item): FhirItem<Encounter>[] => {
    switch (item.kind) {
      case 'could-not-display':
      case 'more-not-shown':
        return [item];
      case 'ok':
        if (hasDisplayableStart(item.resource)) return [];
        return [
          {
            kind: 'could-not-display',
            resourceType: 'Encounter',
            reason: 'period.start: not a calendar date',
          },
        ];
      default: {
        const unexpected: never = item;
        return unexpected;
      }
    }
  });
  const sorted = ok
    .map(item => ({item, key: startKey(item.resource)}))
    .sort((a, b) =>
      a.key === b.key
        ? byIdDescending(a.item.resource, b.item.resource)
        : a.key < b.key
          ? 1
          : -1,
    )
    .map(entry => entry.item);
  return [...sorted, ...bad];
}

/** The date OpenEMR stored, as legacy shows it — never shifted to the tablet's zone (BUG-51). */
function visitDate(encounter: Encounter): string | undefined {
  return calendarDate(encounter.period?.start);
}

/** The class, not `type`: OpenEMR's type is one constant for every encounter (BUG-50). */
function visitType(encounter: Encounter): string | undefined {
  const display = encounter.class.display?.trim() ?? '';
  if (display !== '') return display;
  const code = encounter.class.code?.trim() ?? '';
  return code === '' ? undefined : code;
}

function visitReason(encounter: Encounter): string | undefined {
  const reasons = (encounter.reasonCode ?? [])
    .map(
      concept =>
        concept.text?.trim() ??
        concept.coding?.find(coding => (coding.display ?? '') !== '')
          ?.display ??
        '',
    )
    .filter(text => text !== '');
  return reasons.length === 0 ? undefined : reasons.join('; ');
}

const hasCode = (
  participant: NonNullable<Encounter['participant']>[number],
  code: string,
) =>
  (participant.type ?? []).some(concept =>
    (concept.coding ?? []).some(coding => coding.code === code),
  );

/** Legacy's Provider column is the encounter's provider (`fe.provider_id`) — the primary performer, not the referrer. */
function provider(encounter: Encounter): Reference | undefined {
  const participants = encounter.participant ?? [];
  const chosen =
    participants.find(participant => hasCode(participant, 'PPRF')) ??
    participants.find(participant => !hasCode(participant, 'REF'));
  return chosen?.individual;
}

type Reference = NonNullable<Encounter['serviceProvider']>;

/** Legacy writes a provider "Last, First Middle" (encounters.php). */
function practitionerName(practitioner: Practitioner): string | undefined {
  const names = practitioner.name ?? [];
  const name = names.find(entry => entry.use === 'official') ?? names[0];
  if (name === undefined) return undefined;
  const family = name.family?.trim() ?? '';
  const given = (name.given ?? [])
    .map(part => part.trim())
    .filter(part => part !== '')
    .join(' ');
  if (family !== '' && given !== '') return `${family}, ${given}`;
  const single = family !== '' ? family : given;
  if (single !== '') return single;
  const text = name.text?.trim() ?? '';
  return text === '' ? undefined : text;
}

function NotRecorded(props: {what: string}): ReactNode {
  return (
    <>
      <span aria-hidden="true">—</span>
      <Box component="span" sx={VISUALLY_HIDDEN}>
        {props.what} not recorded
      </Box>
    </>
  );
}

/**
 * A provider or facility through the cards' shared resolver: its reference's own display, else a read by id
 * (API-18/19, shared per session).
 */
function ProviderOrFacility(props: {
  reference: Reference | undefined;
  resourceType: 'Practitioner' | 'Organization';
  what: string;
}): ReactNode {
  const {reference, resourceType, what} = props;
  // Legacy prints "Unknown" for an encounter with no provider (encounters.php); a facility has no such word.
  const absent =
    resourceType === 'Practitioner' ? 'Unknown' : <NotRecorded what={what} />;
  if (reference === undefined) return absent;
  const display = reference.display?.trim() ?? '';
  if (display === '' && reference.reference === undefined) return absent;
  return (
    <ReferenceName
      reference={reference}
      readable={[resourceType]}
      what={what.toLowerCase()}
      practitionerName={practitionerName}
    />
  );
}

function Text(props: {value: string | undefined; what: string}): ReactNode {
  return props.value ?? <NotRecorded what={props.what} />;
}

const COLUMNS = ['Date', 'Type', 'Reason', 'Provider', 'Facility'] as const;

function EncounterRow(props: {encounter: Encounter}): ReactNode {
  const {encounter} = props;
  return (
    <TableRow>
      <TableCell sx={{whiteSpace: 'nowrap'}}>
        <Text value={visitDate(encounter)} what="Date" />
      </TableCell>
      <TableCell>
        <Text value={visitType(encounter)} what="Type" />
      </TableCell>
      <TableCell>
        <Text value={visitReason(encounter)} what="Reason" />
      </TableCell>
      <TableCell>
        <ProviderOrFacility
          reference={provider(encounter)}
          resourceType="Practitioner"
          what="Provider"
        />
      </TableCell>
      <TableCell>
        <ProviderOrFacility
          reference={encounter.serviceProvider}
          resourceType="Organization"
          what="Facility"
        />
      </TableCell>
    </TableRow>
  );
}

function EncounterTable(props: {
  items: readonly FhirItem<Encounter>[];
  busy: boolean;
}): ReactNode {
  return (
    <TableContainer>
      <Table size="small" aria-busy={props.busy}>
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
          {props.items.map((item, index) => {
            switch (item.kind) {
              case 'ok':
                return (
                  <EncounterRow
                    key={item.resource.id}
                    encounter={item.resource}
                  />
                );
              case 'could-not-display':
              case 'more-not-shown':
                // An item that did not parse has no id to key on; its place in the list is stable.
                return (
                  <TableRow key={`${item.kind}-${String(index)}`}>
                    <TableCell colSpan={COLUMNS.length}>
                      <Typography component="span" color="textSecondary">
                        <span aria-hidden="true">⚠ </span>
                        {fhirItemNoticeText(item.kind, 'encounters')}
                      </Typography>
                    </TableCell>
                  </TableRow>
                );
              default: {
                const unexpected: never = item;
                return unexpected;
              }
            }
          })}
        </TableBody>
      </Table>
    </TableContainer>
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

/** The encounter list with its window line and "Show older encounters". */
function EncounterList(props: {
  items: readonly FhirItem<Encounter>[];
  since: string;
  widening: boolean;
  onShowOlder: () => void;
}): ReactNode {
  const items = newestFirst(props.items);
  return (
    <>
      {items.length === 0 ? (
        <Typography color="textSecondary">Nothing Recorded</Typography>
      ) : (
        <EncounterTable items={items} busy={props.widening} />
      )}
      <Typography color="textSecondary" sx={{mt: 1}}>
        Showing encounters since {props.since}.
      </Typography>
      <Button
        disabled={props.widening}
        sx={{minHeight: 48, mt: 0.5}}
        onClick={props.onShowOlder}
      >
        {props.widening ? 'Loading older encounters…' : 'Show older encounters'}
      </Button>
    </>
  );
}

export interface EncounterHistoryCardProps {
  readonly patientId: string;
  /** "Now", for the date window; tests pass a fixed clock. */
  readonly clock?: () => Date;
}

/**
 * The Encounter History card — the chosen additional section (PRD §6.2), the clinical columns of the legacy
 * Visit History (SCR-ENC-HIST): newest first within a 24-month `date` window that "Show older encounters"
 * widens, because OpenEMR's FHIR cannot page (BUG-7). Names are looked up per row and never hold up the list.
 * Its states are CardItems' own, in a table rather than a list.
 */
export function EncounterHistoryCard(
  props: EncounterHistoryCardProps,
): ReactNode {
  const {patientId, clock = () => new Date()} = props;
  // The widened window belongs to one patient: every switch, back to a patient seen before included, starts again
  // at the first window (reset during render, so no render ever pairs a patient with another's window).
  // The window is anchored on the day it opened, so a re-render after local midnight neither moves nor reloads it.
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
  const query = useEncounters(patientId, since);

  let body: ReactNode = null;
  if (query.isPending) {
    if (query.fetchStatus !== 'idle') {
      body = (
        <Box aria-busy="true">
          <Box component="span" sx={VISUALLY_HIDDEN}>
            Loading encounters…
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
          You&apos;re not authorised to view encounters. Access is controlled in
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
          Couldn&apos;t load encounters{failureDetail(failure)}.
        </Alert>
      );
    }
  } else {
    const widening = query.isPlaceholderData;
    body = (
      <EncounterList
        items={query.data}
        since={widening ? windowStart(now, steps - 1) : since}
        widening={widening}
        onShowOlder={() => {
          setWidened({patientId, steps: steps + 1, anchor: now});
        }}
      />
    );
  }

  return <DashboardCard title="Encounter History">{body}</DashboardCard>;
}
