import {http, HttpResponse} from 'msw';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {server} from '../../test/msw_server';
import {
  CANARY,
  TEST_PATIENT_ID,
  allergy,
  appointment,
  appointmentParticipant,
  careTeam,
  condition,
  encounter,
  immunization,
  labResult,
  medicationRequest,
  organization,
  patient,
  practitioner,
  prescription,
  searchBundle,
  vitalsForm,
} from '../../test/fhir_fixtures';
import {ApiError} from '../api_error';
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
  searchProblems,
  searchVitals,
} from './resources';
import {dataAbsentReason} from './schemas';

// reference: INTERFACES.md API-12…21 · REQUIREMENTS.md FR-CARD-3, NFR-SEC-6 · REQUIREMENTS.md BUG-7, BUG-8, BUG-13

afterEach(() => {
  vi.restoreAllMocks();
});

/** Answers one exact FHIR search (path + query) through the token handler; anything else is unhandled. */
function answerSearch(
  path: string,
  expectedQuery: Record<string, string>,
  body: Record<string, unknown>,
): void {
  server.use(
    http.get(`/bff/fhir/${path}`, ({request}) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (JSON.stringify(query) !== JSON.stringify(expectedQuery)) {
        return HttpResponse.json(
          {resourceType: 'OperationOutcome', issue: []},
          {status: 400},
        );
      }
      return HttpResponse.json(body);
    }),
  );
}

