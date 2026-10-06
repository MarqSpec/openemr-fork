import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import {useId, useState, type ReactNode} from 'react';

import {ApiError, type ApiFailure} from '../../../api/api_error';
import {useVitals} from '../../../api/fhir/hooks';
import type {FhirItem} from '../../../api/fhir/parse';
import type {Observation} from '../../../api/fhir/schemas';
import {
  localCalendarDate,
  wallClock,
  wallClockDate,
} from '../../../api/openemr_date';
import {DashboardCard} from '../DashboardCard';
import {fhirItemNoticeText} from '../fhir_item_notice';

// reference: REQUIREMENTS.md FR-CARD-VIT-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// INTERFACES.md API-21 · REQUIREMENTS.md SCR-DASH-VIT · REQUIREMENTS.md BUG-7, BUG-34, BUG-35, BUG-51,
// BUG-54, BUG-55 · REQUIREMENTS.md W-3, W-5

/** Each "Show older vitals" widens the `date` window by this much; OpenEMR cannot page (BUG-7). */
const WINDOW_MONTHS = 12;

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

/** OpenEMR's two codes for the one pulse-oximetry reading it sends twice (BUG-55). */
const OXIMETRY = ['2708-6', '59408-5'];
/** The calculated mean blood pressure: not a vital the form recorded, and not shown (BUG-34). */
const MEAN_BLOOD_PRESSURE = '96607-7';
/** The vital-signs panel: one per form, its `hasMember` naming the form's readings. */
const PANEL = '85353-1';
/** Readings withdrawn in OpenEMR: never a row, and never the newest set. */
const WITHDRAWN: ReadonlySet<Observation['status']> = new Set([
  'entered-in-error',
  'cancelled',
]);

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

type Concept = Observation['code'];
type Quantity = NonNullable<Observation['valueQuantity']>;

const codesOf = (concept: Concept): string[] =>
  (concept.coding ?? []).flatMap(coding =>
    coding.code === undefined ? [] : [coding.code],
  );
const hasCode = (observation: Observation, codes: readonly string[]) =>
  codesOf(observation.code).some(code => codes.includes(code));

/** As recorded, two places at most, trailing zeros dropped; legacy rounds pulse, respiration, oximetry, BMI (PRD §6.3). */
const plain = (value: number) => String(Math.round(value * 100) / 100);

interface Unit {
  readonly label: string;
  /** Legacy shows weight, lengths and temperature in both systems (`forms/vitals/report.php`). */
  readonly other?: {
    readonly label: string;
    readonly from: (value: number) => number;
  };
}

const KG_PER_LB = 0.45359237;
const POUNDS: Unit = {
  label: 'lb',
  other: {label: 'kg', from: value => value * KG_PER_LB},
};
const INCHES: Unit = {
  // Legacy rounds centimetres to one place before printing two.
  label: 'in',
  other: {label: 'cm', from: value => Math.round(value * 25.4) / 10},
};

/** OpenEMR's UCUM units (`VitalsService`), as legacy words them. */
const UNITS: Readonly<Record<string, Unit>> = {
  lb_av: POUNDS,
  lb: POUNDS,
  kg: {label: 'kg', other: {label: 'lb', from: value => value / KG_PER_LB}},
  in_i: INCHES,
  in: INCHES,
  cm: {label: 'cm', other: {label: 'in', from: value => value / 2.54}},
  degF: {label: 'F', other: {label: 'C', from: value => (value - 32) * 0.5556}},
  Cel: {label: 'C', other: {label: 'F', from: value => (value * 9) / 5 + 32}},
  '/min': {label: 'per min'},
  'kg/m2': {label: 'kg/m²'},
  'mm[Hg]': {label: 'mmHg'},
};

/** `unit`, else `code` without the brackets UCUM puts round some (`[lb_av]`). */
function unitOf(quantity: Quantity): string | undefined {
  const raw = (quantity.unit ?? quantity.code)?.trim() ?? '';
  if (raw === '') return undefined;
  return /^\[[^\]]+\]$/.test(raw) ? raw.slice(1, -1) : raw;
}

/** A value with its unit, and the other system in brackets where legacy gives it: "208 lb (94.35 kg)". */
function formatQuantity(quantity: Quantity | undefined): string | undefined {
  const value = quantity?.value;
  if (quantity === undefined || value === undefined) return undefined;
  const raw = unitOf(quantity);
  const unit = raw === undefined ? undefined : (UNITS[raw] ?? {label: raw});
  if (unit === undefined) return plain(value);
  const shown = `${plain(value)} ${unit.label}`;
  return unit.other === undefined
    ? shown
    : `${shown} (${unit.other.from(value).toFixed(2)} ${unit.other.label})`;
}

