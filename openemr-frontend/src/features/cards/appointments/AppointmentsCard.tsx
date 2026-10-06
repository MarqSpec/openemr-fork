import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import {useMemo, type ReactNode} from 'react';

import {useAppointments} from '../../../api/fhir/hooks';
import type {FhirItem} from '../../../api/fhir/parse';
import type {Appointment} from '../../../api/fhir/schemas';
import {calendarDate, localCalendarDate} from '../../../api/openemr_date';
import {CardItems, showsItems} from '../CardItems';
import {DashboardCard} from '../DashboardCard';
import {ReferenceName} from '../ReferenceName';

// Past and recurring sections (SCR-DASH-APT) are out of v1; item detail (FR-CARD-6) and Open in OpenEMR
// (FR-CARD-EDIT-1) are P1 issues of their own.
// reference: REQUIREMENTS.md FR-CARD-APT-1, FR-CARD-3, FR-CARD-4, NFR-PERF-3 ·
// INTERFACES.md API-18, API-24 · REQUIREMENTS.md SCR-DASH-APT · REQUIREMENTS.md BUG-10, BUG-31, BUG-32,
// BUG-35, BUG-51

/** Legacy's `number_of_appts_to_show` default. */
const SHOWN = 10;

/** OpenEMR sends a repeating series once, at its first date, and searches only that date (BUG-31). */
const REPEATING_NOTICE =
  'Repeating appointments are listed once, on the day they start, and not at all once that day has passed. Check the calendar in OpenEMR.';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Each R4 status in words naming every legacy status OpenEMR folds into it (FhirAppointmentService, BUG-31), so none
 * claims what was not recorded: `proposed` is only legacy's "None", which legacy shows as "Scheduled"; `pending` is
 * Pending, an insurance issue, or any status it does not map.
 */
const STATUS_WORDS: Readonly<Record<Appointment['status'], string>> = {
  proposed: 'Scheduled',
  pending: 'Pending or other status',
  booked: 'Confirmed or reminder done',
  arrived: 'Arrived or arrived late',
  'checked-in': 'In exam room or chart pulled',
  fulfilled: 'Checked out or coding done',
  cancelled: 'Cancelled or left without visit',
  noshow: 'No show',
  waitlist: 'Callback requested',
  'entered-in-error': 'Entered in error',
};

const trimmed = (value: string | undefined): string => value?.trim() ?? '';

/** The day of the week of a calendar date, by calendar arithmetic in UTC so no zone applies. */
function dayOf(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '';
}

const dayAndDate = (date: string) => `${dayOf(date)} ${date}`;

/** The start as the clinic booked it — its wall clock, never shifted by its offset (BUG-51); 24-hour, legacy's default. */
function when(appointment: Appointment): string {
  const start = trimmed(appointment.start);
  if (start === '') return 'Date not recorded';
  const date = calendarDate(start);
  if (date === undefined) return 'Date unreadable; check OpenEMR';
  const time = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(start);
  return time === null
    ? dayAndDate(date)
    : `${dayAndDate(date)} ${time[1] ?? ''}:${time[2] ?? ''}`;
}

/** The category legacy shows (`pc_catname`), which OpenEMR sends as the appointment type's display. */
function category(appointment: Appointment): string | undefined {
  const concept = appointment.appointmentType;
  const text = trimmed(concept?.text);
  if (text !== '') return text;
  const display = (concept?.coding ?? [])
    .map(coding => trimmed(coding.display))
    .find(value => value !== '');
  return display;
}

type Participant = Appointment['participant'][number];

const isPrimaryPerformer = (participant: Participant) =>
  (participant.type ?? []).some(concept =>
    (concept.coding ?? []).some(coding => coding.code === 'PPRF'),
  );

/** Legacy's provider is the appointment's `pc_aid`, which OpenEMR sends as the primary performer. */
function provider(appointment: Appointment): Participant['actor'] {
  return appointment.participant.find(isPrimaryPerformer)?.actor;
}

