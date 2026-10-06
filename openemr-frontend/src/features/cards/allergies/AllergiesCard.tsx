import Box from '@mui/material/Box';
import type {ReactNode} from 'react';

import {useAllergies} from '../../../api/fhir/hooks';
import type {AllergyIntolerance} from '../../../api/fhir/schemas';
import {CardItems} from '../CardItems';
import {DashboardCard} from '../DashboardCard';

// Item detail (FR-CARD-6, W-12) and Open in OpenEMR (FR-CARD-EDIT-1) are P1, not this card's.
// reference: REQUIREMENTS.md FR-CARD-ALG-1, FR-CARD-4 · INTERFACES.md API-13 ·
// REQUIREMENTS.md SCR-DASH-ALG · REQUIREMENTS.md BUG-41, BUG-45

const CLINICAL_STATUS =
  'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const DATA_ABSENT = 'http://terminology.hl7.org/CodeSystem/data-absent-reason';

/** OpenEMR's narrative: `<div xmlns='…'>` + the raw list title + `</div>` (UtilsService::createNarrative). */
const NARRATIVE = /^\s*<div\b[^>]*>([\s\S]*)<\/div>\s*$/;

/**
 * Hidden only when OpenEMR says `resolved` — Outcome "Resolved" with an end date, which legacy always hides
 * (demographics.php filterActiveIssues). `inactive` is any other end date, future or past, and the date is not
 * sent, so it is shown; so is an allergy with no status (BUG-45: err toward showing).
 */
function isListed(allergy: AllergyIntolerance): boolean {
  return !(allergy.clinicalStatus?.coding ?? []).some(
    coding => coding.system === CLINICAL_STATUS && coding.code === 'resolved',
  );
}

/** The legacy row's `title`: OpenEMR's list title from the narrative, shown literally as legacy escapes it. */
function titleOf(allergy: AllergyIntolerance): string {
  const narrative = NARRATIVE.exec(allergy.text?.div ?? '')?.[1]?.trim();
  if (narrative !== undefined && narrative !== '') return narrative;
  const text = allergy.code?.text?.trim();
  if (text !== undefined && text !== '') return text;
  return (
    allergy.code?.coding?.find(
      coding => coding.system !== DATA_ABSENT && (coding.display ?? '') !== '',
    )?.display ?? 'Unnamed allergy'
  );
}

/** FR-CARD-ALG-1's words for the four wire cases; absent (no severity recorded) has no label, never "low". */
function criticalityLabel(allergy: AllergyIntolerance): string | undefined {
  switch (allergy.criticality) {
    case 'high':
      return 'high criticality';
    case 'low':
      return 'low criticality';
    case 'unable-to-assess':
      return 'criticality not assessed';
    case undefined:
      return undefined;
  }
}

type Concept = NonNullable<
  AllergyIntolerance['reaction']
>[number]['manifestation'][number];

function conceptText(concept: Concept): string {
  const text = concept.text?.trim() ?? '';
  if (text !== '') return text;
  return (
    concept.coding
      ?.find(coding => (coding.display ?? '').trim() !== '')
      ?.display?.trim() ?? ''
  );
}

/** Reaction manifestations, which legacy puts in the row's tooltip (SCR-DASH-ALG). */
function reactionOf(allergy: AllergyIntolerance): string {
  return (allergy.reaction ?? [])
    .flatMap(reaction => reaction.manifestation)
    .map(conceptText)
    .filter(text => text !== '')
    .join(', ');
}

function AllergyRow(props: {allergy: AllergyIntolerance}): ReactNode {
  const {allergy} = props;
  const label = criticalityLabel(allergy);
  const reaction = reactionOf(allergy);
  const high = allergy.criticality === 'high';
  return (
    <>
      <Box
        component="span"
        sx={
          high
            ? {
                bgcolor: 'warning.main',
                color: 'warning.contrastText',
                fontWeight: 700,
                px: 0.5,
              }
            : undefined
        }
      >
        {label === undefined
          ? titleOf(allergy)
          : `${titleOf(allergy)} (${label})`}
      </Box>
      {reaction === '' ? null : (
        <Box sx={{color: 'text.secondary', fontSize: '0.875rem'}}>
          {reaction}
        </Box>
      )}
    </>
  );
}

export interface AllergiesCardProps {
  readonly patientId: string;
}

/** The Allergies card (SCR-DASH-ALG): the allergies legacy lists, title, criticality and reaction. */
export function AllergiesCard(props: AllergiesCardProps): ReactNode {
  const query = useAllergies(props.patientId);
  return (
    <DashboardCard title="Allergies">
      <CardItems
        query={query}
        subject="allergies"
        emptyText="Nothing Recorded"
        include={isListed}
        renderItem={allergy => <AllergyRow allergy={allergy} />}
      />
    </DashboardCard>
  );
}
