import Box from '@mui/material/Box';
import type {ReactNode} from 'react';

import {usePrescriptions} from '../../../api/fhir/hooks';
import type {Prescription} from '../../../api/fhir/schemas';
import {wallClockDate} from '../../../api/openemr_date';
import {CardItems} from '../CardItems';
import {DashboardCard} from '../DashboardCard';
import {NameUnavailable, ReferenceName} from '../ReferenceName';

// reference: REQUIREMENTS.md FR-CARD-RX-1, FR-CARD-3, FR-CARD-4 · INTERFACES.md API-16,
// API-18 · REQUIREMENTS.md SCR-DASH-RX · REQUIREMENTS.md BUG-10, BUG-13, BUG-48, BUG-51 · a separate change (and the rulings)

const MISSING = '—';

/** R4 intents in plain words; `order` — this card's own intent — has no label, and a code outside R4 is shown as sent. */
const INTENT_WORDS: ReadonlyMap<string, string> = new Map([
  ['proposal', 'Proposal'],
  ['plan', 'Plan'],
  ['original-order', 'Original order'],
  ['reflex-order', 'Reflex order'],
  ['filler-order', 'Filler order'],
  ['instance-order', 'Instance order'],
  ['option', 'Option'],
]);

const STATUS_WORDS: ReadonlyMap<string, string> = new Map([
  ['active', 'Active'],
  // Active in OpenEMR with an end date, past or to come; legacy lists it (BUG-48).
  [
    'completed',
    'Completed — it has an end date, which may still be to come. Check it in OpenEMR.',
  ],
]);

const CHECK_IN_OPENEMR = 'check in OpenEMR';

/**
 * What only a prescription carries: OpenEMR selects no quantity, route, timing or dose for a medication-list entry
 * (PrescriptionService), so an entry with any of them came from the `prescriptions` table.
 */
function hasDispensingDetails(rx: Prescription): boolean {
  return (
    rx.dispenseRequest?.quantity !== undefined ||
    (rx.dosageInstruction ?? []).some(
      dosage =>
        dosage.route !== undefined ||
        dosage.timing !== undefined ||
        (dosage.doseAndRate ?? []).length > 0,
    )
  );
}

/**
 * Legacy lists every prescription whose `active` is 1, which OpenEMR sends as any status but `stopped`. An
 * `intent=plan` entry with no dispensing details is a medication-list entry — the Medications card's (BUG-13).
 */
function isShown(rx: Prescription): boolean {
  if (rx.status === 'stopped') return false;
  return rx.intent !== 'plan' || hasDispensingDetails(rx);
}

function drugOf(rx: Prescription): string {
  const concept = rx.medicationCodeableConcept;
  const text = concept?.text?.trim();
  if (text !== undefined && text !== '') return text;
  return (
    concept?.coding?.find(coding => (coding.display ?? '') !== '')?.display ??
    'Untitled prescription'
  );
}

/** Legacy Details is the dosage then the interval; route is not shown and OpenEMR truncates the strength (BUG-48). */
function sigOf(rx: Prescription): string {
  const sig = (rx.dosageInstruction ?? [])
    .map(dosage =>
      [dosage.text, dosage.timing?.code?.text]
        .map(part => part?.trim() ?? '')
        .filter(part => part !== '')
        .join(' '),
    )
    .filter(text => text !== '')
    .join('; ');
  return sig === '' ? MISSING : sig;
}

/**
 * Never a bare number: legacy Quantity is free text and OpenEMR sends `intval()` of it, so "8.5" arrives as 8 and
 * "0.5" as 0, and a non-numeric one not at all. The unit is the drug's strength unit, so it is left off (BUG-48).
 */
function quantityOf(rx: Prescription): string {
  const value = rx.dispenseRequest?.quantity?.value;
  if (value === undefined || value <= 0) return CHECK_IN_OPENEMR;
  return `${String(value)} (whole number; ${CHECK_IN_OPENEMR})`;
}

/** OpenEMR always sends 0 refills (BUG-48), so 0 is never shown as "none". */
function refillsOf(rx: Prescription): string {
  const refills = rx.dispenseRequest?.numberOfRepeatsAllowed ?? 0;
  return refills > 0 ? String(refills) : CHECK_IN_OPENEMR;
}

/** The prescriber's name through the cards' shared resolver: API-18 only, which needs admin/users (BUG-10). */
function Prescriber(props: {rx: Prescription}): ReactNode {
  const {requester} = props.rx;
  if (requester === undefined) return <NameUnavailable />;
  // OpenEMR names the organization when the prescriber has no NPI; there is no read for it here.
  return (
    <ReferenceName
      reference={requester}
      readable={['Practitioner']}
      what="prescriber"
    />
  );
}

function Field(props: {label: string; children: ReactNode}): ReactNode {
  return (
    <span>
      <Box component="span" sx={{color: 'text.secondary'}}>
        {props.label}:{' '}
      </Box>
      {props.children}
    </span>
  );
}

function Label(props: {children: ReactNode}): ReactNode {
  return <Box sx={{color: 'text.secondary'}}>{props.children}</Box>;
}

function PrescriptionRow(props: {rx: Prescription}): ReactNode {
  const {rx} = props;
  return (
    <>
      <Box component="span" sx={{fontWeight: 700}}>
        {drugOf(rx)}
      </Box>
      {rx.intent === 'order' ? null : (
        <Label>Intent: {INTENT_WORDS.get(rx.intent) ?? rx.intent}</Label>
      )}
      {hasDispensingDetails(rx) ? null : (
        <Label>
          May be a medication-list entry: OpenEMR sent no dispensing details
        </Label>
      )}
      <Box sx={{display: 'flex', flexWrap: 'wrap', columnGap: 2}}>
        <Field label="Sig">{sigOf(rx)}</Field>
        <Field label="Qty">{quantityOf(rx)}</Field>
        <Field label="Refills">{refillsOf(rx)}</Field>
        <Field label="Prescriber">
          <Prescriber rx={rx} />
        </Field>
        <Field label="Date">{wallClockDate(rx.authoredOn) ?? MISSING}</Field>
        <Field label="Status">{STATUS_WORDS.get(rx.status) ?? rx.status}</Field>
      </Box>
    </>
  );
}

export interface PrescriptionsCardProps {
  readonly patientId: string;
}

/**
 * The Prescriptions card (SCR-DASH-RX): the legacy columns — drug, sig, quantity, refills, date — plus prescriber
 * and status, newest first. It reads every intent and keeps what may be a prescription; rows also appear on the
 * Medications card, which FHIR cannot prevent (BUG-13, accepted).
 */
export function PrescriptionsCard(props: PrescriptionsCardProps): ReactNode {
  const query = usePrescriptions(props.patientId);
  return (
    <DashboardCard title="Prescriptions">
      <CardItems
        query={query}
        subject="prescriptions"
        emptyText="None"
        include={isShown}
        renderItem={rx => <PrescriptionRow rx={rx} />}
      />
    </DashboardCard>
  );
}
