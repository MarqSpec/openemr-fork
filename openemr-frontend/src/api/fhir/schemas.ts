import {z} from 'zod';

// Zod schemas for the FHIR R4 resources the cards read — only the fields those cards use; unknown keys are
// stripped. Each inferred type is checked against @types/fhir R4 (schemas.test.ts), so a schema may narrow R4 but
// never contradict it. reference: INTERFACES.md API-12…21 · REQUIREMENTS.md NFR-CODE-2

/** FHIR R4 `id`: 1–64 of `A-Z a-z 0-9 - .` */
export const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
const FHIR_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const FHIR_DATE_TIME =
  /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00)))?)?)?$/;

const id = z.string().regex(FHIR_ID);
const date = z.string().regex(FHIR_DATE);
const dateTime = z.string().regex(FHIR_DATE_TIME);

const coding = z.object({
  system: z.string().optional(),
  code: z.string().optional(),
  display: z.string().optional(),
});

const codeableConcept = z.object({
  coding: z.array(coding).optional(),
  text: z.string().optional(),
});

const reference = z.object({
  reference: z.string().optional(),
  type: z.string().optional(),
  display: z.string().optional(),
});

const period = z.object({
  start: dateTime.optional(),
  end: dateTime.optional(),
});

const humanName = z.object({
  use: z
    .enum([
      'usual',
      'official',
      'temp',
      'nickname',
      'anonymous',
      'old',
      'maiden',
    ])
    .optional(),
  text: z.string().optional(),
  family: z.string().optional(),
  given: z.array(z.string()).optional(),
  prefix: z.array(z.string()).optional(),
  suffix: z.array(z.string()).optional(),
});

const quantity = z.object({
  value: z.number().optional(),
  unit: z.string().optional(),
  code: z.string().optional(),
});

