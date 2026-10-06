import type * as fhir4 from 'fhir/r4';
import {describe, expectTypeOf, it} from 'vitest';

import type {
  AllergyIntolerance,
  Appointment,
  CareTeam,
  Condition,
  Encounter,
  Immunization,
  LabResult,
  MedicationListEntry,
  MedicationRequest,
  Observation,
  Organization,
  Patient,
  Practitioner,
  Prescription,
} from './schemas';

// reference: REQUIREMENTS.md NFR-CODE-2 (API types from FHIR R4 definitions plus Zod schemas)
// Checked by `npm run typecheck`: a parsed value must be a valid FHIR R4 resource, so a schema can narrow R4
// (keep only the fields the cards read) but never contradict it.

describe('given the Zod schemas for the resources the cards read', () => {
  it('when a resource is parsed, then its type is a subset of the FHIR R4 definition', () => {
    expectTypeOf<Patient>().toExtend<fhir4.Patient>();
    expectTypeOf<AllergyIntolerance>().toExtend<fhir4.AllergyIntolerance>();
    expectTypeOf<Condition>().toExtend<fhir4.Condition>();
    expectTypeOf<MedicationRequest>().toExtend<fhir4.MedicationRequest>();
    // API-15 accepts any intent code; everything else still conforms.
    expectTypeOf<Omit<MedicationListEntry, 'intent'>>().toExtend<
      Omit<fhir4.MedicationRequest, 'intent'>
    >();
    // API-16 accepts any intent code (as API-15); everything else still conforms.
    expectTypeOf<Omit<Prescription, 'intent'>>().toExtend<
      Omit<fhir4.MedicationRequest, 'intent'>
    >();
    expectTypeOf<CareTeam>().toExtend<fhir4.CareTeam>();
    expectTypeOf<Practitioner>().toExtend<fhir4.Practitioner>();
    expectTypeOf<Organization>().toExtend<fhir4.Organization>();
    expectTypeOf<LabResult>().toExtend<fhir4.Observation>();
    expectTypeOf<Encounter>().toExtend<fhir4.Encounter>();
    expectTypeOf<Observation>().toExtend<fhir4.Observation>();
  });
});

describe('given the Zod schema for the Immunizations read (API-23)', () => {
  it('when an immunization is parsed, then its type is a subset of the FHIR R4 definition — vaccineCode always present, if empty (BUG-60)', () => {
    expectTypeOf<Immunization>().toExtend<fhir4.Immunization>();
  });
});

describe('given the Zod schema for the Appointments read (API-24)', () => {
  it('when an appointment is parsed, then its type is a subset of the FHIR R4 definition', () => {
    expectTypeOf<Appointment>().toExtend<fhir4.Appointment>();
  });
});