describe('given each P0 card search, sent exactly as the inventory specifies', () => {
  it('when allergies are searched, then API-13 is sent with only the patient parameter', async () => {
    answerSearch(
      'AllergyIntolerance',
      {patient: TEST_PATIENT_ID},
      searchBundle([allergy()]),
    );
    const items = await searchAllergies(TEST_PATIENT_ID);
    expect(items).toEqual([
      {
        kind: 'ok',
        resource: expect.objectContaining({
          resourceType: 'AllergyIntolerance',
          id: 'test-allergy-0001',
          criticality: 'high',
          code: {text: 'Test substance A'},
        }) as unknown,
      },
    ]);
  });

  it('when problems are searched, then API-14 always sends category=problem-list-item (BUG-8)', async () => {
    answerSearch(
      'Condition',
      {patient: TEST_PATIENT_ID, category: 'problem-list-item'},
      searchBundle([condition()]),
    );
    const items = await searchProblems(TEST_PATIENT_ID);
    expect(items).toMatchObject([
      {kind: 'ok', resource: {onsetDateTime: '2020-02-03T00:00:00+00:00'}},
    ]);
  });

  it('when medications are searched, then API-15 asks for every intent — only the patient parameter (BUG-13)', async () => {
    answerSearch(
      'MedicationRequest',
      {patient: TEST_PATIENT_ID},
      searchBundle([medicationRequest()]),
    );
    const {medications} = await searchMedicationRequests(TEST_PATIENT_ID);
    expect(medications).toMatchObject([
      {
        kind: 'ok',
        resource: {
          intent: 'plan',
          medicationCodeableConcept: {text: 'Test drug A 10 mg'},
          dosageInstruction: [{text: 'Test sig: once daily'}],
        },
      },
    ]);
  });

  it('when a medication carries an intent code outside FHIR R4, then API-15 still parses it and keeps the raw code', async () => {
    answerSearch(
      'MedicationRequest',
      {patient: TEST_PATIENT_ID},
      searchBundle([medicationRequest({intent: 'test-unknown-intent'})]),
    );
    const {medications} = await searchMedicationRequests(TEST_PATIENT_ID);
    expect(medications).toMatchObject([
      {kind: 'ok', resource: {intent: 'test-unknown-intent'}},
    ]);
  });

  it('when prescriptions are searched, then API-16 asks for every intent — only the patient parameter, no status (BUG-13, BUG-48; rulings)', async () => {
    answerSearch(
      'MedicationRequest',
      {patient: TEST_PATIENT_ID},
      searchBundle([prescription()]),
    );
    const {prescriptions} = await searchMedicationRequests(TEST_PATIENT_ID);
    expect(prescriptions).toMatchObject([
      {
        kind: 'ok',
        resource: {
          intent: 'order',
          dispenseRequest: {numberOfRepeatsAllowed: 2},
          requester: {reference: 'Practitioner/test-practitioner-0001'},
        },
      },
    ]);
  });

  it('when a prescription carries the dispensing details the card reads, then API-16 keeps them: last-updated, sig timing, route and dose', async () => {
    answerSearch(
      'MedicationRequest',
      {patient: TEST_PATIENT_ID},
      searchBundle([
        prescription({
          meta: {lastUpdated: '2026-01-03T05:00:00+00:00'},
          dosageInstruction: [
            {
              text: 'Test sig',
              timing: {code: {text: 'twice daily'}},
              route: {text: 'by mouth'},
              doseAndRate: [{doseQuantity: {value: 5, unit: 'mg'}}],
            },
          ],
        }),
      ]),
    );
    const {prescriptions} = await searchMedicationRequests(TEST_PATIENT_ID);
    expect(prescriptions).toMatchObject([
      {
        kind: 'ok',
        resource: {
          meta: {lastUpdated: '2026-01-03T05:00:00+00:00'},
          dosageInstruction: [
            {
              text: 'Test sig',
              timing: {code: {text: 'twice daily'}},
              route: {text: 'by mouth'},
              doseAndRate: [{doseQuantity: {value: 5, unit: 'mg'}}],
            },
          ],
        },
      },
    ]);
  });

  it('when a prescription carries an intent code outside FHIR R4, then API-16 still parses it and keeps the raw code', async () => {
    answerSearch(
      'MedicationRequest',
      {patient: TEST_PATIENT_ID},
      searchBundle([prescription({intent: 'test-unknown-intent'})]),
    );
    const {prescriptions} = await searchMedicationRequests(TEST_PATIENT_ID);
    expect(prescriptions).toMatchObject([
      {kind: 'ok', resource: {intent: 'test-unknown-intent'}},
    ]);
  });

  it('when the medication requests are searched, then one request feeds both cards, each parsing every entry in server order (guards the double read)', async () => {
    let requests = 0;
    server.use(
      http.get('/bff/fhir/MedicationRequest', () => {
        requests += 1;
        return HttpResponse.json(
          searchBundle([
            medicationRequest({id: 'test-medreq-0001'}),
            prescription({id: 'test-rx-0001'}),
          ]),
        );
      }),
    );
    const {medications, prescriptions} =
      await searchMedicationRequests(TEST_PATIENT_ID);
    expect(requests).toBe(1);
    const ids = [
      {kind: 'ok', resource: {id: 'test-medreq-0001'}},
      {kind: 'ok', resource: {id: 'test-rx-0001'}},
    ];
    expect(medications).toMatchObject(ids);
    expect(prescriptions).toMatchObject(ids);
  });

  it('when an entry fails only the Prescriptions schema, then it is could-not-display there and still a row on the Medications card (guards one card losing a row to the schema of the other card)', async () => {
    answerSearch(
      'MedicationRequest',
      {patient: TEST_PATIENT_ID},
      searchBundle([
        medicationRequest({
          dosageInstruction: [{text: 'Test sig', route: 'not-a-concept'}],
        }),
      ]),
    );
    const {medications, prescriptions} =
      await searchMedicationRequests(TEST_PATIENT_ID);
    expect(medications).toMatchObject([
      {kind: 'ok', resource: {dosageInstruction: [{text: 'Test sig'}]}},
    ]);
    expect(prescriptions).toMatchObject([{kind: 'could-not-display'}]);
  });

  it('when care teams are searched, then API-17 is sent with the patient parameter', async () => {
    answerSearch(
      'CareTeam',
      {patient: TEST_PATIENT_ID},
      searchBundle([careTeam()]),
    );
    expect(await searchCareTeams(TEST_PATIENT_ID)).toMatchObject([
      {
        kind: 'ok',
        resource: {
          participant: [
            {
              member: {reference: 'Practitioner/test-practitioner-0001'},
              period: {start: '2025-05-06'},
            },
          ],
        },
      },
    ]);
  });

  it('when encounters are searched, then API-20 bounds them by date and never pages (BUG-7)', async () => {
    answerSearch(
      'Encounter',
      {patient: TEST_PATIENT_ID, date: 'ge2024-09-24'},
      searchBundle([encounter()]),
    );
    expect(await searchEncounters(TEST_PATIENT_ID, '2024-09-24')).toMatchObject(
      [
        {
          kind: 'ok',
          resource: {
            class: {code: 'AMB'},
            period: {start: '2026-03-04T09:00:00+00:00'},
          },
        },
      ],
    );
  });
});

