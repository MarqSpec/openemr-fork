import {queryOptions, useQuery, useQueryClient} from '@tanstack/react-query';

import {calendarDate, wallClock} from '../openemr_date';
import {guardSession, isSessionOver} from '../query_client';
import type {FhirItem} from './parse';
import type {PatientSearch} from './patient_search';
import {fhirKeys} from './query_keys';
import type {MedicationRequestReads} from './resources';
import type {
  Appointment,
  Immunization,
  MedicationListEntry,
  Prescription,
} from './schemas';
import {
  readOrganization,
  readPatient,
  readPractitioner,
  searchAllergies,
  searchAppointments,
  searchCareTeams,
  searchEncounters,
  searchImmunizations,
  searchLabResults,
  searchMedicationRequests,
  searchPatients,
  searchProblems,
  searchVitals,
} from './resources';

// One query per inventory row (one for API-15/16), keyed by the factory. Components use these hooks and never call `fetch`
// (NFR-CON-2). reference: INTERFACES.md API-11…21

export const patientSearchQuery = (search: PatientSearch, page: number) =>
  queryOptions({
    queryKey: fhirKeys.patientSearch(search, page),
    queryFn: guardSession('API-11', signal =>
      searchPatients(search, page, signal),
    ),
  });

export const patientQuery = (patientId: string) =>
  queryOptions({
    queryKey: fhirKeys.patientRecord(patientId),
    queryFn: guardSession('API-12', signal => readPatient(patientId, signal)),
  });

export const allergiesQuery = (patientId: string) =>
  queryOptions({
    queryKey: fhirKeys.allergies(patientId),
    queryFn: guardSession('API-13', signal =>
      searchAllergies(patientId, signal),
    ),
  });

export const problemsQuery = (patientId: string) =>
  queryOptions({
    queryKey: fhirKeys.problems(patientId),
    queryFn: guardSession('API-14', signal =>
      searchProblems(patientId, signal),
    ),
  });

/** API-24 — the Appointments card's read, from `since` (the tablet's today) on. */
export const appointmentsQuery = (patientId: string, since: string) =>
  queryOptions({
    queryKey: fhirKeys.appointments(patientId, since),
    queryFn: guardSession('API-24', signal =>
      searchAppointments(patientId, since, signal),
    ),
  });

/** One read for the Medications and Prescriptions cards; each selects and orders its own rows. */
export const medicationRequestsQuery = (patientId: string) =>
  queryOptions({
    queryKey: fhirKeys.medicationRequests(patientId),
    queryFn: guardSession('API-15/16', signal =>
      searchMedicationRequests(patientId, signal),
    ),
  });

export const careTeamsQuery = (patientId: string) =>
  queryOptions({
    queryKey: fhirKeys.careTeams(patientId),
    queryFn: guardSession('API-17', signal =>
      searchCareTeams(patientId, signal),
    ),
  });

/** API-22 — the Labs card's read. */
export const labResultsQuery = (patientId: string, since: string) =>
  queryOptions({
    queryKey: fhirKeys.labResults(patientId, since),
    queryFn: guardSession('API-22', signal =>
      searchLabResults(patientId, since, signal),
    ),
  });

export const encountersQuery = (patientId: string, since: string) =>
  queryOptions({
    queryKey: fhirKeys.encounters(patientId, since),
    queryFn: guardSession('API-20', signal =>
      searchEncounters(patientId, since, signal),
    ),
  });

export const vitalsQuery = (patientId: string, since: string) =>
  queryOptions({
    queryKey: fhirKeys.vitals(patientId, since),
    queryFn: guardSession('API-21', signal =>
      searchVitals(patientId, since, signal),
    ),
  });

/**
 * Names do not change within a session, so a practitioner is read once and shared (NFR-PERF-3): never stale, and
 * never collected when no card shows it, so a card opened again later reads nothing — nor after a refusal or failure
 * (`retryOnMount: false`; BUG-10). A 401 clears it with the rest.
 */
export const practitionerQuery = (practitionerId: string) =>
  queryOptions({
    queryKey: fhirKeys.practitioner(practitionerId),
    queryFn: guardSession('API-18', signal =>
      readPractitioner(practitionerId, signal),
    ),
    staleTime: Infinity,
    gcTime: Infinity,
    retryOnMount: false,
  });

/** Facility names are read once per session and shared (NFR-PERF-3), kept as practitioners are. */
export const organizationQuery = (organizationId: string) =>
  queryOptions({
    queryKey: fhirKeys.organization(organizationId),
    queryFn: guardSession('API-19', signal =>
      readOrganization(organizationId, signal),
    ),
    staleTime: Infinity,
    gcTime: Infinity,
    retryOnMount: false,
  });

