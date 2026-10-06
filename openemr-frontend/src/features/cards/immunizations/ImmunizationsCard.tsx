import Box from '@mui/material/Box';
import type {ReactNode} from 'react';

import {useImmunizations} from '../../../api/fhir/hooks';
import type {Immunization} from '../../../api/fhir/schemas';
import {calendarDate} from '../../../api/openemr_date';
import {CardItems} from '../CardItems';
import {DashboardCard} from '../DashboardCard';

// Item detail (FR-CARD-6) and Open in OpenEMR (FR-CARD-EDIT-1) are P1 issues of their own, not this card's.
// reference: REQUIREMENTS.md FR-CARD-IMM-1, FR-CARD-3, FR-CARD-4 · INTERFACES.md API-23 ·
// REQUIREMENTS.md SCR-DASH-IMM · REQUIREMENTS.md BUG-51, BUG-59, BUG-60

const CVX = 'http://hl7.org/fhir/sid/cvx';

/**
 * OpenEMR's `not-done` covers Refused, Not Administered, Partially Administered and a completion status never set, so
 * it does not mean "not given" — only that the record is not marked Completed (BUG-59).
 */
const NOT_DONE =
  'Not marked completed in OpenEMR: may have been refused, not given, or not recorded';

const trimmed = (value: string | undefined): string => value?.trim() ?? '';

/**
 * Legacy lists every immunization but one added in error (`added_erroneously = 0`), which OpenEMR sends as
 * `entered-in-error`; a `not-done` one is listed, as legacy lists it (BUG-59: err toward showing).
 */
function isListed(immunization: Immunization): boolean {
  return immunization.status !== 'entered-in-error';
}

/**
 * The vaccine's name: OpenEMR's CVX name (the coding's display — legacy shows the short CVX name, OpenEMR sends the
 * long one), else its CVX code; `undefined` when no CVX code was recorded and OpenEMR sent no vaccine at all (BUG-60).
 */
function vaccineName(immunization: Immunization): string | undefined {
  const concept = immunization.vaccineCode;
  const text = trimmed(concept.text);
  if (text !== '') return text;
  const codings = [...(concept.coding ?? [])].sort(
    (a, b) => Number(b.system === CVX) - Number(a.system === CVX),
  );
  const display = codings
    .map(coding => trimmed(coding.display))
    .find(value => value !== '');
  if (display !== undefined) return display;
  const coded = codings.find(coding => trimmed(coding.code) !== '');
  if (coded === undefined) return undefined;
  const code = trimmed(coded.code);
  return coded.system === CVX ? `CVX ${code}` : code;
}

/** The administered date as recorded, never shifted by its offset (BUG-51). */
function administered(immunization: Immunization): string {
  const recorded = immunization.occurrenceDateTime;
  if (trimmed(recorded) === '') return 'Date not recorded';
  return calendarDate(recorded) ?? 'Date unreadable; check OpenEMR';
}

function ImmunizationRow(props: {immunization: Immunization}): ReactNode {
  const {immunization} = props;
  const name = vaccineName(immunization);
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
            Vaccine name not sent by OpenEMR
          </Box>
        ) : (
          <span>{name}</span>
        )}{' '}
        <Box
          component="span"
          sx={{color: 'text.secondary', whiteSpace: 'nowrap'}}
        >
          {administered(immunization)}
        </Box>
      </Box>
      {immunization.status === 'not-done' ? (
        <Box sx={{fontSize: '0.875rem', fontWeight: 700}}>{NOT_DONE}</Box>
      ) : null}
    </>
  );
}

export interface ImmunizationsCardProps {
  readonly patientId: string;
}

/**
 * The Immunizations card (SCR-DASH-IMM): every immunization legacy lists, newest first, each its vaccine and — as
 * FR-CARD-IMM-1 adds to legacy's name-only rows — its administered date.
 */
export function ImmunizationsCard(props: ImmunizationsCardProps): ReactNode {
  const query = useImmunizations(props.patientId);
  return (
    <DashboardCard title="Immunizations">
      <CardItems
        query={query}
        subject="immunizations"
        emptyText="None"
        include={isListed}
        renderItem={immunization => (
          <ImmunizationRow immunization={immunization} />
        )}
      />
    </DashboardCard>
  );
}