describe('given the vitals search (API-21)', () => {
  it('when vitals are searched, then API-21 sends the patient, the vital-signs category and a lower date bound — no code, paging or sort (BUG-7)', async () => {
    answerSearch(
      'Observation',
      {patient: TEST_PATIENT_ID, category: 'vital-signs', date: 'ge2025-09-24'},
      searchBundle(vitalsForm('2026-09-10T09:00:00-04:00', 'a')),
    );
    const items = await searchVitals(TEST_PATIENT_ID, '2025-09-24');
    expect(items).toHaveLength(15);
    const bloodPressure = items.find(
      item => item.kind === 'ok' && item.resource.id === 'a-85354-9',
    );
    expect(bloodPressure).toMatchObject({
      kind: 'ok',
      resource: {
        code: {coding: [{system: 'http://loinc.org', code: '85354-9'}]},
        effectiveDateTime: '2026-09-10T09:00:00-04:00',
        component: [
          {valueQuantity: {value: 134}},
          {valueQuantity: {value: 84}},
        ],
      },
    });
  });

  it('when a vitals form is read, then each observation keeps its encounter and the panel keeps the readings it lists (hasMember), which tell two same-second forms apart', async () => {
    answerSearch(
      'Observation',
      {patient: TEST_PATIENT_ID, category: 'vital-signs', date: 'ge2025-09-24'},
      searchBundle(vitalsForm('2026-09-10T09:00:00-04:00', 'a')),
    );
    const items = await searchVitals(TEST_PATIENT_ID, '2025-09-24');
    expect(
      items.find(
        item => item.kind === 'ok' && item.resource.id === 'a-85353-1',
      ),
    ).toMatchObject({
      kind: 'ok',
      resource: {
        encounter: {reference: 'Encounter/test-encounter-0001'},
        hasMember: expect.arrayContaining([
          {reference: 'Observation/a-8867-4'},
        ]) as unknown,
      },
    });
  });

  it('when OpenEMR sends a null placeholder (BUG-34), then it still parses — it has a data-absent reason and no value', async () => {
    answerSearch(
      'Observation',
      {patient: TEST_PATIENT_ID, category: 'vital-signs', date: 'ge2025-09-24'},
      searchBundle(vitalsForm('2026-09-10T09:00:00-04:00', 'a')),
    );
    const items = await searchVitals(TEST_PATIENT_ID, '2025-09-24');
    expect(items.every(item => item.kind === 'ok')).toBe(true);
  });
});

