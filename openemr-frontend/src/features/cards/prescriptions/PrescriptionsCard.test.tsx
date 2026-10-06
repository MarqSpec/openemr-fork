import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import {delay, http, HttpResponse} from 'msw';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {
  TEST_PATIENT_ID,
  medicationRequest,
  operationOutcome,
  organization,
  practitioner,
  prescription,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme} from '../../../theme/theme';
import {PrescriptionsCard} from './PrescriptionsCard';

// reference: REQUIREMENTS.md FR-CARD-RX-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// INTERFACES.md API-16, API-18 · REQUIREMENTS.md SCR-DASH-RX · REQUIREMENTS.md BUG-10, BUG-13, BUG-48 ·
// a separate change (and the maintainer rulings)

const MEDICATION_REQUEST = '/bff/fhir/MedicationRequest';
const PRACTITIONER = '/bff/fhir/Practitioner/:id';
const ORGANIZATION = '/bff/fhir/Organization/:id';

interface Answers {
  readonly prescriptions: () => Response | Promise<Response>;
  readonly practitioner?: () => Response | Promise<Response>;
}

function renderCard(answers: Answers) {
  const requests: URL[] = [];
  const practitionerReads: string[] = [];
  server.use(
    http.get(MEDICATION_REQUEST, ({request}) => {
      requests.push(new URL(request.url));
      return answers.prescriptions();
    }),
    http.get(PRACTITIONER, ({params}) => {
      practitionerReads.push(String(params.id));
      return answers.practitioner?.() ?? HttpResponse.json(practitioner());
    }),
  );
  render(
    <QueryClientProvider
      client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
    >
      <ThemeProvider theme={createAppTheme('light')}>
        <PrescriptionsCard patientId={TEST_PATIENT_ID} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return {requests, practitionerReads};
}

const renderPrescriptions = (resources: readonly unknown[]) =>
  renderCard({prescriptions: () => HttpResponse.json(searchBundle(resources))});

const card = () => screen.findByRole('region', {name: 'Prescriptions'});

/** Each row's text, once every prescriber name has settled. */
async function shownRows(): Promise<(string | null)[]> {
  const list = await within(await card()).findByRole('list');
  const rows = within(list).getAllByRole('listitem');
  await waitFor(() => {
    for (const row of rows) expect(row).not.toHaveTextContent('Loading');
  });
  return rows.map(row => row.textContent);
}

/** The fields after the drug name, in the legacy column order (Drug · Details · Qty · Refills · Date, general_fragment.html), plus prescriber and status (FR-CARD-RX-1). */
function fields(values: {
  sig?: string;
  qty?: string;
  refills?: string;
  prescriber?: string;
  date?: string;
  status?: string;
}): string {
  return [
    `Sig: ${values.sig ?? 'Test sig: once daily'}`,
    `Qty: ${values.qty ?? `30${WHOLE_NUMBER}`}`,
    `Refills: ${values.refills ?? '2'}`,
    `Prescriber: ${values.prescriber ?? 'Fakedoc Testdoctor'}`,
    `Date: ${values.date ?? '2026-01-02'}`,
    `Status: ${values.status ?? 'Active'}`,
  ].join('');
}

/** OpenEMR sends `intval(quantity)` of a free-text field, so every quantity it sends may be truncated (BUG-48). */
const WHOLE_NUMBER = ' (whole number; check in OpenEMR)';

const NO_DISPENSING =
  'May be a medication-list entry: OpenEMR sent no dispensing details';

describe('given the Prescriptions read (API-16)', () => {
  it("when the card loads, then it asks once for all of the patient's MedicationRequests, with no intent and no status filter (guards an intent=order read that misses a prescription saved with Request Intent Plan — BUG-13)", async () => {
    const {requests} = renderPrescriptions([prescription()]);
    await within(await card()).findByText('Test drug A 10 mg');

    expect(requests).toHaveLength(1);
    const params = requests[0]?.searchParams;
    expect(params?.get('patient')).toBe(TEST_PATIENT_ID);
    expect(params?.has('intent')).toBe(false);
    expect(params?.has('status')).toBe(false);
  });
});

// Legacy (templates/prescription/general_fragment.html): one row per prescription whose `active` is 1, columns
// Drug · Details · Qty · Refills · Filled (date added). FR-CARD-RX-1 adds prescriber and status.
describe('given a patient with prescriptions (FR-CARD-RX-1, SCR-DASH-RX)', () => {
  it('when the card loads, then each row shows drug, sig, quantity, refills, prescriber, date and status, in that order', async () => {
    renderPrescriptions([prescription()]);

    expect(await shownRows()).toEqual([`Test drug A 10 mg${fields({})}`]);
  });

  it('when the sig has timing, then the timing follows the text; route and dose strength are not shown (legacy Details has no route; OpenEMR truncates the strength — BUG-48)', async () => {
    renderPrescriptions([
      prescription({
        dosageInstruction: [
          {
            text: 'Test sig one',
            timing: {code: {text: 'twice daily'}},
            route: {text: 'Test route'},
            doseAndRate: [{doseQuantity: {value: 2, unit: 'mg'}}],
          },
          {},
          {timing: {code: {text: 'at bedtime'}}},
        ],
      }),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({sig: 'Test sig one twice daily; at bedtime'})}`,
    ]);
  });

  it('when a field is missing, then it reads "—", never blank and never zero; a missing quantity or refills says to check OpenEMR (OpenEMR drops a non-numeric quantity — BUG-48)', async () => {
    renderPrescriptions([
      prescription({
        dosageInstruction: undefined,
        dispenseRequest: undefined,
        authoredOn: undefined,
      }),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${NO_DISPENSING}${fields({sig: '—', qty: 'check in OpenEMR', refills: 'check in OpenEMR', date: '—'})}`,
    ]);
  });

  it('when the quantity has a unit, then only the number is shown, qualified (OpenEMR labels it with the drug strength unit — BUG-48)', async () => {
    renderPrescriptions([
      prescription({
        dispenseRequest: {
          quantity: {value: 60, unit: 'mg'},
          numberOfRepeatsAllowed: 5,
        },
      }),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({qty: `60${WHOLE_NUMBER}`, refills: '5'})}`,
    ]);
  });

  it('when a quantity arrives, then it is never shown as a bare number: OpenEMR truncates a stored "8.5" to 8, so the card says it is a whole number to check in OpenEMR (BUG-48)', async () => {
    renderPrescriptions([
      prescription({
        dispenseRequest: {quantity: {value: 8}, numberOfRepeatsAllowed: 2},
      }),
    ]);

    const rows = await shownRows();
    expect(rows).toEqual([
      `Test drug A 10 mg${fields({qty: `8${WHOLE_NUMBER}`})}`,
    ]);
    expect(rows[0]).not.toMatch(/Qty: \d+Refills/);
  });

  it('when the quantity arrives as 0 (OpenEMR truncates a stored "0.5" to 0), then the card says to check OpenEMR and shows no number (BUG-48)', async () => {
    renderPrescriptions([
      prescription({
        dispenseRequest: {quantity: {value: 0}, numberOfRepeatsAllowed: 2},
      }),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({qty: 'check in OpenEMR'})}`,
    ]);
  });

  it('when refills arrive as 0, then the card says to check OpenEMR rather than claim none (OpenEMR always sends 0 — BUG-48)', async () => {
    renderPrescriptions([
      prescription({
        dispenseRequest: {
          quantity: {value: 30},
          numberOfRepeatsAllowed: 0,
        },
      }),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({refills: 'check in OpenEMR'})}`,
    ]);
  });

  it('when a prescription has no name text but a coded display, then it shows the coded display; with neither, "Untitled prescription"', async () => {
    renderPrescriptions([
      prescription({
        id: 'test-rx-0001',
        medicationCodeableConcept: {
          coding: [{system: 'urn:test', code: 'X1', display: 'Coded drug A'}],
        },
      }),
      prescription({id: 'test-rx-0002', medicationCodeableConcept: undefined}),
    ]);

    expect(await shownRows()).toEqual([
      `Coded drug A${fields({})}`,
      `Untitled prescription${fields({})}`,
    ]);
  });
});

// The prescriber is a reference; its name needs API-18, which needs admin/users (BUG-10). W-5: "Name unavailable".
describe('given the prescriber (API-18, BUG-10)', () => {
  it('when the Practitioner read is refused, then the row says "Name unavailable" and every other field still shows', async () => {
    renderCard({
      prescriptions: () => HttpResponse.json(searchBundle([prescription()])),
      practitioner: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({prescriber: 'Name unavailable'})}`,
    ]);
  });

  it('when two prescriptions share a prescriber, then the name is read once', async () => {
    const {practitionerReads} = renderPrescriptions([
      prescription({id: 'test-rx-0001'}),
      prescription({id: 'test-rx-0002'}),
    ]);

    expect(await shownRows()).toHaveLength(2);
    expect(practitionerReads).toEqual(['test-practitioner-0001']);
  });

  it('when the reference carries a display name, then it is used without a read', async () => {
    const {practitionerReads} = renderPrescriptions([
      prescription({
        requester: {
          reference: 'Practitioner/test-practitioner-0002',
          display: 'Test Displayname',
        },
      }),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({prescriber: 'Test Displayname'})}`,
    ]);
    expect(practitionerReads).toEqual([]);
  });

  it.each([
    [
      'an Organization (OpenEMR sends one when the prescriber has no NPI)',
      {reference: 'Organization/test-org-0001'},
    ],
    ['absent', undefined],
  ])(
    'when the requester is %s, then the row says "Name unavailable" and nothing is read',
    async (_case, requester) => {
      const {practitionerReads} = renderPrescriptions([
        prescription({requester}),
      ]);

      expect(await shownRows()).toEqual([
        `Test drug A 10 mg${fields({prescriber: 'Name unavailable'})}`,
      ]);
      expect(practitionerReads).toEqual([]);
    },
  );

  it('when the requester is Organization/… and the Organization endpoint is reachable, then the row says "Name unavailable" and the Organization is never read (guards a readable set widened to include Organization)', async () => {
    const organizationReads: string[] = [];
    server.use(
      http.get(ORGANIZATION, ({params}) => {
        organizationReads.push(String(params.id));
        return HttpResponse.json(organization());
      }),
    );
    const {practitionerReads} = renderPrescriptions([
      prescription({requester: {reference: 'Organization/test-org-0001'}}),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({prescriber: 'Name unavailable'})}`,
    ]);
    expect(practitionerReads).toEqual([]);
    expect(organizationReads).toEqual([]);
  });

  it('when the Practitioner has no name, then the row says "Name unavailable"', async () => {
    renderCard({
      prescriptions: () => HttpResponse.json(searchBundle([prescription()])),
      practitioner: () => HttpResponse.json(practitioner({name: undefined})),
    });

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({prescriber: 'Name unavailable'})}`,
    ]);
  });
});

// Legacy shows `active = 1` rows only. OpenEMR maps that exactly: active with no end date → "active", active with
// an end date (past or to come) → "completed", not active → "stopped" (PrescriptionService).
describe('given prescriptions of each status (legacy `active > 0`)', () => {
  it('when a prescription is "stopped" (not active in OpenEMR), then it is not shown, as legacy hides it', async () => {
    renderPrescriptions([
      prescription({id: 'test-rx-0001', status: 'stopped'}),
      prescription({
        id: 'test-rx-0002',
        medicationCodeableConcept: {text: 'Test drug B'},
      }),
    ]);

    expect(await shownRows()).toEqual([`Test drug B${fields({})}`]);
  });

  it('when a prescription is "completed" (it has an end date, which may still be to come), then it is shown, as legacy shows it, and says so', async () => {
    renderPrescriptions([prescription({status: 'completed'})]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({status: 'Completed — it has an end date, which may still be to come. Check it in OpenEMR.'})}`,
    ]);
  });

  it.each(['on-hold', 'unknown', 'draft'] as const)(
    'when a prescription is "%s" (OpenEMR never sends it), then it is shown with the raw status',
    async status => {
      renderPrescriptions([prescription({status})]);

      expect(await shownRows()).toEqual([
        `Test drug A 10 mg${fields({status})}`,
      ]);
    },
  );

  it('when every prescription is stopped, then the card reads the legacy "None"', async () => {
    renderPrescriptions([prescription({status: 'stopped'})]);

    expect(await within(await card()).findByText('None')).toBeInTheDocument();
  });
});