/** API-23 — the Immunizations card's read. */
export const immunizationsQuery = (patientId: string) =>
  queryOptions({
    queryKey: fhirKeys.immunizations(patientId),
    queryFn: guardSession('API-23', signal =>
      searchImmunizations(patientId, signal),
    ),
  });

/** What a card may pass to its hook. */
export interface CardQueryOptions {
  /** The card's own gate (e.g. collapsed); it is ANDed with "session not over" and can never override it. */
  readonly enabled?: boolean;
}

/** A card's `enabled` combined with the session: after a 401 every hook stays idle (FR-AUTH-5). */
function useEnabled(options: CardQueryOptions): () => boolean {
  const client = useQueryClient();
  const wanted = options.enabled ?? true;
  return () => wanted && !isSessionOver(client);
}

export const usePatient = (patientId: string, options: CardQueryOptions = {}) =>
  useQuery({...patientQuery(patientId), enabled: useEnabled(options)});
export const useAllergies = (
  patientId: string,
  options: CardQueryOptions = {},
) => useQuery({...allergiesQuery(patientId), enabled: useEnabled(options)});
export const useProblems = (
  patientId: string,
  options: CardQueryOptions = {},
) => useQuery({...problemsQuery(patientId), enabled: useEnabled(options)});

/**
 * Soonest first by the wall-clock start OpenEMR stored, never its instant (BUG-51) — legacy's `pc_eventDate,
 * pc_startTime`; a tie keeps server order. One whose start is not a calendar date follows the dated ones, and one
 * that did not parse comes last: both kept (FR-CARD-3).
 */
function soonestFirst(items: FhirItem<Appointment>[]): FhirItem<Appointment>[] {
  const key = (item: FhirItem<Appointment>): string | undefined => {
    if (item.kind !== 'ok') return undefined;
    const start = item.resource.start;
    return calendarDate(start) === undefined
      ? ''
      : (wallClock(start) ?? calendarDate(start));
  };
  const rank = (value: string | undefined) =>
    value === undefined ? 2 : value === '' ? 1 : 0;
  return [...items].sort((a, b) => {
    const [keyA, keyB] = [key(a), key(b)];
    if (rank(keyA) !== rank(keyB)) return rank(keyA) - rank(keyB);
    if (keyA === keyB || keyA === undefined || keyB === undefined) return 0;
    return keyA < keyB ? -1 : 1;
  });
}

/** The Appointments card's read: every appointment OpenEMR sends from `since` on, soonest first. */
export const useAppointments = (
  patientId: string,
  since: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...appointmentsQuery(patientId, since),
    select: soonestFirst,
    enabled: useEnabled(options),
  });

/**
 * `intent=plan` entries first — the medication list's default, though a prescription saved as "Plan" is `plan` too
 * (BUG-13) — then every other item, one that did not parse included, each group in server order (maintainer ruling
 * ).
 */
function planFirst(
  items: FhirItem<MedicationListEntry>[],
): FhirItem<MedicationListEntry>[] {
  const isPlan = (item: FhirItem<MedicationListEntry>) =>
    item.kind === 'ok' && item.resource.intent === 'plan';
  return [...items.filter(isPlan), ...items.filter(item => !isPlan(item))];
}

const medicationListOf = (reads: MedicationRequestReads) =>
  planFirst(reads.medications);
const prescriptionListOf = (reads: MedicationRequestReads) =>
  newestFirst(reads.prescriptions);

/** The Medications card's read: API-15's half of the shared read, in the card's order. */
export const useMedicationList = (
  patientId: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...medicationRequestsQuery(patientId),
    select: medicationListOf,
    enabled: useEnabled(options),
  });
/** The Prescriptions card's read: API-16's half of the shared read, newest first. */
export const usePrescriptions = (
  patientId: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...medicationRequestsQuery(patientId),
    select: prescriptionListOf,
    enabled: useEnabled(options),
  });
export const useCareTeams = (
  patientId: string,
  options: CardQueryOptions = {},
) => useQuery({...careTeamsQuery(patientId), enabled: useEnabled(options)});
/** While a wider window loads ("Show older lab data"), the narrower answer stays — but only this patient's. */
export const useLabResults = (
  patientId: string,
  since: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...labResultsQuery(patientId, since),
    enabled: useEnabled(options),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === patientId ? previous : undefined,
  });
/**
 * While a wider window loads ("Show older"), the narrower window's encounters stay on screen — but only this
 * patient's: another patient's list is never a placeholder.
 */
export const useEncounters = (
  patientId: string,
  since: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...encountersQuery(patientId, since),
    enabled: useEnabled(options),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === patientId ? previous : undefined,
  });