describe('given each read by id', () => {
  it('when the patient is read, then API-12 returns the header fields', async () => {
    answerSearch(`Patient/${TEST_PATIENT_ID}`, {}, patient());
    expect(await readPatient(TEST_PATIENT_ID)).toMatchObject({
      kind: 'ok',
      resource: {
        birthDate: '1970-01-01',
        gender: 'female',
        active: true,
        identifier: [{value: 'TEST-MRN-0001'}],
      },
    });
  });

  it('when a practitioner is read, then API-18 returns the name', async () => {
    answerSearch('Practitioner/test-practitioner-0001', {}, practitioner());
    expect(await readPractitioner('test-practitioner-0001')).toMatchObject({
      kind: 'ok',
      resource: {name: [{family: 'Testdoctor'}]},
    });
  });

  it('when an organization is read, then API-19 returns the name', async () => {
    answerSearch('Organization/test-org-0001', {}, organization());
    expect(await readOrganization('test-org-0001')).toMatchObject({
      kind: 'ok',
      resource: {name: 'Test Clinic'},
    });
  });
});

describe('given the Appointments search (API-24)', () => {
  it('when appointments are searched, then API-24 sends only the patient and the day the list starts on, never paging (BUG-7)', async () => {
    answerSearch(
      'Appointment',
      {patient: TEST_PATIENT_ID, date: 'ge2026-09-25'},
      searchBundle([appointment()]),
    );
    expect(await searchAppointments(TEST_PATIENT_ID, '2026-09-25')).toEqual([
      {
        kind: 'ok',
        resource: expect.objectContaining({
          resourceType: 'Appointment',
          id: 'test-appointment-0001',
          status: 'booked',
          start: '2026-10-12T09:30:00-04:00',
        }) as unknown,
      },
    ]);
  });

  it('when OpenEMR sends a provider without an NPI as Person/, no category or no start, then the appointment still parses (BUG-31)', async () => {
    answerSearch(
      'Appointment',
      {patient: TEST_PATIENT_ID, date: 'ge2026-09-25'},
      searchBundle([
        appointment({
          id: 'a-person',
          participant: [appointmentParticipant('PPRF', 'Person/p-1')],
        }),
        appointment({id: 'a-uncategorised', appointmentType: undefined}),
        appointment({id: 'a-unstarted', start: undefined, end: undefined}),
      ]),
    );
    const items = await searchAppointments(TEST_PATIENT_ID, '2026-09-25');
    expect(items.map(item => item.kind)).toEqual(['ok', 'ok', 'ok']);
  });

  it('when a status is not an R4 appointment status, then that one appointment is "could not display" and the rest still parse (FR-CARD-3)', async () => {
    answerSearch(
      'Appointment',
      {patient: TEST_PATIENT_ID, date: 'ge2026-09-25'},
      searchBundle([
        appointment({id: 'a-odd', status: 'rescheduled'}),
        appointment(),
      ]),
    );
    const items = await searchAppointments(TEST_PATIENT_ID, '2026-09-25');
    expect(items.map(item => item.kind)).toEqual(['could-not-display', 'ok']);
  });

  it('when the patient id is not a FHIR id, then API-24 fails with invalid-id and nothing is sent', async () => {
    let requests = 0;
    server.use(
      http.get('/bff/*', () => {
        requests += 1;
        return HttpResponse.json({}, {status: 500});
      }),
    );
    await expect(
      searchAppointments('../Patient', '2026-09-25'),
    ).rejects.toMatchObject({failure: {kind: 'invalid-id', apiId: 'API-24'}});
    expect(requests).toBe(0);
  });
});