const isDated = (item: FhirItem<Appointment>) =>
  item.kind === 'ok' && calendarDate(item.resource.start) !== undefined;

const dateOf = (item: FhirItem<Appointment> | undefined) =>
  item?.kind === 'ok' ? calendarDate(item.resource.start) : undefined;

/**
 * Legacy's display sets: the first ten dated appointments, then the rest of the tenth's day, and the day of the next
 * one for "More appointments from …". One the card cannot date, or that did not parse, is never cut by the limit.
 */
function firstShown(items: FhirItem<Appointment>[]): {
  shown: FhirItem<Appointment>[];
  moreFrom: string | undefined;
} {
  const dated = items.filter(isDated);
  if (dated.length <= SHOWN) return {shown: items, moreFrom: undefined};
  const lastDay = dateOf(dated[SHOWN - 1]);
  let cut = SHOWN;
  while (cut < dated.length && dateOf(dated[cut]) === lastDay) cut += 1;
  return {
    shown: [...dated.slice(0, cut), ...items.filter(item => !isDated(item))],
    moreFrom: dateOf(dated[cut]),
  };
}

function AppointmentRow(props: {appointment: Appointment}): ReactNode {
  const {appointment} = props;
  const name = category(appointment);
  const actor = provider(appointment);
  const hasProvider =
    actor !== undefined &&
    (trimmed(actor.display) !== '' || actor.reference !== undefined);
  return (
    <>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          columnGap: 1,
        }}
      >
        {name === undefined ? (
          <Box component="span" sx={{color: 'text.secondary'}}>
            Category not recorded
          </Box>
        ) : (
          <Box component="span" sx={{fontWeight: 700}}>
            {name}
          </Box>
        )}{' '}
        <Box component="span" sx={{whiteSpace: 'nowrap'}}>
          {when(appointment)}
        </Box>
      </Box>{' '}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          columnGap: 1,
          color: 'text.secondary',
          typography: 'body2',
        }}
      >
        <span>
          {hasProvider ? (
            <ReferenceName
              reference={actor}
              readable={['Practitioner']}
              what="provider"
            />
          ) : (
            'Provider not recorded'
          )}
        </span>{' '}
        <span>{STATUS_WORDS[appointment.status]}</span>
      </Box>
    </>
  );
}

export interface AppointmentsCardProps {
  readonly patientId: string;
  /** "Now", for today's date; tests pass a fixed clock. */
  readonly clock?: () => Date;
}

/**
 * The Appointments card (SCR-DASH-APT, future appointments only): every appointment from the tablet's today on,
 * soonest first — cancelled and no-show included, as legacy lists them — each its category, day, date and time,
 * provider and status. Wherever the list or its empty wording shows, a line says repeating appointments may be
 * missing (BUG-31).
 */
export function AppointmentsCard(props: AppointmentsCardProps): ReactNode {
  const {patientId, clock = () => new Date()} = props;
  const query = useAppointments(patientId, localCalendarDate(clock()));
  const selection = useMemo(
    () => (query.data === undefined ? undefined : firstShown(query.data)),
    [query.data],
  );
  const limited =
    selection === undefined || !showsItems(query)
      ? query
      : {...query, data: selection.shown};
  const moreFrom = showsItems(query) ? selection?.moreFrom : undefined;
  return (
    <DashboardCard
      title="Appointments"
      notice={showsItems(query) ? REPEATING_NOTICE : undefined}
    >
      <CardItems
        query={limited}
        subject="appointments"
        emptyText="No Appointments"
        renderItem={appointment => <AppointmentRow appointment={appointment} />}
      />
      {moreFrom === undefined ? null : (
        <Typography variant="body2" sx={{mt: 1}}>
          More appointments from {dayAndDate(moreFrom)}. Check OpenEMR.
        </Typography>
      )}
    </DashboardCard>
  );
}
