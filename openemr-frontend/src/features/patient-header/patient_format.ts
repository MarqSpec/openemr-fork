import type {Patient} from '../../api/fhir/schemas';
import {wallClockDate} from '../../api/openemr_date';

// Pure formatting for the patient header: each returns `undefined` for "not recorded", which the header renders
// as "—" with an accessible label (FR-HDR-3). reference: INTERFACES.md API-12

type HumanName = NonNullable<Patient['name']>[number];
type Identifier = NonNullable<Patient['identifier']>[number];

const V2_0203 = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const US_CORE_BIRTHSEX =
  'http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex';
const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

const GENDER_LABELS: Readonly<Record<NonNullable<Patient['gender']>, string>> =
  {
    female: 'Female',
    male: 'Male',
    other: 'Other',
    unknown: 'Unknown',
  };

const BIRTHSEX_LABELS: Readonly<Record<string, string>> = {
  F: 'Female',
  M: 'Male',
  UNK: 'Unknown',
};

/** The patient's status, from `deceased[x]` only; `active` merely mirrors it (BUG-6). */
export type PatientStatus =
  | {readonly kind: 'active'}
  | {readonly kind: 'deceased'; readonly date: string | undefined};

/**
 * Whole years from `birthDate` to the calendar date of `on` (a FHIR date or dateTime, read as written — no
 * time-zone shift). Needs a full date of birth; a partial one or a birth after `on` gives no age. A 29 February
 * birthday falls on 1 March in a common year.
 */
export function ageOn(
  birthDate: string | undefined,
  on: string | undefined,
): number | undefined {
  const birth = FULL_DATE.exec(birthDate ?? '');
  const day = FULL_DATE.exec(on ?? '');
  if (birth === null || day === null) return undefined;
  const [by, bm, bd] = birth.slice(1).map(Number) as [number, number, number];
  const [y, m, d] = day.slice(1).map(Number) as [number, number, number];
  const hadBirthday = m > bm || (m === bm && d >= bd);
  const age = y - by - (hadBirthday ? 0 : 1);
  return age >= 0 ? age : undefined;
}

function nameText(name: HumanName): string | undefined {
  const parts = [...(name.given ?? []), name.family ?? '']
    .map(part => part.trim())
    .filter(part => part !== '');
  const text = parts.length > 0 ? parts.join(' ') : (name.text?.trim() ?? '');
  return text === '' ? undefined : text;
}

/** The official name, else the usual one, else the first that is not an old name: given names, then family. */
export function displayName(
  names: readonly HumanName[] | undefined,
): string | undefined {
  const current = (names ?? []).filter(name => name.use !== 'old');
  const chosen =
    current.find(name => name.use === 'official') ??
    current.find(name => name.use === 'usual') ??
    current[0];
  return chosen === undefined ? undefined : nameText(chosen);
}

/** `gender`, falling back to the US Core birth-sex extension. */
export function sexLabel(patient: Patient): string | undefined {
  if (patient.gender !== undefined) return GENDER_LABELS[patient.gender];
  const birthSex = patient.extension?.find(
    ext => ext.url === US_CORE_BIRTHSEX,
  )?.valueCode;
  return birthSex === undefined ? undefined : BIRTHSEX_LABELS[birthSex];
}

function isMrn(identifier: Identifier): boolean {
  return (
    identifier.type?.coding?.some(
      coding => coding.system === V2_0203 && coding.code === 'PT',
    ) ?? false
  );
}

/** The MRN: the first non-blank value of an identifier typed `v2-0203|PT` (OpenEMR's `pubpid`). */
export function mrnOf(
  identifiers: readonly Identifier[] | undefined,
): string | undefined {
  return (identifiers ?? [])
    .filter(isMrn)
    .map(identifier => identifier.value?.trim() ?? '')
    .find(value => value !== '');
}

/**
 * Deceased from `deceasedDateTime` (with the calendar date OpenEMR recorded, never shifted — BUG-51) or
 * `deceasedBoolean`; otherwise active.
 */
export function patientStatus(patient: Patient): PatientStatus {
  if (patient.deceasedDateTime !== undefined) {
    return {kind: 'deceased', date: wallClockDate(patient.deceasedDateTime)};
  }
  return patient.deceasedBoolean === true
    ? {kind: 'deceased', date: undefined}
    : {kind: 'active'};
}
