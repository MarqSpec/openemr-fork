// Synthetic FHIR R4 payloads for unit tests — obviously fake people, ids and values; never real PHI.
// Shapes follow OpenEMR's FHIR output. reference: INTERFACES.md API-12…21

/** A synthetic patient's logical id (FHIR ids are UUIDs in OpenEMR; any valid id works here). */
export const TEST_PATIENT_ID = 'test-patient-0001';

/** A string that must never surface in an error, a reason or a log: it only ever appears inside a field. */
export const CANARY = 'Zzcanary-Fakename';

type Json = Record<string, unknown>;

/** Wraps resources in a search Bundle as OpenEMR returns it: `type: collection`, `self` link only (BUG-7). */
export function searchBundle(resources: readonly unknown[]): Json {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    total: resources.length,
    link: [{relation: 'self', url: 'https://openemr.test/apis/default/fhir/X'}],
    entry: resources.map(resource => ({
      fullUrl: 'https://openemr.test/apis/default/fhir/X/1',
      resource,
    })),
  };
}

export function patient(overrides: Json = {}): Json {
  return {
    resourceType: 'Patient',
    id: TEST_PATIENT_ID,
    meta: {versionId: '1', lastUpdated: '2026-01-01T00:00:00+00:00'},
    active: true,
    name: [{use: 'official', family: 'Testperson', given: ['Fakey']}],
    gender: 'female',
    birthDate: '1970-01-01',
    identifier: [
      {
        type: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
              code: 'PT',
            },
          ],
        },
        value: 'TEST-MRN-0001',
      },
    ],
    extension: [
      {
        url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex',
        valueCode: 'F',
      },
    ],
    ...overrides,
  };
}

export function allergy(overrides: Json = {}): Json {
  return {
    resourceType: 'AllergyIntolerance',
    id: 'test-allergy-0001',
    clinicalStatus: {
      coding: [
        {
          system:
            'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
          code: 'active',
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system:
            'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
          code: 'unconfirmed',
        },
      ],
    },
    criticality: 'high',
    code: {text: 'Test substance A'},
    patient: {reference: `Patient/${TEST_PATIENT_ID}`},
    reaction: [{manifestation: [{text: 'Test reaction'}]}],
    ...overrides,
  };
}

export function condition(overrides: Json = {}): Json {
  return {
    resourceType: 'Condition',
    id: 'test-condition-0001',
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          code: 'active',
        },
      ],
    },
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/condition-category',
            code: 'problem-list-item',
          },
        ],
      },
    ],
    code: {text: 'Test problem A'},
    subject: {reference: `Patient/${TEST_PATIENT_ID}`},
    onsetDateTime: '2020-02-03T00:00:00+00:00',
    ...overrides,
  };
}

const PARTICIPANT_TYPE_DISPLAY: Readonly<Record<string, string>> = {
  PART: 'Participant',
  PPRF: 'Primary Performer',
  LOC: 'Location',
};

/** One appointment participant as `FhirAppointmentService` builds it: a v3 ParticipationType code and an actor. */
export function appointmentParticipant(code: string, reference: string): Json {
  return {
    type: [
      {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
            code,
            display: PARTICIPANT_TYPE_DISPLAY[code] ?? code,
          },
        ],
      },
    ],
    actor: {reference, type: reference.split('/')[0]},
    status: 'accepted',
  };
}

/**
 * One appointment as OpenEMR's Appointment sends it (API-24): the category as `appointmentType` (`pc_catname`), the
 * patient, the provider as the primary performer (`Practitioner/` only when the provider has an NPI, else `Person/`)
 * and the facility; `start` is `pc_eventDate pc_startTime` as the server's wall clock with its current offset
 * (BUG-51). No comment and no recurrence are sent (BUG-31).
 */
export function appointment(overrides: Json = {}): Json {
  return {
    resourceType: 'Appointment',
    id: 'test-appointment-0001',
    meta: {versionId: '1', lastUpdated: '2026-09-20T10:00:00-04:00'},
    status: 'booked',
    appointmentType: {
      coding: [
        {
          system:
            'https://openemr.test/apis/default/fhir/ValueSet/appointment-type',
          code: 'office_visit',
          display: 'Test office visit',
        },
      ],
    },
    participant: [
      appointmentParticipant('PART', `Patient/${TEST_PATIENT_ID}`),
      appointmentParticipant('PPRF', 'Practitioner/test-practitioner-0001'),
      appointmentParticipant('LOC', 'Location/test-location-0001'),
    ],
    start: '2026-10-12T09:30:00-04:00',
    end: '2026-10-12T09:45:00-04:00',
    ...overrides,
  };
}

export function medicationRequest(overrides: Json = {}): Json {
  return {
    resourceType: 'MedicationRequest',
    id: 'test-medreq-0001',
    status: 'active',
    intent: 'plan',
    medicationCodeableConcept: {text: 'Test drug A 10 mg'},
    subject: {reference: `Patient/${TEST_PATIENT_ID}`},
    dosageInstruction: [{text: 'Test sig: once daily'}],
    ...overrides,
  };
}