function componentValue(
  observation: Observation,
  code: string,
): string | undefined {
  const component = (observation.component ?? []).find(entry =>
    codesOf(entry.code).includes(code),
  );
  return formatQuantity(component?.valueQuantity);
}

/** Legacy's "systolic/diastolic", with no unit; a side that was not recorded is a dash, never a guess. */
function bloodPressure(observation: Observation): string | undefined {
  const number = (code: string) => {
    const component = (observation.component ?? []).find(entry =>
      codesOf(entry.code).includes(code),
    );
    const value = component?.valueQuantity?.value;
    return value === undefined ? undefined : plain(value);
  };
  const systolic = number('8480-6');
  const diastolic = number('8462-4');
  if (systolic === undefined && diastolic === undefined) return undefined;
  return `${systolic ?? '—'}/${diastolic ?? '—'}`;
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

interface Vital {
  readonly label: string;
  readonly codes: readonly string[];
  readonly value: (observation: Observation) => string | undefined;
}

const quantityOf = (observation: Observation) =>
  formatQuantity(observation.valueQuantity);
const vital = (
  label: string,
  code: string,
  value: Vital['value'] = quantityOf,
): Vital => ({label, codes: [code], value});

/**
 * Legacy's rows, in its order (the `form_vitals` columns): each from the LOINC code OpenEMR files it under. The BMI
 * status and waist circumference legacy shows are not sent (BUG-55).
 */
const VITALS: readonly Vital[] = [
  vital('Blood Pressure', '85354-9', bloodPressure),
  vital('Weight', '29463-7'),
  vital('Height', '8302-2'),
  vital('Temperature', '8310-5'),
  vital('Temp Method', '8327-9', observation => text(observation.valueString)),
  vital('Pulse', '8867-4'),
  vital('Respiration', '9279-1'),
  // The form's note rides on the vital-signs panel.
  vital('Note', '85353-1', observation =>
    text(
      (observation.note ?? [])
        .map(note => note.text.trim())
        .filter(note => note !== '')
        .join('; '),
    ),
  ),
  vital('BMI', '39156-5'),
  vital('Head Circ', '9843-4'),
  {label: 'Oxygen Saturation', codes: OXIMETRY, value: quantityOf},
  {
    label: 'Oxygen Flow Rate',
    codes: OXIMETRY,
    value: observation => componentValue(observation, '3151-8'),
  },
  vital('Pediatric Height Weight Percentile', '77606-2'),
  vital('Pediatric BMI Percentile', '59576-9'),
  vital('Pediatric Head Circumference Percentile', '8289-1'),
  {
    label: 'Inhaled Oxygen Concentration',
    codes: OXIMETRY,
    value: observation => componentValue(observation, '3150-0'),
  },
];

const KNOWN_CODES = new Set([
  ...VITALS.flatMap(entry => entry.codes),
  MEAN_BLOOD_PRESSURE,
]);

/** OpenEMR's own name for a vital this card does not list. */
function nameOf(concept: Concept): string {
  return (
    text(concept.text) ??
    text(concept.coding?.find(coding => text(coding.display))?.display) ??
    text(concept.coding?.[0]?.code) ??
    'Vital sign'
  );
}

/** The set's rows: legacy's first, then anything else OpenEMR sent with a value, rather than dropping it. */
function rowsOf(set: readonly Observation[]): [string, string][] {
  const known = VITALS.flatMap((entry): [string, string][] => {
    for (const observation of set) {
      if (!hasCode(observation, entry.codes)) continue;
      const value = entry.value(observation);
      if (value !== undefined) return [[entry.label, value]];
    }
    return [];
  });
  const others = set.flatMap((observation): [string, string][] => {
    if (codesOf(observation.code).some(code => KNOWN_CODES.has(code))) {
      return [];
    }
    const value =
      formatQuantity(observation.valueQuantity) ??
      text(observation.valueString);
    return value === undefined ? [] : [[nameOf(observation.code), value]];
  });
  return [...known, ...others];
}

/** Whether an observation carries anything to show — a placeholder does not (BUG-34). */
function hasValue(observation: Observation): boolean {
  return (
    observation.valueQuantity?.value !== undefined ||
    text(observation.valueString) !== undefined ||
    (observation.note ?? []).some(note => text(note.text) !== undefined) ||
    (observation.component ?? []).some(
      component => component.valueQuantity?.value !== undefined,
    )
  );
}

/** The wall-clock time OpenEMR recorded for the form — never the instant its offset implies (BUG-35, BUG-51). */
function recordedAt(observation: Observation): string | undefined {
  return observation.effectiveDateTime ?? observation.effectivePeriod?.start;
}

interface NewestSet {
  /** As legacy prints the form's date: `YYYY-MM-DD HH:MM:SS`, or the date alone when that is all OpenEMR sent. */
  readonly when: string;
  readonly observations: readonly Observation[];
}

interface Reading {
  readonly newest: NewestSet | undefined;
  /** Entries that did not parse, or have a value but no time or form to place them in (FR-CARD-3). */
  readonly unplaced: number;
  /** The search said it holds more than it sent, so the set may not be the newest. */
  readonly partial: boolean;
}

interface Form {
  readonly encounter: string;
  readonly observations: Observation[];
}

const encounterOf = (observation: Observation) =>
  observation.encounter?.reference ?? '';

/**
 * The forms among observations recorded at one time. OpenEMR sends no form id, but forms under different encounters
 * differ, and each form's panel lists its readings. A reading no panel lists joins the one form of its encounter; with
 * two there it cannot be placed, and is counted rather than guessed into either.
 */
function formsOf(observations: readonly Observation[]): {
  forms: Form[];
  unplaced: number;
} {
  const panels = observations.filter(entry => hasCode(entry, [PANEL]));
  if (panels.length <= 1 && new Set(observations.map(encounterOf)).size <= 1) {
    return {
      forms: [{encounter: '', observations: [...observations]}],
      unplaced: 0,
    };
  }
  const forms: Form[] = [];
  const listedIn = new Map<string, Form>();
  for (const panel of panels) {
    const form: Form = {encounter: encounterOf(panel), observations: [panel]};
    forms.push(form);
    for (const member of panel.hasMember ?? []) {
      const id = member.reference?.split('/').pop();
      if (id !== undefined) listedIn.set(id, form);
    }
  }
  const panelless = new Map<string, Form>();
  let unplaced = 0;
  for (const observation of observations) {
    if (hasCode(observation, [PANEL])) continue;
    const encounter = encounterOf(observation);
    const home = listedIn.get(observation.id) ?? onlyFormIn(forms, encounter);
    if (home !== undefined) {
      home.observations.push(observation);
    } else if (forms.some(form => form.encounter === encounter)) {
      if (hasValue(observation)) unplaced += 1;
    } else {
      const form = panelless.get(encounter) ?? {encounter, observations: []};
      panelless.set(encounter, form);
      form.observations.push(observation);
    }
  }
  return {forms: [...forms, ...panelless.values()], unplaced};
}

function onlyFormIn(forms: readonly Form[], encounter: string) {
  const [only, ...others] = forms.filter(form => form.encounter === encounter);
  return others.length === 0 ? only : undefined;
}

/**
 * Of forms recorded at one time, the one with the most to show; legacy shows whichever `ORDER BY date DESC` returns
 * first. Ties go to the greatest id, so the choice is stable.
 */
function chosen(forms: readonly Form[]): Form | undefined {
  const rank = (form: Form) => ({
    rows: rowsOf(form.observations).length,
    id: form.observations[0]?.id ?? '',
  });
  return forms.reduce<Form | undefined>((best, form) => {
    if (best === undefined) return form;
    const [a, b] = [rank(form), rank(best)];
    return a.rows > b.rows || (a.rows === b.rows && a.id > b.id) ? form : best;
  }, undefined);
}

/**
 * Legacy shows the one most recent vitals form (`ORDER BY date DESC`). OpenEMR sends a form as one Observation per
 * code sharing its time, in no date order, so the newest set is one form among the observations at the latest
 * recorded time — never readings OpenEMR withdrew, never a mix of two forms.
 */
function read(items: readonly FhirItem<Observation>[]): Reading {
  let unplaced = 0;
  let partial = false;
  const dated: {key: string; raw: string; observation: Observation}[] = [];
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
    const observation = item.resource;
    if (WITHDRAWN.has(observation.status)) continue;
    if (hasCode(observation, [MEAN_BLOOD_PRESSURE])) continue;
    const raw = recordedAt(observation);
    const key = wallClock(raw);
    if (raw === undefined || key === undefined) {
      if (hasValue(observation)) unplaced += 1;
      continue;
    }
    dated.push({key, raw, observation});
  }
  const latest = dated.reduce<(typeof dated)[number] | undefined>(
    (best, entry) =>
      best === undefined || entry.key > best.key ? entry : best,
    undefined,
  );
  if (latest === undefined) return {newest: undefined, unplaced, partial};
  const when = latest.raw.includes('T')
    ? latest.key.replace('T', ' ')
    : (wallClockDate(latest.raw) ?? latest.raw);
  const split = formsOf(
    dated
      .filter(entry => entry.key === latest.key)
      .map(entry => entry.observation),
  );
  return {
    newest: {when, observations: chosen(split.forms)?.observations ?? []},
    unplaced: unplaced + split.unplaced,
    partial,
  };
}

