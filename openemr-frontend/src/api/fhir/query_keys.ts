import type {PatientSearch} from './patient_search';

// The one TanStack Query key factory for FHIR reads. Everything about a patient sits under
// `fhirKeys.patient(id)`, so invalidating that prefix refreshes every card for the patient (FR-CARD-5);
// practitioners and organizations are shared across patients and cards (NFR-PERF-3).
// reference: CONVENTIONS.md (one key factory per API surface)

export const fhirKeys = {
  all: ['fhir'] as const,
  /** Search terms live only in this in-memory key — never in a URL, storage or a log (NFR-SEC-6). */
  patientSearch: (search: PatientSearch, page: number) =>
    [
      'fhir',
      'patient-search',
      {name: search.name, birthDate: search.birthDate, mrn: search.mrn},
      page,
    ] as const,
  patient: (patientId: string) => ['fhir', 'patient', patientId] as const,
  patientRecord: (patientId: string) =>
    [...fhirKeys.patient(patientId), 'record'] as const,
  allergies: (patientId: string) =>
    [...fhirKeys.patient(patientId), 'allergies'] as const,
  problems: (patientId: string) =>
    [...fhirKeys.patient(patientId), 'problems'] as const,
  appointments: (patientId: string, since: string) =>
    [...fhirKeys.patient(patientId), 'appointments', {since}] as const,
  /** One key for the Medications and Prescriptions cards: one read serves both. */
  medicationRequests: (patientId: string) =>
    [...fhirKeys.patient(patientId), 'medication-requests'] as const,
  careTeams: (patientId: string) =>
    [...fhirKeys.patient(patientId), 'care-teams'] as const,
  labResults: (patientId: string, since: string) =>
    [...fhirKeys.patient(patientId), 'lab-results', {since}] as const,
  encounters: (patientId: string, since: string) =>
    [...fhirKeys.patient(patientId), 'encounters', {since}] as const,
  vitals: (patientId: string, since: string) =>
    [...fhirKeys.patient(patientId), 'vitals', {since}] as const,
  practitioner: (practitionerId: string) =>
    ['fhir', 'practitioner', practitionerId] as const,
  organization: (organizationId: string) =>
    ['fhir', 'organization', organizationId] as const,
  immunizations: (patientId: string) =>
    [...fhirKeys.patient(patientId), 'immunizations'] as const,
};