export function prescription(overrides: Json = {}): Json {
  return medicationRequest({
    id: 'test-rx-0001',
    intent: 'order',
    authoredOn: '2026-01-02',
    requester: {reference: 'Practitioner/test-practitioner-0001'},
    dispenseRequest: {
      quantity: {value: 30, unit: 'tablet'},
      numberOfRepeatsAllowed: 2,
    },
    ...overrides,
  });
}

export function careTeam(overrides: Json = {}): Json {
  return {
    resourceType: 'CareTeam',
    id: 'test-careteam-0001',
    status: 'active',
    name: 'Test care team',
    subject: {reference: `Patient/${TEST_PATIENT_ID}`},
    participant: [
      {
        role: [{coding: [{system: 'http://snomed.info/sct', code: '000000'}]}],
        member: {
          reference: 'Practitioner/test-practitioner-0001',
          type: 'Practitioner',
        },
        onBehalfOf: {reference: 'Organization/test-org-0001'},
        period: {start: '2025-05-06'},
      },
    ],
    ...overrides,
  };
}

export function practitioner(overrides: Json = {}): Json {
  return {
    resourceType: 'Practitioner',
    id: 'test-practitioner-0001',
    name: [{use: 'official', family: 'Testdoctor', given: ['Fakedoc']}],
    ...overrides,
  };
}

export function organization(overrides: Json = {}): Json {
  return {
    resourceType: 'Organization',
    id: 'test-org-0001',
    name: 'Test Clinic',
    ...overrides,
  };
}

/**
 * One lab result as OpenEMR's laboratory Observation sends it (API-22): one per `procedure_result`, dated by its
 * report, its name only as the LOINC coding's display — never `code.text`.
 */
export function labResult(overrides: Json = {}): Json {
  return {
    resourceType: 'Observation',
    id: 'test-lab-result-0001',
    status: 'final',
    category: [
      {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'laboratory',
            display: 'Laboratory',
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '4548-4',
          display: 'Test hemoglobin A1c',
        },
      ],
    },
    subject: {reference: `Patient/${TEST_PATIENT_ID}`},
    effectiveDateTime: '2026-08-30T10:15:00-04:00',
    valueQuantity: {
      value: 7.1,
      unit: '%',
      system: 'http://unitsofmeasure.org',
      code: '%',
    },
    ...overrides,
  };
}

export function encounter(overrides: Json = {}): Json {
  return {
    resourceType: 'Encounter',
    id: 'test-encounter-0001',
    status: 'finished',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: 'AMB',
      display: 'ambulatory',
    },
    type: [{text: 'Test visit type'}],
    reasonCode: [{text: 'Test reason'}],
    subject: {reference: `Patient/${TEST_PATIENT_ID}`},
    period: {start: '2026-03-04T09:00:00+00:00'},
    participant: [
      {individual: {reference: 'Practitioner/test-practitioner-0001'}},
    ],
    serviceProvider: {reference: 'Organization/test-org-0001'},
    ...overrides,
  };
}

const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';

/** OpenEMR's `dataAbsentReason` for a vital it has no value for (BUG-34). */
const DATA_ABSENT = {
  coding: [
    {
      system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
      code: 'unknown',
      display: 'Unknown',
    },
  ],
};

/** A `valueQuantity` as OpenEMR sends it: `unit` is the UCUM unit, `code` the same in brackets for some. */
export function quantity(value: number, unit: string, code = unit): Json {
  return {value, unit, system: UCUM, code};
}

/** A LOINC component (blood pressure, pulse oximetry): a value, or OpenEMR's data-absent reason. */
export function vitalComponent(code: string, value: Json | undefined): Json {
  return {
    code: {coding: [{system: LOINC, code}]},
    ...(value === undefined
      ? {dataAbsentReason: DATA_ABSENT}
      : {valueQuantity: value}),
  };
}

/**
 * One vital-sign Observation as `FhirObservationVitalsService` sends it: one per LOINC code per vitals form, all of a
 * form's sharing its `effectiveDateTime` (the form's wall-clock date, stamped with the server's offset — BUG-51).
 * With no `valueQuantity` given it is one of the form's null placeholders (BUG-34).
 */
export function vitalSign(code: string, overrides: Json = {}): Json {
  return {
    resourceType: 'Observation',
    id: `test-vital-${code}`,
    meta: {versionId: '1', lastUpdated: '2026-09-10T09:05:00-04:00'},
    status: 'final',
    category: [
      {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'vital-signs',
          },
        ],
      },
    ],
    code: {coding: [{system: LOINC, code}]},
    subject: {reference: `Patient/${TEST_PATIENT_ID}`},
    effectiveDateTime: '2026-09-10T09:00:00-04:00',
    dataAbsentReason: DATA_ABSENT,
    ...overrides,
  };
}

/** A vital with a value: the placeholder's `dataAbsentReason` goes. */
export function vitalValue(
  code: string,
  value: Json,
  overrides: Json = {},
): Json {
  // `undefined` is left out of the JSON body, as OpenEMR leaves the field out.
  return {
    ...vitalSign(code, overrides),
    dataAbsentReason: undefined,
    valueQuantity: value,
  };
}