/** API-12 — the patient header (FR-HDR-1…3). `active` only mirrors `deceased[x]`. */
export const patientSchema = z.object({
  resourceType: z.literal('Patient'),
  id,
  active: z.boolean().optional(),
  name: z.array(humanName).optional(),
  gender: z.enum(['male', 'female', 'other', 'unknown']).optional(),
  birthDate: date.optional(),
  deceasedBoolean: z.boolean().optional(),
  deceasedDateTime: dateTime.optional(),
  identifier: z
    .array(
      z.object({
        type: codeableConcept.optional(),
        system: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .optional(),
  extension: z
    .array(z.object({url: z.string(), valueCode: z.string().optional()}))
    .optional(),
});
export type Patient = z.infer<typeof patientSchema>;

/**
 * API-13 — Allergies (FR-CARD-ALG-1): all four criticality cases, absent included (BUG-41). `text` is the only
 * place OpenEMR puts the allergy's list title (BUG-45).
 */
export const allergyIntoleranceSchema = z.object({
  resourceType: z.literal('AllergyIntolerance'),
  id,
  text: z
    .object({
      status: z.enum(['generated', 'extensions', 'additional', 'empty']),
      div: z.string(),
    })
    .optional(),
  patient: reference,
  clinicalStatus: codeableConcept.optional(),
  verificationStatus: codeableConcept.optional(),
  criticality: z.enum(['high', 'low', 'unable-to-assess']).optional(),
  code: codeableConcept.optional(),
  reaction: z
    .array(z.object({manifestation: z.array(codeableConcept)}))
    .optional(),
});
export type AllergyIntolerance = z.infer<typeof allergyIntoleranceSchema>;

/** API-14 — Problem List (FR-CARD-PRB-1). */
export const conditionSchema = z.object({
  resourceType: z.literal('Condition'),
  id,
  subject: reference,
  clinicalStatus: codeableConcept.optional(),
  verificationStatus: codeableConcept.optional(),
  category: z.array(codeableConcept).optional(),
  code: codeableConcept.optional(),
  onsetDateTime: dateTime.optional(),
  /** OpenEMR's end date — the only abatement[x] it sends (FhirConditionTrait::populateAbatementDateTime). */
  abatementDateTime: dateTime.optional(),
  /** The issue's comments (FhirConditionTrait::populateNote); shown in item detail only (FR-CARD-6). */
  note: z.array(z.object({text: z.string()})).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

/**
 * The R4 MedicationRequest both API-15 and API-16 read — every intent, no `intent` filter (BUG-13). API-15 extends it
 * as `medicationListEntrySchema`, API-16 as `prescriptionSchema`.
 */
export const medicationRequestSchema = z.object({
  resourceType: z.literal('MedicationRequest'),
  id,
  subject: reference,
  status: z.enum([
    'active',
    'on-hold',
    'cancelled',
    'completed',
    'entered-in-error',
    'stopped',
    'draft',
    'unknown',
  ]),
  intent: z.enum([
    'proposal',
    'plan',
    'order',
    'original-order',
    'reflex-order',
    'filler-order',
    'instance-order',
    'option',
  ]),
  medicationCodeableConcept: codeableConcept.optional(),
  medicationReference: reference.optional(),
  authoredOn: dateTime.optional(),
  requester: reference.optional(),
  dosageInstruction: z
    .array(z.object({text: z.string().optional()}))
    .optional(),
  dispenseRequest: z
    .object({
      quantity: quantity.optional(),
      numberOfRepeatsAllowed: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type MedicationRequest = z.infer<typeof medicationRequestSchema>;

/**
 * API-15 — the Medications card reads every intent (maintainer ruling), so `intent` is any code: one
 * outside R4 is shown with its raw code rather than dropped. The only field that departs from R4.
 */
export const medicationListEntrySchema = medicationRequestSchema.extend({
  intent: z.string().min(1),
});
export type MedicationListEntry = z.infer<typeof medicationListEntrySchema>;

/**
 * API-24 — one future appointment (FR-CARD-APT-1). `start` is kept as sent, whatever its shape, so one the card
 * cannot date is still listed; OpenEMR stamps it with the server's current offset (BUG-51). The provider is a
 * participant whose actor may be `Person/` (BUG-31).
 */
export const appointmentSchema = z.object({
  resourceType: z.literal('Appointment'),
  id,
  status: z.enum([
    'proposed',
    'pending',
    'booked',
    'arrived',
    'fulfilled',
    'cancelled',
    'noshow',
    'entered-in-error',
    'checked-in',
    'waitlist',
  ]),
  appointmentType: codeableConcept.optional(),
  start: z.string().optional(),
  participant: z.array(
    z.object({
      type: z.array(codeableConcept).optional(),
      actor: reference.optional(),
      status: z.enum(['accepted', 'declined', 'tentative', 'needs-action']),
    }),
  ),
});
export type Appointment = z.infer<typeof appointmentSchema>;

/** API-17 — Care Team (FR-CARD-CT-1); member names come from API-18/19 (BUG-10). */
export const careTeamSchema = z.object({
  resourceType: z.literal('CareTeam'),
  id,
  status: z
    .enum(['proposed', 'active', 'suspended', 'inactive', 'entered-in-error'])
    .optional(),
  name: z.string().optional(),
  participant: z
    .array(
      z.object({
        role: z.array(codeableConcept).optional(),
        member: reference.optional(),
        onBehalfOf: reference.optional(),
        period: period.optional(),
      }),
    )
    .optional(),
  note: z.array(z.object({text: z.string()})).optional(),
});
export type CareTeam = z.infer<typeof careTeamSchema>;

/**
 * API-23 — one immunization (FR-CARD-IMM-1). OpenEMR sends `vaccineCode` only when a CVX code is recorded, so an
 * absent one parses as empty rather than losing the row; the date is kept as sent, so one that is not a calendar date
 * still shows its vaccine (BUG-60). `status` is `completed` only for completion status "Completed" — every other,
 * blank included, is `not-done` (BUG-59).
 */
export const immunizationSchema = z.object({
  resourceType: z.literal('Immunization'),
  id,
  status: z.enum(['completed', 'entered-in-error', 'not-done']),
  vaccineCode: codeableConcept.default({}),
  patient: reference,
  occurrenceDateTime: z.string().optional(),
});
export type Immunization = z.infer<typeof immunizationSchema>;

/** API-18 — a name for a CareTeam member, an encounter provider or a prescriber. */
export const practitionerSchema = z.object({
  resourceType: z.literal('Practitioner'),
  id,
  name: z.array(humanName).optional(),
});
export type Practitioner = z.infer<typeof practitionerSchema>;

/** API-19 — a facility name for CareTeam and Encounter. */
export const organizationSchema = z.object({
  resourceType: z.literal('Organization'),
  id,
  name: z.string().optional(),
});
export type Organization = z.infer<typeof organizationSchema>;

const DATA_ABSENT_REASON_URL =
  'http://hl7.org/fhir/StructureDefinition/data-absent-reason';
const DATA_ABSENT_REASON_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/data-absent-reason';
/** FHIR R4's DataAbsentReason codes — a closed set, so no field value rides in on one. */
const dataAbsentReasonCode = z.enum([
  'unknown',
  'asked-unknown',
  'temp-unknown',
  'not-asked',
  'asked-declined',
  'masked',
  'not-applicable',
  'unsupported',
  'as-text',
  'error',
  'not-a-number',
  'negative-infinity',
  'positive-infinity',
  'not-performed',
  'not-permitted',
]);
export type DataAbsentReason = z.infer<typeof dataAbsentReasonCode>;

/** A Coding that may say why it has no value, as R4 does on any element: the data-absent-reason extension. */
export interface ExplainedCoding extends z.infer<typeof coding> {
  extension?: {
    url: typeof DATA_ABSENT_REASON_URL;
    valueCode: DataAbsentReason;
  }[];
}

/** OpenEMR's class for a visit without one: a data-absent CodeableConcept in the Coding slot (BUG-50). */
const dataAbsentConcept = z.object({
  coding: z
    .array(
      z.object({
        system: z.literal(DATA_ABSENT_REASON_SYSTEM),
        code: z.unknown().optional(),
      }),
    )
    .min(1),
});

/**
 * `Encounter.class`: a Coding, or OpenEMR's data-absent concept parsed as an explicit reason (a reason code FHIR does
 * not define is `unknown`), so a card can tell "unknown" from a class with no code.
 */
const encounterClass = z
  .union([dataAbsentConcept, coding])
  .transform((value): ExplainedCoding => {
    if (!('coding' in value)) return value;
    const reason = dataAbsentReasonCode.safeParse(value.coding[0]?.code);
    return {
      extension: [
        {
          url: DATA_ABSENT_REASON_URL,
          valueCode: reason.success ? reason.data : 'unknown',
        },
      ],
    };
  });

/** Why an element has no value, when the server said so; `undefined` when it did not. */
export function dataAbsentReason(
  element: ExplainedCoding,
): DataAbsentReason | undefined {
  return element.extension?.[0]?.valueCode;
}

/** API-20 — Encounter history (FR-CARD-ENC-1). */
export const encounterSchema = z.object({
  resourceType: z.literal('Encounter'),
  id,
  status: z.enum([
    'planned',
    'arrived',
    'triaged',
    'in-progress',
    'onleave',
    'finished',
    'cancelled',
    'entered-in-error',
    'unknown',
  ]),
  class: encounterClass,
  type: z.array(codeableConcept).optional(),
  reasonCode: z.array(codeableConcept).optional(),
  period: period.optional(),
  participant: z
    .array(
      z.object({
        type: z.array(codeableConcept).optional(),
        individual: reference.optional(),
      }),
    )
    .optional(),
  serviceProvider: reference.optional(),
});
export type Encounter = z.infer<typeof encounterSchema>;

/**
 * API-22 — one lab result (FR-CARD-LAB-1). OpenEMR sends one Observation per `procedure_result`, dated by its report
 * (BUG-58), named only by the LOINC coding's display, or a null-flavour code when the result has no code or text; a
 * numeric value is `valueQuantity`, anything else `valueString`, and an empty one — or a 0 — `dataAbsentReason`
 * (BUG-56). Every status but `final` arrives as `unknown` (BUG-57).
 */
export const labResultSchema = z.object({
  resourceType: z.literal('Observation'),
  id,
  status: z.enum([
    'registered',
    'preliminary',
    'final',
    'amended',
    'corrected',
    'cancelled',
    'entered-in-error',
    'unknown',
  ]),
  code: codeableConcept,
  effectiveDateTime: dateTime.optional(),
  valueQuantity: quantity.optional(),
  valueString: z.string().optional(),
  valueCodeableConcept: codeableConcept.optional(),
  dataAbsentReason: codeableConcept.optional(),
  interpretation: z.array(codeableConcept).optional(),
});
export type LabResult = z.infer<typeof labResultSchema>;

/**
 * API-16 — the Prescriptions card reads every intent (as API-15), so `intent` is any code. It also
 * keeps what tells a prescription from a medication-list entry — a list entry never carries a quantity, route,
 * timing or dose — and `meta.lastUpdated`, the legacy sort key (BUG-13, BUG-48).
 */
export const prescriptionSchema = medicationRequestSchema.extend({
  meta: z.object({lastUpdated: z.string().optional()}).optional(),
  intent: z.string().min(1),
  dosageInstruction: z
    .array(
      z.object({
        text: z.string().optional(),
        timing: z.object({code: codeableConcept.optional()}).optional(),
        route: codeableConcept.optional(),
        doseAndRate: z
          .array(z.object({doseQuantity: quantity.optional()}))
          .optional(),
      }),
    )
    .optional(),
});
export type Prescription = z.infer<typeof prescriptionSchema>;

/**
 * API-21 — one vital sign (FR-CARD-VIT-1). OpenEMR sends one per LOINC code per vitals form, all of a form's sharing
 * its `effectiveDateTime`; a vital the form did not record comes as a placeholder with `dataAbsentReason` and no value
 * (BUG-34). Blood pressure and pulse oximetry carry their values as `component`s; the temperature method is
 * `valueString`; the form's note is on the panel (LOINC 85353-1).
 */
export const observationSchema = z.object({
  resourceType: z.literal('Observation'),
  id,
  meta: z.object({lastUpdated: z.string().optional()}).optional(),
  status: z.enum([
    'registered',
    'preliminary',
    'final',
    'amended',
    'corrected',
    'cancelled',
    'entered-in-error',
    'unknown',
  ]),
  code: codeableConcept,
  encounter: reference.optional(),
  effectiveDateTime: dateTime.optional(),
  effectivePeriod: period.optional(),
  /** On the vital-signs panel: the form's readings, which tell two forms at one time apart. */
  hasMember: z.array(reference).optional(),
  valueQuantity: quantity.optional(),
  valueString: z.string().optional(),
  dataAbsentReason: codeableConcept.optional(),
  note: z.array(z.object({text: z.string()})).optional(),
  component: z
    .array(
      z.object({
        code: codeableConcept,
        valueQuantity: quantity.optional(),
        dataAbsentReason: codeableConcept.optional(),
      }),
    )
    .optional(),
});
export type Observation = z.infer<typeof observationSchema>;
