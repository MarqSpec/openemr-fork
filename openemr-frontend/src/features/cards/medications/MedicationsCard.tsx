import Box from '@mui/material/Box';
import type {ReactNode} from 'react';

import {useMedicationList} from '../../../api/fhir/hooks';
import type {MedicationListEntry} from '../../../api/fhir/schemas';
import {CardItems} from '../CardItems';
import {DashboardCard} from '../DashboardCard';

// reference: REQUIREMENTS.md FR-CARD-MED-1, FR-CARD-3, FR-CARD-4 · INTERFACES.md API-15 ·
// REQUIREMENTS.md SCR-DASH-MED · REQUIREMENTS.md BUG-13, BUG-44 · a separate change (maintainer rulings)

/** R4 intents in plain words; `plan` has no label, and a code outside R4 is shown as sent. */
const INTENT_WORDS: ReadonlyMap<string, string> = new Map([
  ['proposal', 'Proposal'],
  ['original-order', 'Original order'],
  ['reflex-order', 'Reflex order'],
  ['filler-order', 'Filler order'],
  ['instance-order', 'Instance order'],
  ['option', 'Option'],
]);

function intentLabel(intent: string): string | undefined {
  if (intent === 'plan') return undefined;
  // An order may be a list entry saved with the Add form's default intent or a prescription; FHIR cannot say which.
  if (intent === 'order')
    return 'Order — may also be listed under Prescriptions';
  return `Intent: ${INTENT_WORDS.get(intent) ?? intent}`;
}

function nameOf(medication: MedicationListEntry): string {
  const concept = medication.medicationCodeableConcept;
  const text = concept?.text?.trim();
  if (text !== undefined && text !== '') return text;
  return (
    concept?.coding?.find(coding => (coding.display ?? '') !== '')?.display ??
    'Untitled medication'
  );
}

function instructionsOf(medication: MedicationListEntry): string {
  return (medication.dosageInstruction ?? [])
    .map(dosage => dosage.text?.trim() ?? '')
    .filter(text => text !== '')
    .join('; ');
}

function MedicationRow(props: {medication: MedicationListEntry}): ReactNode {
  const {medication} = props;
  const instructions = instructionsOf(medication);
  const label = intentLabel(medication.intent);
  return (
    <>
      <span>{nameOf(medication)}</span>
      {label === undefined ? null : (
        <Box sx={{color: 'text.secondary'}}>{label}</Box>
      )}
      {instructions === '' ? null : (
        <Box sx={{color: 'text.secondary'}}>{instructions}</Box>
      )}
      {/* OpenEMR sends no end date; any status but "active" may mean one has passed (BUG-44). */}
      {medication.status === 'active' ? null : (
        <Box sx={{color: 'text.secondary', fontStyle: 'italic'}}>
          May have ended (OpenEMR status: {medication.status}). Check its end
          date in OpenEMR.
        </Box>
      )}
    </>
  );
}

export interface MedicationsCardProps {
  readonly patientId: string;
}

/**
 * The Medications card (SCR-DASH-MED): name then dosage instructions for every MedicationRequest — `intent=plan`
 * entries first, then the rest, each labelled with its intent, in server order. Every entry is shown whatever its
 * status — legacy filters on an end date OpenEMR's FHIR does not send (BUG-44).
 */
export function MedicationsCard(props: MedicationsCardProps): ReactNode {
  const query = useMedicationList(props.patientId);
  return (
    <DashboardCard title="Medications">
      <CardItems
        query={query}
        subject="medications"
        emptyText="Nothing Recorded"
        renderItem={medication => <MedicationRow medication={medication} />}
      />
    </DashboardCard>
  );
}