/** What the seeded demo patients' vitals forms hold (seed_cardiology_demo.php): no BMI, oximetry or head size. */
export interface DemoVitals {
  readonly bps: number;
  readonly bpd: number;
  readonly weight: number;
  readonly height: number;
  readonly temperature: number;
  readonly pulse: number;
  readonly respiration: number;
}

export const DEMO_VITALS: DemoVitals = {
  bps: 134,
  bpd: 84,
  weight: 208,
  height: 70,
  temperature: 98.2,
  pulse: 86,
  respiration: 16,
};

/** The synthetic encounter a vitals form is filed under unless a test names another. */
export const TEST_ENCOUNTER_ID = 'test-encounter-0001';

/** The codes OpenEMR lists in a form's vital-signs panel (`in_vitals_panel`); the pediatric percentiles are not. */
const PANEL_MEMBERS = [
  '9279-1',
  '8867-4',
  '2708-6',
  '59408-5',
  '8310-5',
  '8327-9',
  '8302-2',
  '9843-4',
  '29463-7',
  '39156-5',
  '85354-9',
];

/**
 * Every Observation one seeded vitals form becomes, in the order OpenEMR emits them: the panel (`hasMember` naming the
 * form's panel codes), then one per code — the values the form holds and a null placeholder for each it does not
 * (BUG-34), all filed under `encounter`. Ids start with `prefix`.
 */
export function vitalsForm(
  when: string,
  prefix: string,
  values: Partial<DemoVitals> = DEMO_VITALS,
  encounter: string = TEST_ENCOUNTER_ID,
): Json[] {
  const at = (code: string, overrides: Json = {}) => ({
    id: `${prefix}-${code}`,
    effectiveDateTime: when,
    encounter: {reference: `Encounter/${encounter}`},
    ...overrides,
  });
  const valued = (code: string, value: number | undefined, unit: Json) =>
    value === undefined
      ? vitalSign(code, at(code))
      : vitalValue(code, {...unit, value}, at(code));
  const empty = (code: string) => vitalSign(code, at(code));
  const panel = vitalSign(
    '85353-1',
    at('85353-1', {
      dataAbsentReason: undefined,
      hasMember: PANEL_MEMBERS.map(code => ({
        reference: `Observation/${prefix}-${code}`,
      })),
    }),
  );
  const bloodPressure =
    values.bps === undefined && values.bpd === undefined
      ? empty('85354-9')
      : vitalSign(
          '85354-9',
          at('85354-9', {
            dataAbsentReason: undefined,
            component: [
              vitalComponent(
                '8480-6',
                values.bps === undefined
                  ? undefined
                  : quantity(values.bps, 'mm[Hg]'),
              ),
              vitalComponent(
                '8462-4',
                values.bpd === undefined
                  ? undefined
                  : quantity(values.bpd, 'mm[Hg]'),
              ),
            ],
          }),
        );
  return [
    panel,
    valued('9279-1', values.respiration, quantity(0, '/min')),
    valued('8867-4', values.pulse, quantity(0, '/min')),
    empty('2708-6'),
    empty('59408-5'),
    valued('8310-5', values.temperature, quantity(0, 'degF', '[degF]')),
    empty('8327-9'),
    valued('8302-2', values.height, quantity(0, 'in_i', '[in_i]')),
    empty('9843-4'),
    valued('29463-7', values.weight, quantity(0, 'lb_av', '[lb_av]')),
    empty('39156-5'),
    bloodPressure,
    empty('8289-1'),
    empty('59576-9'),
    empty('77606-2'),
  ];
}

/** An OperationOutcome as OpenEMR's FHIR API returns it on an error. */
export function operationOutcome(code: string): Json {
  return {
    resourceType: 'OperationOutcome',
    issue: [{severity: 'error', code, diagnostics: `failed for ${CANARY}`}],
  };
}

/** OpenEMR's standard REST envelope, which FHIR routes also return on some 400s (BUG-33). */
export function restEnvelope(): Json {
  return {
    validationErrors: {_id: `invalid value ${CANARY}`},
    internalErrors: [],
    data: [],
  };
}

/**
 * One immunization as OpenEMR's Immunization sends it (API-23): a CVX coding only when a CVX code is recorded, whose
 * display is the long CVX name (`codes.code_text`), never `vaccineCode.text`; `occurrenceDateTime` is the
 * administered date as the server's wall clock with its current offset (BUG-51).
 */
export function immunization(overrides: Json = {}): Json {
  return {
    resourceType: 'Immunization',
    id: 'test-immunization-0001',
    meta: {versionId: '1', lastUpdated: '2025-10-04T09:40:00-04:00'},
    status: 'completed',
    primarySource: true,
    vaccineCode: {
      coding: [
        {
          system: 'http://hl7.org/fhir/sid/cvx',
          code: '150',
          display: 'Test influenza vaccine, injectable',
        },
      ],
    },
    patient: {reference: `Patient/${TEST_PATIENT_ID}`},
    occurrenceDateTime: '2025-10-04T09:30:00-04:00',
    recorded: '2025-10-04T09:40:00-04:00',
    ...overrides,
  };
}