describe('given an id that is not a valid FHIR id', () => {
  const INVALID_IDS = ['a/b', '..', '.', '', 'x'.repeat(65), 'a b', 'a?b=c'];

  it.each(INVALID_IDS)(
    'when %j is used, then every read and search fails with invalid-id and sends nothing',
    async badId => {
      let requests = 0;
      server.use(
        http.get('/bff/*', () => {
          requests += 1;
          return HttpResponse.json({}, {status: 500});
        }),
      );
      const calls: [string, Promise<unknown>][] = [
        ['API-12', readPatient(badId)],
        ['API-13', searchAllergies(badId)],
        ['API-14', searchProblems(badId)],
        ['API-15/16', searchMedicationRequests(badId)],
        ['API-17', searchCareTeams(badId)],
        ['API-18', readPractitioner(badId)],
        ['API-19', readOrganization(badId)],
        ['API-20', searchEncounters(badId, '2024-09-24')],
        ['API-21', searchVitals(badId, '2025-09-24')],
      ];
      for (const [apiId, call] of calls) {
        await expect(call).rejects.toMatchObject({
          failure: {kind: 'invalid-id', apiId},
        });
      }
      expect(requests).toBe(0);
    },
  );

  it('when a valid id at the 64-character limit is used, then the read is sent', async () => {
    const longId = 'a'.repeat(64);
    answerSearch(`Practitioner/${longId}`, {}, practitioner({id: longId}));
    expect(await readPractitioner(longId)).toMatchObject({kind: 'ok'});
  });
});

describe('given the Immunizations search (API-23)', () => {
  it('when immunizations are searched, then API-23 sends only the patient parameter — OpenEMR has no date or status search here', async () => {
    answerSearch(
      'Immunization',
      {patient: TEST_PATIENT_ID},
      searchBundle([immunization()]),
    );
    expect(await searchImmunizations(TEST_PATIENT_ID)).toEqual([
      {
        kind: 'ok',
        resource: expect.objectContaining({
          resourceType: 'Immunization',
          id: 'test-immunization-0001',
          status: 'completed',
          occurrenceDateTime: '2025-10-04T09:30:00-04:00',
        }) as unknown,
      },
    ]);
  });

  it('when OpenEMR sends no vaccineCode (no CVX code recorded, BUG-60) or no administered date, then the immunization still parses', async () => {
    answerSearch(
      'Immunization',
      {patient: TEST_PATIENT_ID},
      searchBundle([
        immunization({id: 'i-unnamed', vaccineCode: undefined}),
        immunization({id: 'i-undated', occurrenceDateTime: undefined}),
        immunization({id: 'i-not-done', status: 'not-done'}),
      ]),
    );
    const items = await searchImmunizations(TEST_PATIENT_ID);
    expect(items.map(item => item.kind)).toEqual(['ok', 'ok', 'ok']);
  });

  it('when the patient id is not a FHIR id, then API-23 fails with invalid-id and nothing is sent', async () => {
    let requests = 0;
    server.use(
      http.get('/bff/*', () => {
        requests += 1;
        return HttpResponse.json({}, {status: 500});
      }),
    );
    await expect(searchImmunizations('../Patient')).rejects.toMatchObject({
      failure: {kind: 'invalid-id', apiId: 'API-23'},
    });
    expect(requests).toBe(0);
  });
});

describe('given every allergy criticality OpenEMR can send (FR-CARD-ALG-1, BUG-41)', () => {
  it('when the four wire cases arrive, then each is readable and an unknown value is not', async () => {
    answerSearch(
      'AllergyIntolerance',
      {patient: TEST_PATIENT_ID},
      searchBundle([
        allergy({criticality: 'high'}),
        allergy({criticality: 'low'}),
        allergy({criticality: 'unable-to-assess'}),
        // JSON drops an undefined key: this entry has no criticality at all.
        allergy({criticality: undefined}),
        allergy({criticality: 'severe'}),
      ]),
    );
    const kinds = (await searchAllergies(TEST_PATIENT_ID)).map(i => i.kind);
    expect(kinds).toEqual(['ok', 'ok', 'ok', 'ok', 'could-not-display']);
  });
});