// the notes: FHIR cannot tell a prescription from a medication-list entry (BUG-13). A prescription saved with
// Request Intent "Plan" arrives as intent=plan, like every list entry with no stored intent. A list entry never
// carries a quantity, route, timing or dose (PrescriptionService selects NULL for them), so a plan entry with any
// of those is a prescription; one with none is left to the Medications card. Err toward showing everything else.
describe('given entries of every intent (BUG-13, the rulings)', () => {
  it('when an entry is intent=order, then it carries no intent label', async () => {
    renderPrescriptions([prescription({intent: 'order'})]);

    expect(await shownRows()).toEqual([`Test drug A 10 mg${fields({})}`]);
  });

  it.each([
    ['a quantity', {dispenseRequest: {quantity: {value: 30}}}],
    [
      'a route',
      {
        dispenseRequest: undefined,
        dosageInstruction: [
          {text: 'Test sig: once daily', route: {text: 'oral'}},
        ],
      },
    ],
    [
      'a timing',
      {
        dispenseRequest: undefined,
        dosageInstruction: [
          {text: 'Test sig: once daily', timing: {code: {text: 'daily'}}},
        ],
      },
    ],
    [
      'a dose',
      {
        dispenseRequest: undefined,
        dosageInstruction: [
          {
            text: 'Test sig: once daily',
            doseAndRate: [{doseQuantity: {value: 1}}],
          },
        ],
      },
    ],
  ])(
    'when an intent=plan entry carries %s (a prescription saved with Request Intent Plan), then it is shown, labelled "Intent: Plan"',
    async (_case, details) => {
      renderPrescriptions([prescription({intent: 'plan', ...details})]);

      const [row] = await shownRows();
      expect(row).toMatch(/^Test drug A 10 mgIntent: PlanSig: /);
    },
  );

  it('when an intent=plan entry carries no dispensing details (a medication-list entry), then it is not shown here — the Medications card lists it', async () => {
    renderPrescriptions([
      medicationRequest({id: 'test-medreq-0001', intent: 'plan'}),
      prescription({
        id: 'test-rx-0002',
        medicationCodeableConcept: {text: 'Test drug B'},
      }),
    ]);

    expect(await shownRows()).toEqual([`Test drug B${fields({})}`]);
  });

  it.each([
    ['proposal', 'Intent: Proposal'],
    ['original-order', 'Intent: Original order'],
    ['reflex-order', 'Intent: Reflex order'],
    ['filler-order', 'Intent: Filler order'],
    ['instance-order', 'Intent: Instance order'],
    ['option', 'Intent: Option'],
    ['test-unknown-intent', 'Intent: test-unknown-intent'],
    // A code that names an Object.prototype member is still shown as sent, never looked up on the prototype.
    ['constructor', 'Intent: constructor'],
    ['toString', 'Intent: toString'],
  ])(
    'when an entry is intent=%s, then it is shown, labelled "%s"',
    async (intent, label) => {
      renderPrescriptions([prescription({intent})]);

      expect(await shownRows()).toEqual([
        `Test drug A 10 mg${label}${fields({})}`,
      ]);
    },
  );

  it('when an entry that is not intent=plan carries no dispensing details, then it is shown, marked as possibly a medication-list entry (the legacy Add-medication form saves Order by default)', async () => {
    renderPrescriptions([
      medicationRequest({
        intent: 'order',
        requester: {reference: 'Practitioner/test-practitioner-0001'},
      }),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${NO_DISPENSING}${fields({qty: 'check in OpenEMR', refills: 'check in OpenEMR', date: '—'})}`,
    ]);
  });
});

// Legacy order (Prescription::prescriptions_factory): date modified, newest first, then date added. OpenEMR sends
// date_modified as meta.lastUpdated and date_added as authoredOn.
describe('given several prescriptions (legacy order)', () => {
  it('when the card loads, then rows are newest-modified first, then newest-added; undated and malformed rows follow in server order', async () => {
    renderPrescriptions([
      prescription({
        id: 'test-rx-undated',
        medicationCodeableConcept: {text: 'Undated'},
        authoredOn: undefined,
      }),
      prescription({
        id: 'test-rx-old',
        medicationCodeableConcept: {text: 'Modified 2025'},
        meta: {lastUpdated: '2025-06-01T05:00:00+00:00'},
      }),
      prescription({id: 'test-rx-malformed', status: undefined}),
      prescription({
        id: 'test-rx-added-late',
        medicationCodeableConcept: {text: 'Added later'},
        authoredOn: '2026-03-01',
      }),
      prescription({
        id: 'test-rx-new',
        medicationCodeableConcept: {text: 'Modified 2026'},
        meta: {lastUpdated: '2026-02-01T05:00:00+00:00'},
      }),
    ]);

    const rows = await shownRows();
    expect(rows.map(row => row?.replace(/Sig: .*$/, ''))).toEqual([
      'Modified 2026',
      'Modified 2025',
      'Added later',
      'Undated',
      '⚠ Could not display this item',
    ]);
  });
});

// OpenEMR stamps both dates with the server's current offset (KNOWN_BUGS BUG-51); +14:00 and -12:00 together fail
// an instant reading on any runner.
describe('given prescription dates stamped with extreme offsets (BUG-51)', () => {
  it('when two were modified the same day, then the later wall-clock time comes first, not the later instant', async () => {
    renderPrescriptions([
      prescription({
        id: 'test-rx-west',
        medicationCodeableConcept: {text: 'Eight'},
        meta: {lastUpdated: '2026-02-01T08:00:00-12:00'},
      }),
      prescription({
        id: 'test-rx-east',
        medicationCodeableConcept: {text: 'Nine'},
        meta: {lastUpdated: '2026-02-01T09:00:00+14:00'},
      }),
    ]);

    const rows = await shownRows();
    expect(rows.map(row => row?.replace(/Sig: .*$/, ''))).toEqual([
      'Nine',
      'Eight',
    ]);
  });

  it.each(['+14:00', '-12:00'])(
    'when authoredOn is midnight at %s, then the Date column shows the day OpenEMR recorded',
    async offset => {
      renderPrescriptions([
        prescription({authoredOn: `2026-01-02T00:00:00${offset}`}),
      ]);

      expect(await shownRows()).toEqual([`Test drug A 10 mg${fields({})}`]);
    },
  );
});

describe('given a patient with no prescriptions', () => {
  it('when the card loads, then it shows the legacy empty wording "None" (FR-CARD-4)', async () => {
    renderPrescriptions([]);

    expect(await within(await card()).findByText('None')).toBeInTheDocument();
  });
});

describe('given an entry that does not match the schema (FR-CARD-3)', () => {
  it('when the card loads, then that row says "Could not display this item" and the other rows still show (guards a dropped prescription)', async () => {
    renderPrescriptions([
      prescription({id: 'test-rx-0001'}),
      prescription({id: 'test-rx-0002', status: undefined}),
    ]);

    expect(await shownRows()).toEqual([
      `Test drug A 10 mg${fields({})}`,
      '⚠ Could not display this item',
    ]);
  });
});

describe('given the read is slow', () => {
  it('when the card waits, then it says it is loading prescriptions', async () => {
    renderCard({
      prescriptions: async () => {
        await delay('infinite');
        return HttpResponse.json(searchBundle([]));
      },
    });

    expect(
      await within(await card()).findByText('Loading prescriptions…'),
    ).toBeInTheDocument();
  });
});

describe('given the read fails', () => {
  it('when OpenEMR refuses it (403), then the card says the user is not authorised, never "None" (FR-AUTH-5)', async () => {
    renderCard({
      prescriptions: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });

    const alert = await within(await card()).findByRole('alert');
    expect(alert).toHaveTextContent(
      "You're not authorised to view prescriptions.",
    );
    expect(await card()).not.toHaveTextContent('None');
  });

  it('when the server errors (500), then the card says it could not load prescriptions and offers a retry', async () => {
    renderCard({
      prescriptions: () =>
        HttpResponse.json(operationOutcome('exception'), {status: 500}),
    });

    const alert = await within(await card()).findByRole('alert');
    expect(alert).toHaveTextContent(
      "Couldn't load prescriptions (server error).",
    );
    expect(
      within(alert).getByRole('button', {name: 'Try again'}),
    ).toBeInTheDocument();
  });
});