function ItemNotice(props: {
  kind: 'could-not-display' | 'more-not-shown';
}): ReactNode {
  return (
    <Typography color="textSecondary" sx={{mt: 1}}>
      <span aria-hidden="true">⚠ </span>
      {fhirItemNoticeText(props.kind, 'vitals')}
    </Typography>
  );
}

function CouldNotDisplay(props: {count: number}): ReactNode {
  return Array.from({length: props.count}, (_, index) => (
    <ItemNotice key={index} kind="could-not-display" />
  ));
}

function VitalsSet(props: {set: NewestSet; partial: boolean}): ReactNode {
  const headingId = useId();
  const rows = rowsOf(props.set.observations);
  const heading = props.partial
    ? `Vitals from: ${props.set.when} (more not shown; this may not be the most recent)`
    : `Most recent vitals from: ${props.set.when}`;
  return (
    <>
      <Typography id={headingId} sx={{fontWeight: 700}}>
        {heading}
      </Typography>
      {rows.length === 0 ? (
        <Typography color="textSecondary">
          No values were recorded in this set.
        </Typography>
      ) : (
        <Table size="small" aria-labelledby={headingId}>
          <TableBody>
            {rows.map(([label, value], index) => (
              // A vital OpenEMR names itself may share a label; the order is stable.
              <TableRow key={`${label}-${String(index)}`}>
                <TableCell
                  component="th"
                  scope="row"
                  sx={{fontWeight: 700, pl: 0}}
                >
                  {label}
                </TableCell>
                <TableCell>{value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
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

export interface VitalsCardProps {
  readonly patientId: string;
  /** "Now", for the date window; tests pass a fixed clock. */
  readonly clock?: () => Date;
}

/**
 * The Vitals card (SCR-DASH-VIT): the most recent vitals set with its date, as the legacy card shows it. OpenEMR
 * cannot page (BUG-7), so the read is a 12-month `date` window; legacy shows the last set however old, so when the
 * window is empty "Show older vitals" widens it by another 12 months.
 */
export function VitalsCard(props: VitalsCardProps): ReactNode {
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
  const query = useVitals(patientId, since);

  let body: ReactNode = null;
  if (query.isPending) {
    if (query.fetchStatus !== 'idle') {
      body = (
        <Box aria-busy="true">
          <Box component="span" sx={VISUALLY_HIDDEN}>
            Loading vitals…
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
          You&apos;re not authorised to view vitals. Access is controlled in
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
          Couldn&apos;t load vitals{failureDetail(failure)}.
        </Alert>
      );
    }
  } else {
    const widening = query.isPlaceholderData;
    const {newest, unplaced, partial} = read(query.data);
    body = (
      <Box aria-busy={widening}>
        {newest === undefined && !partial ? (
          <>
            <Typography color="textSecondary">
              {`No vitals have been documented since ${widening ? windowStart(now, steps - 1) : since}.`}
            </Typography>
            <Button
              disabled={widening}
              sx={{minHeight: 48, mt: 0.5}}
              onClick={() => {
                setWidened({patientId, steps: steps + 1, anchor: now});
              }}
            >
              {widening ? 'Loading older vitals…' : 'Show older vitals'}
            </Button>
          </>
        ) : null}
        {newest === undefined ? null : (
          <VitalsSet set={newest} partial={partial} />
        )}
        <CouldNotDisplay count={unplaced} />
        {partial ? <ItemNotice kind="more-not-shown" /> : null}
      </Box>
    );
  }

  return <DashboardCard title="Vitals">{body}</DashboardCard>;
}
