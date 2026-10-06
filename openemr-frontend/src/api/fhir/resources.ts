import {ApiError} from '../api_error';
import type {ApiId} from '../api_error';
import type {FhirItem} from './parse';
import {parseRead, parseSearchBundle} from './parse';
import {PATIENT_PAGE_SIZE, type PatientSearch} from './patient_search';
import {
  FHIR_ID,
  allergyIntoleranceSchema,
  appointmentSchema,
  careTeamSchema,
  conditionSchema,
  encounterSchema,
  immunizationSchema,
  labResultSchema,
  medicationListEntrySchema,
  observationSchema,
  organizationSchema,
  patientSchema,
  practitionerSchema,
  prescriptionSchema,
} from './schemas';
import type {
  AllergyIntolerance,
  Appointment,
  CareTeam,
  Condition,
  Encounter,
  Immunization,
  LabResult,
  MedicationListEntry,
  Observation,
  Organization,
  Patient,
  Practitioner,
  Prescription,
} from './schemas';
import {fhirGet} from './transport';

// One function per inventory row (API-15 and API-16 send the same search, so they share one); each sends exactly the
// search INTERFACES.md specifies and nothing else. Client-side filtering (active status, sort order) belongs
// to the card. reference: API-11…21

type Signal = AbortSignal | undefined;

/** Parses a caller's id before it reaches a path or a query: invalid → `invalid-id`, and nothing is sent. */
function fhirId(apiId: ApiId, value: string): string {
  if (!FHIR_ID.test(value) || value === '.' || value === '..') {
    throw new ApiError({kind: 'invalid-id', apiId});
  }
  return value;
}

/** One page of a patient search; `hasMore` says whether a next page exists (OpenEMR sends no `next` link — BUG-7). */
export interface PatientSearchPage {
  readonly items: FhirItem<Patient>[];
  readonly hasMore: boolean;
}

/**
 * API-11 — patient search, page `page` (from 0). Asks for one row more than a page to learn whether another page
 * exists, since `total` only counts what was returned (BUG-7). Only the fields the clinician filled are sent.
 */
export async function searchPatients(
  search: PatientSearch,
  page: number,
  signal?: Signal,
): Promise<PatientSearchPage> {
  const params: Record<string, string> = {};
  if (search.name !== undefined) params.name = search.name;
  if (search.birthDate !== undefined) params.birthdate = search.birthDate;
  if (search.mrn !== undefined) params.identifier = search.mrn;
  params._count = String(PATIENT_PAGE_SIZE + 1);
  params._offset = String(page * PATIENT_PAGE_SIZE);
  const json = await fhirGet({
    apiId: 'API-11',
    path: 'Patient',
    params,
    signal,
  });
  // The page has its own "more": the extra row, or the server's own cue — never a row of its own.
  const parsed = parseSearchBundle('API-11', patientSchema, json);
  const items = parsed.filter(item => item.kind !== 'more-not-shown');
  return {
    items: items.slice(0, PATIENT_PAGE_SIZE),
    hasMore: items.length > PATIENT_PAGE_SIZE || items.length < parsed.length,
  };
}

/** API-12 — the patient header. */
export async function readPatient(
  patientId: string,
  signal?: Signal,
): Promise<FhirItem<Patient>> {
  const json = await fhirGet({
    apiId: 'API-12',
    path: `Patient/${fhirId('API-12', patientId)}`,
    signal,
  });
  return parseRead('API-12', patientSchema, json);
}

/** API-13 — allergies; only `patient` is searchable, so inactive ones arrive too (BUG-8). */
export async function searchAllergies(
  patientId: string,
  signal?: Signal,
): Promise<FhirItem<AllergyIntolerance>[]> {
  const json = await fhirGet({
    apiId: 'API-13',
    path: 'AllergyIntolerance',
    params: {patient: fhirId('API-13', patientId)},
    signal,
  });
  return parseSearchBundle('API-13', allergyIntoleranceSchema, json);
}

/** API-14 — problem list; `category` separates problems from encounter diagnoses (BUG-8). */
export async function searchProblems(
  patientId: string,
  signal?: Signal,
): Promise<FhirItem<Condition>[]> {
  const json = await fhirGet({
    apiId: 'API-14',
    path: 'Condition',
    params: {
      patient: fhirId('API-14', patientId),
      category: 'problem-list-item',
    },
    signal,
  });
  return parseSearchBundle('API-14', conditionSchema, json);
}

/**
 * API-24 — the patient's appointments from `since` (`YYYY-MM-DD`, the tablet's today) on. OpenEMR searches `date` on
 * `pc_eventDate` and cannot page (BUG-7, BUG-31); the card orders and limits.
 */
export async function searchAppointments(
  patientId: string,
  since: string,
  signal?: Signal,
): Promise<FhirItem<Appointment>[]> {
  const json = await fhirGet({
    apiId: 'API-24',
    path: 'Appointment',
    params: {patient: fhirId('API-24', patientId), date: `ge${since}`},
    signal,
  });
  return parseSearchBundle('API-24', appointmentSchema, json);
}