/** While a wider window loads ("Show older vitals"), the narrower answer stays — but only this patient's. */
export const useVitals = (
  patientId: string,
  since: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...vitalsQuery(patientId, since),
    enabled: useEnabled(options),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === patientId ? previous : undefined,
  });
export const usePractitioner = (
  practitionerId: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...practitionerQuery(practitionerId),
    enabled: useEnabled(options),
  });
export const useOrganization = (
  organizationId: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...organizationQuery(organizationId),
    enabled: useEnabled(options),
  });

/** The Immunizations card's read: one row per immunization, newest first (legacy's `administered_date DESC`). */
export const useImmunizations = (
  patientId: string,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...immunizationsQuery(patientId),
    select: immunizationsNewestFirst,
    enabled: useEnabled(options),
  });

/** A date's wall-clock key, never its instant (KNOWN_BUGS BUG-51); `''` when absent or unreadable, so it sorts last. */
function keyOf(value: string | undefined): string {
  return wallClock(value) ?? '';
}

/**
 * The legacy Prescriptions order (`Prescription::prescriptions_factory`: date modified, then date added, newest
 * first) — `meta.lastUpdated`, then `authoredOn`. Undated items and ones that did not parse keep server order after.
 */
function newestFirst(
  items: FhirItem<Prescription>[],
): FhirItem<Prescription>[] {
  const keys = (item: FhirItem<Prescription>): [string, string] =>
    item.kind === 'ok'
      ? [
          keyOf(item.resource.meta?.lastUpdated),
          keyOf(item.resource.authoredOn),
        ]
      : ['', ''];
  return [...items].sort((a, b) => {
    const [modifiedA, addedA] = keys(a);
    const [modifiedB, addedB] = keys(b);
    if (modifiedA !== modifiedB) return modifiedA > modifiedB ? -1 : 1;
    if (addedA !== addedB) return addedA > addedB ? -1 : 1;
    return 0;
  });
}

export const usePatientSearch = (
  search: PatientSearch,
  page: number,
  options: CardQueryOptions = {},
) =>
  useQuery({
    ...patientSearchQuery(search, page),
    enabled: useEnabled(options),
  });

/**
 * Each immunization once — OpenEMR can repeat one under the same id (BUG-60), and when the repeats disagree on the
 * vaccine's name it keeps only the code, since any of them may be another code type's text — newest first by the administered date
 * as recorded, never its instant (BUG-51). One with no date, or a date that is not a calendar date, follows the dated
 * ones, as MySQL puts a NULL last in legacy's `ORDER BY administered_date DESC`; ones that did not parse come last.
 */
function immunizationsNewestFirst(
  items: FhirItem<Immunization>[],
): FhirItem<Immunization>[] {
  const byId = new Map<string, Immunization[]>();
  for (const item of items) {
    if (item.kind !== 'ok') continue;
    const repeats = byId.get(item.resource.id) ?? [];
    repeats.push(item.resource);
    byId.set(item.resource.id, repeats);
  }
  const once: FhirItem<Immunization>[] = [];
  for (const item of items) {
    if (item.kind !== 'ok') {
      once.push(item);
      continue;
    }
    const repeats = byId.get(item.resource.id);
    if (repeats === undefined) continue;
    byId.delete(item.resource.id);
    once.push({...item, resource: oneOf(repeats, item.resource)});
  }
  const key = (item: FhirItem<Immunization>): string | undefined => {
    if (item.kind !== 'ok') return undefined;
    const recorded = item.resource.occurrenceDateTime;
    return calendarDate(recorded) === undefined ? '' : keyOf(recorded);
  };
  return [...once].sort((a, b) => {
    const [keyA, keyB] = [key(a), key(b)];
    if (keyA === keyB) return 0;
    if (keyA === undefined) return 1;
    if (keyB === undefined) return -1;
    return keyA > keyB ? -1 : 1;
  });
}

/**
 * One immunization from its repeats: they differ only by what OpenEMR's code-value join matched (BUG-60), so when their
 * vaccine names disagree none can be trusted, and the vaccine is its codes without a name ("CVX {code}").
 */
function oneOf(repeats: Immunization[], first: Immunization): Immunization {
  const named = (immunization: Immunization) =>
    JSON.stringify([
      immunization.vaccineCode.text,
      (immunization.vaccineCode.coding ?? []).map(coding => coding.display),
    ]);
  if (repeats.every(repeat => named(repeat) === named(first))) return first;
  return {
    ...first,
    vaccineCode: {
      coding: (first.vaccineCode.coding ?? []).map(({system, code}) => ({
        ...(system === undefined ? {} : {system}),
        ...(code === undefined ? {} : {code}),
      })),
    },
  };
}