describe('given a bundle with one malformed entry among good ones (FR-CARD-3)', () => {
  it('when it is parsed, then the bad entry becomes a "could not display" item in place, not dropped', async () => {
    answerSearch(
      'Condition',
      {patient: TEST_PATIENT_ID, category: 'problem-list-item'},
      searchBundle([
        condition({id: 'test-condition-0001'}),
        condition({id: 'test-condition-0002', code: {text: 42}}),
        condition({id: 'test-condition-0003'}),
      ]),
    );
    const items = await searchProblems(TEST_PATIENT_ID);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({kind: 'ok'});
    expect(items[1]).toEqual({
      kind: 'could-not-display',
      resourceType: 'Condition',
      reason: 'invalid field: code.text (invalid_type)',
    });
    expect(items[2]).toMatchObject({kind: 'ok'});
  });

  it('when an entry is the wrong resource type or has no resource, then each becomes a "could not display" item', async () => {
    answerSearch(
      'CareTeam',
      {patient: TEST_PATIENT_ID},
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [
          {resource: {resourceType: 'OperationOutcome', issue: []}},
          {fullUrl: 'https://openemr.test/x'},
        ],
      },
    );
    expect(await searchCareTeams(TEST_PATIENT_ID)).toEqual([
      {
        kind: 'could-not-display',
        resourceType: 'CareTeam',
        reason: 'entry is not a CareTeam',
      },
      {
        kind: 'could-not-display',
        resourceType: 'CareTeam',
        reason: 'entry has no resource',
      },
    ]);
  });

  it('when a malformed entry carries patient data in its fields, then none of it reaches the item, the console or an error (NFR-SEC-6)', async () => {
    const logged = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    answerSearch(
      'AllergyIntolerance',
      {patient: TEST_PATIENT_ID},
      searchBundle([
        allergy({criticality: CANARY, code: {text: CANARY}}),
        allergy({id: CANARY, reaction: CANARY}),
      ]),
    );
    const items = await searchAllergies(TEST_PATIENT_ID);
    expect(items.map(i => i.kind)).toEqual([
      'could-not-display',
      'could-not-display',
    ]);
    expect(JSON.stringify(items)).not.toContain(CANARY);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it('when the patient read itself is malformed, then it becomes a "could not display" value', async () => {
    answerSearch(
      `Patient/${TEST_PATIENT_ID}`,
      {},
      patient({birthDate: 'not a date'}),
    );
    expect(await readPatient(TEST_PATIENT_ID)).toEqual({
      kind: 'could-not-display',
      resourceType: 'Patient',
      reason: 'invalid field: birthDate (invalid_format)',
    });
  });
});

describe('given an empty or unusual search result', () => {
  it('when the bundle has no entries, then the result is an empty list', async () => {
    answerSearch(
      'CareTeam',
      {patient: TEST_PATIENT_ID},
      {resourceType: 'Bundle', type: 'collection', total: 0},
    );
    expect(await searchCareTeams(TEST_PATIENT_ID)).toEqual([]);
  });

  it('when a search answers with something other than a Bundle, then the failure is a malformed response', async () => {
    answerSearch('CareTeam', {patient: TEST_PATIENT_ID}, careTeam());
    const failure = await searchCareTeams(TEST_PATIENT_ID).then(
      () => undefined,
      (error: unknown) => (error instanceof ApiError ? error.failure : error),
    );
    expect(failure).toEqual({
      kind: 'malformed-response',
      apiId: 'API-17',
      status: 200,
    });
  });

  it('when a read answers with a different resource type, then the failure is a malformed response', async () => {
    answerSearch('Organization/test-org-0001', {}, practitioner());
    await expect(readOrganization('test-org-0001')).rejects.toMatchObject({
      failure: {kind: 'malformed-response', apiId: 'API-19'},
    });
  });
});

describe('given a search result that says it holds more than it sent (BUG-7)', () => {
  const nextLink = {
    relation: 'next',
    url: 'https://openemr.test/apis/default/fhir/X?_offset=2',
  };

  it('when the Bundle carries a next link, then every entry is kept in order and a trailing "more not shown" item follows them (guards results dropped silently on paging)', async () => {
    const bundle = searchBundle([
      allergy({id: 'test-allergy-0001'}),
      allergy({id: 'test-allergy-0002'}),
    ]);
    answerSearch(
      'AllergyIntolerance',
      {patient: TEST_PATIENT_ID},
      {
        ...bundle,
        link: [...(bundle.link as unknown[]), nextLink],
      },
    );
    const items = await searchAllergies(TEST_PATIENT_ID);
    expect(items).toMatchObject([
      {kind: 'ok', resource: {id: 'test-allergy-0001'}},
      {kind: 'ok', resource: {id: 'test-allergy-0002'}},
      {kind: 'more-not-shown', resourceType: 'AllergyIntolerance'},
    ]);
  });

  it('when total is larger than the entries returned, then a trailing "more not shown" item follows them', async () => {
    answerSearch(
      'Condition',
      {patient: TEST_PATIENT_ID, category: 'problem-list-item'},
      {...searchBundle([condition()]), total: 5},
    );
    const items = await searchProblems(TEST_PATIENT_ID);
    expect(items.map(item => item.kind)).toEqual(['ok', 'more-not-shown']);
  });

  it('when total says there are results but no entry came back, then the signal is the only item — never an empty list', async () => {
    answerSearch(
      'CareTeam',
      {patient: TEST_PATIENT_ID},
      {resourceType: 'Bundle', type: 'collection', total: 3},
    );
    expect(await searchCareTeams(TEST_PATIENT_ID)).toEqual([
      {
        kind: 'more-not-shown',
        resourceType: 'CareTeam',
        reason: 'more results not shown: total 3, 0 sent',
      },
    ]);
  });

  it('when OpenEMR answers as it does today — a self link and total equal to the entries — then no signal is added', async () => {
    answerSearch(
      'CareTeam',
      {patient: TEST_PATIENT_ID},
      searchBundle([careTeam(), careTeam({id: 'test-careteam-0002'})]),
    );
    const items = await searchCareTeams(TEST_PATIENT_ID);
    expect(items.map(item => item.kind)).toEqual(['ok', 'ok']);
  });

  it('when the shared medication read is partial, then both the Medications and the Prescriptions halves carry the signal', async () => {
    answerSearch(
      'MedicationRequest',
      {patient: TEST_PATIENT_ID},
      {...searchBundle([medicationRequest()]), total: 2},
    );
    const reads = await searchMedicationRequests(TEST_PATIENT_ID);
    expect(reads.medications.map(item => item.kind)).toEqual([
      'ok',
      'more-not-shown',
    ]);
    expect(reads.prescriptions.at(-1)?.kind).toBe('more-not-shown');
  });

  it('when a malformed total or link arrives, then the entries still parse and no signal is invented', async () => {
    answerSearch(
      'CareTeam',
      {patient: TEST_PATIENT_ID},
      {
        ...searchBundle([careTeam()]),
        total: 'many',
        link: [{relation: 'next'}],
      },
    );
    const items = await searchCareTeams(TEST_PATIENT_ID);
    expect(items.map(item => item.kind)).toEqual(['ok']);
  });
});

describe('given an Encounter whose class OpenEMR does not know (BUG-50)', () => {
  const dataAbsentClass = {
    coding: [
      {
        system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
        code: 'unknown',
        display: 'Unknown',
      },
    ],
  };

  it('when OpenEMR puts its data-absent CodeableConcept in the class slot, then class parses as an explicit unknown, not an empty coding', async () => {
    answerSearch(
      'Encounter',
      {patient: TEST_PATIENT_ID, date: 'ge2024-09-24'},
      searchBundle([encounter({class: dataAbsentClass})]),
    );
    const [item] = await searchEncounters(TEST_PATIENT_ID, '2024-09-24');
    if (item?.kind !== 'ok') throw new Error('expected a parsed encounter');
    expect(item.resource.class).toEqual({
      extension: [
        {
          url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
          valueCode: 'unknown',
        },
      ],
    });
    expect(dataAbsentReason(item.resource.class)).toBe('unknown');
  });

  it('when a class has a code, or has nothing at all, then it is not unknown — a card can tell unknown from missing', async () => {
    answerSearch(
      'Encounter',
      {patient: TEST_PATIENT_ID, date: 'ge2024-09-24'},
      searchBundle([
        encounter(),
        encounter({id: 'test-encounter-0002', class: {}}),
      ]),
    );
    const items = await searchEncounters(TEST_PATIENT_ID, '2024-09-24');
    const classes = items.map(item =>
      item.kind === 'ok' ? item.resource.class : undefined,
    );
    expect(classes).toEqual([
      {
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        code: 'AMB',
        display: 'ambulatory',
      },
      {},
    ]);
    expect(classes.map(value => value && dataAbsentReason(value))).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('when the data-absent coding carries a reason code FHIR does not define, then it is still an explicit unknown and the raw code is not kept', async () => {
    answerSearch(
      'Encounter',
      {patient: TEST_PATIENT_ID, date: 'ge2024-09-24'},
      searchBundle([
        encounter({
          class: {
            coding: [
              {
                system:
                  'http://terminology.hl7.org/CodeSystem/data-absent-reason',
                code: CANARY,
              },
            ],
          },
        }),
      ]),
    );
    const [item] = await searchEncounters(TEST_PATIENT_ID, '2024-09-24');
    if (item?.kind !== 'ok') throw new Error('expected a parsed encounter');
    expect(dataAbsentReason(item.resource.class)).toBe('unknown');
    expect(JSON.stringify(item)).not.toContain(CANARY);
  });
});

describe('given the Labs search (API-22)', () => {
  it('when lab results are searched, then API-22 sends the patient, the laboratory category and a lower date bound — no code, paging or sort (BUG-7, BUG-36)', async () => {
    answerSearch(
      'Observation',
      {patient: TEST_PATIENT_ID, category: 'laboratory', date: 'ge2025-09-25'},
      searchBundle([labResult()]),
    );
    expect(await searchLabResults(TEST_PATIENT_ID, '2025-09-25')).toEqual([
      {
        kind: 'ok',
        resource: expect.objectContaining({
          resourceType: 'Observation',
          id: 'test-lab-result-0001',
          status: 'final',
          effectiveDateTime: '2026-08-30T10:15:00-04:00',
          valueQuantity: {value: 7.1, unit: '%', code: '%'},
        }) as unknown,
      },
    ]);
  });

  it('when a result carries a text, coded or absent value and a flag, then each parses', async () => {
    answerSearch(
      'Observation',
      {patient: TEST_PATIENT_ID, category: 'laboratory', date: 'ge2025-09-25'},
      searchBundle([
        labResult({id: 'r-text', valueQuantity: undefined, valueString: '<5'}),
        labResult({
          id: 'r-coded',
          valueQuantity: undefined,
          valueCodeableConcept: {coding: [{code: 'x', display: 'Test'}]},
          interpretation: [{coding: [{code: 'H', display: 'High'}]}],
        }),
        labResult({
          id: 'r-absent',
          valueQuantity: undefined,
          dataAbsentReason: {coding: [{code: 'unknown'}]},
        }),
      ]),
    );
    const items = await searchLabResults(TEST_PATIENT_ID, '2025-09-25');
    expect(items.map(item => item.kind)).toEqual(['ok', 'ok', 'ok']);
  });

  it('when the patient id is not a FHIR id, then API-22 fails with invalid-id and nothing is sent', async () => {
    let requests = 0;
    server.use(
      http.get('/bff/*', () => {
        requests += 1;
        return HttpResponse.json({}, {status: 500});
      }),
    );
    await expect(
      searchLabResults('../Patient', '2025-09-25'),
    ).rejects.toMatchObject({failure: {kind: 'invalid-id', apiId: 'API-22'}});
    expect(requests).toBe(0);
  });
});