/** API-15/16 — one MedicationRequest read, parsed once for each card that shows it. */
export interface MedicationRequestReads {
  /** API-15, the Medications card. */
  readonly medications: FhirItem<MedicationListEntry>[];
  /** API-16, the Prescriptions card. */
  readonly prescriptions: FhirItem<Prescription>[];
}

/**
 * API-15/16 — every MedicationRequest of every intent, read once for the Medications and Prescriptions cards.
 * `intent` cannot tell a list entry from a prescription, so none is filtered out; each card picks its own rows (BUG-13,
 * rulings). Each entry is parsed with each card's schema, so one card never loses a row to the other's.
 */
export async function searchMedicationRequests(
  patientId: string,
  signal?: Signal,
): Promise<MedicationRequestReads> {
  const json = await fhirGet({
    apiId: 'API-15/16',
    path: 'MedicationRequest',
    params: {patient: fhirId('API-15/16', patientId)},
    signal,
  });
  return {
    medications: parseSearchBundle(
      'API-15/16',
      medicationListEntrySchema,
      json,
    ),
    prescriptions: parseSearchBundle('API-15/16', prescriptionSchema, json),
  };
}

/** API-17 — care teams. */
export async function searchCareTeams(
  patientId: string,
  signal?: Signal,
): Promise<FhirItem<CareTeam>[]> {
  const json = await fhirGet({
    apiId: 'API-17',
    path: 'CareTeam',
    params: {patient: fhirId('API-17', patientId)},
    signal,
  });
  return parseSearchBundle('API-17', careTeamSchema, json);
}

/**
 * API-23 — every immunization of the patient, as legacy lists them: OpenEMR searches Immunization by `patient`, `_id`
 * and `_lastUpdated` only, so there is no date or status to narrow by; the card orders and filters.
 */
export async function searchImmunizations(
  patientId: string,
  signal?: Signal,
): Promise<FhirItem<Immunization>[]> {
  const json = await fhirGet({
    apiId: 'API-23',
    path: 'Immunization',
    params: {patient: fhirId('API-23', patientId)},
    signal,
  });
  return parseSearchBundle('API-23', immunizationSchema, json);
}

/** API-18 — a practitioner, for a name (needs `admin/users` — BUG-10). */
export async function readPractitioner(
  practitionerId: string,
  signal?: Signal,
): Promise<FhirItem<Practitioner>> {
  const json = await fhirGet({
    apiId: 'API-18',
    path: `Practitioner/${fhirId('API-18', practitionerId)}`,
    signal,
  });
  return parseRead('API-18', practitionerSchema, json);
}

/** API-19 — an organization, for a facility name (needs `admin/users` — BUG-10). */
export async function readOrganization(
  organizationId: string,
  signal?: Signal,
): Promise<FhirItem<Organization>> {
  const json = await fhirGet({
    apiId: 'API-19',
    path: `Organization/${fhirId('API-19', organizationId)}`,
    signal,
  });
  return parseRead('API-19', organizationSchema, json);
}

/**
 * API-22 — lab results reported on or after `since` (a FHIR date, `YYYY-MM-DD`). Without a date bound OpenEMR returns
 * the whole history (BUG-36), and the bound is the only limit it honours (BUG-7), so "Show older lab data" passes an
 * earlier `since`; no `code` is sent — the card shows every test, and the token handler admits nothing else.
 */
export async function searchLabResults(
  patientId: string,
  since: string,
  signal?: Signal,
): Promise<FhirItem<LabResult>[]> {
  const json = await fhirGet({
    apiId: 'API-22',
    path: 'Observation',
    params: {
      patient: fhirId('API-22', patientId),
      category: 'laboratory',
      date: `ge${since}`,
    },
    signal,
  });
  return parseSearchBundle('API-22', labResultSchema, json);
}

/**
 * API-20 — encounters on or after `since` (a FHIR date, `YYYY-MM-DD`). The date bound is the only way to limit
 * the result: `_count`, `_offset` and `_sort` do nothing here (BUG-7); "Show more" passes an earlier `since`.
 * Never `Encounter/{id}`, which needs `admin/super` (BUG-9).
 */
export async function searchEncounters(
  patientId: string,
  since: string,
  signal?: Signal,
): Promise<FhirItem<Encounter>[]> {
  const json = await fhirGet({
    apiId: 'API-20',
    path: 'Encounter',
    params: {patient: fhirId('API-20', patientId), date: `ge${since}`},
    signal,
  });
  return parseSearchBundle('API-20', encounterSchema, json);
}

/**
 * API-21 — vital signs recorded on or after `since` (a FHIR date, `YYYY-MM-DD`). As with API-20 the date bound is the
 * only limit OpenEMR honours (BUG-7), so "Show older vitals" passes an earlier `since`; no `code` is sent — the card
 * shows every vital of the newest set, and the token handler admits nothing else.
 */
export async function searchVitals(
  patientId: string,
  since: string,
  signal?: Signal,
): Promise<FhirItem<Observation>[]> {
  const json = await fhirGet({
    apiId: 'API-21',
    path: 'Observation',
    params: {
      patient: fhirId('API-21', patientId),
      category: 'vital-signs',
      date: `ge${since}`,
    },
    signal,
  });
  return parseSearchBundle('API-21', observationSchema, json);
}
