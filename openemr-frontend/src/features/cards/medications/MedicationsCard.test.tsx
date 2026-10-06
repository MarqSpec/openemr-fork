import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, within} from '@testing-library/react';
import {delay, http, HttpResponse} from 'msw';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {
  TEST_PATIENT_ID,
  medicationRequest,
  operationOutcome,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme} from '../../../theme/theme';
import {MedicationsCard} from './MedicationsCard';

// reference: REQUIREMENTS.md FR-CARD-MED-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// INTERFACES.md API-15 · REQUIREMENTS.md SCR-DASH-MED · REQUIREMENTS.md BUG-13, BUG-44

const MEDICATION_REQUEST = '/bff/fhir/MedicationRequest';

function renderCard(respond: () => Response | Promise<Response>) {
  const requests: URL[] = [];
  server.use(
    http.get(MEDICATION_REQUEST, ({request}) => {
      requests.push(new URL(request.url));
      return respond();
    }),
  );
  render(
    <QueryClientProvider
      client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
    >
      <ThemeProvider theme={createAppTheme('light')}>
        <MedicationsCard patientId={TEST_PATIENT_ID} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return {requests};
}

const renderMedications = (resources: readonly unknown[]) =>
  renderCard(() => HttpResponse.json(searchBundle(resources)));

const ORDER_LABEL = 'Order — may also be listed under Prescriptions';

/** An entry with the given intent and name; the legacy Add-medication form saves Order by default. */
const withIntent = (
  intent: string,
  text: string,
  overrides: Record<string, unknown> = {},
) =>
  medicationRequest({
    id: `test-medreq-${text.replace(/[^A-Za-z0-9]/g, '-')}`,
    intent,
    medicationCodeableConcept: {text},
    dosageInstruction: undefined,
    ...overrides,
  });

const card = () => screen.findByRole('region', {name: 'Medications'});

async function shownRows(): Promise<(string | null)[]> {
  const list = await within(await card()).findByRole('list');
  return within(list)
    .getAllByRole('listitem')
    .map(row => row.textContent);
}

describe('given the Medications read (API-15)', () => {
  it("when the card loads, then it asks once for all of the patient's MedicationRequests, with no intent and no status filter (guards an intent filter that hides a medication saved with a non-Plan Request Intent, and a status=active search that hides one ending later — BUG-13, BUG-44)", async () => {
    const {requests} = renderMedications([medicationRequest()]);
    await within(await card()).findByText('Test drug A 10 mg');

    expect(requests).toHaveLength(1);
    const params = requests[0]?.searchParams;
    expect(params?.get('patient')).toBe(TEST_PATIENT_ID);
    expect(params?.has('intent')).toBe(false);
    expect(params?.has('status')).toBe(false);
  });
});

// The maintainer's rulings (from the !115 review, note 87599, then extended): a medication-list entry's
// intent is its Request Intent — Order by default in the legacy Add form — and FHIR cannot tell such an entry from a
// prescription, so the card reads every intent and labels every row that is not Plan. A Plan entry carries no label,
// though it is not always the medication list: a prescription saved with Request Intent "Plan" arrives as plan too.
describe('given entries of every intent (the rulings, BUG-13)', () => {
  it('when the only entry is intent=order, then it is shown with its label, never "Nothing Recorded"', async () => {
    renderMedications([
      withIntent('order', 'Added through the legacy form', {
        dosageInstruction: [{text: 'Test sig: nightly'}],
      }),
    ]);

    expect(await shownRows()).toEqual([
      `Added through the legacy form${ORDER_LABEL}Test sig: nightly`,
    ]);
    expect(await card()).not.toHaveTextContent('Nothing Recorded');
  });

  it('when an entry is intent=plan, then it carries no label', async () => {
    renderMedications([medicationRequest()]);

    expect(await shownRows()).toEqual([
      'Test drug A 10 mgTest sig: once daily',
    ]);
  });

  it.each([
    ['proposal', 'Intent: Proposal'],
    ['original-order', 'Intent: Original order'],
    ['reflex-order', 'Intent: Reflex order'],
    ['filler-order', 'Intent: Filler order'],
    ['instance-order', 'Intent: Instance order'],
    ['option', 'Intent: Option'],
  ])(
    'when an entry is intent=%s, then it is shown, labelled "%s"',
    async (intent, label) => {
      renderMedications([withIntent(intent, 'Test drug E')]);

      expect(await shownRows()).toEqual([`Test drug E${label}`]);
    },
  );

  it('when an entry has an intent code outside FHIR R4, then it is shown, not dropped, labelled with the raw code', async () => {
    renderMedications([withIntent('test-unknown-intent', 'Test drug F')]);

    expect(await shownRows()).toEqual([
      'Test drug FIntent: test-unknown-intent',
    ]);
  });

  // the label lookup must not read Object.prototype.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'when an entry has the intent code "%s" (a name Object.prototype carries), then it is labelled with the raw code',
    async intent => {
      renderMedications([withIntent(intent, 'Test drug G')]);

      expect(await shownRows()).toEqual([`Test drug GIntent: ${intent}`]);
    },
  );

  it('when intents are mixed, then the intent=plan entries come first in server order, then every other entry — a malformed one included — in server order', async () => {
    renderMedications([
      withIntent('order', 'Order D'),
      withIntent('plan', 'Plan B'),
      withIntent('proposal', 'Proposal E'),
      medicationRequest({id: 'test-medreq-malformed', status: undefined}),
      withIntent('plan', 'Plan A'),
      withIntent('order', 'Order C'),
    ]);

    expect(await shownRows()).toEqual([
      'Plan B',
      'Plan A',
      `Order D${ORDER_LABEL}`,
      'Proposal EIntent: Proposal',
      '⚠ Could not display this item',
      `Order C${ORDER_LABEL}`,
    ]);
  });
});

// Legacy: each row is the list entry's title, then its dosage instructions (medication.html.twig), for every
// entry whose Outcome is not "Resolved" and whose end date is empty or still to come (filterActiveIssues).
describe('given a patient with medication-list entries (FR-CARD-MED-1, SCR-DASH-MED)', () => {
  it('when the card loads, then each row shows the name and then the dosage instructions, in server order', async () => {
    renderMedications([
      medicationRequest({
        id: 'test-medreq-0001',
        medicationCodeableConcept: {text: 'Test drug B 5 mg'},
        dosageInstruction: [{text: 'Test sig: twice daily'}],
      }),
      medicationRequest({
        id: 'test-medreq-0002',
        medicationCodeableConcept: {text: 'Test drug A 10 mg'},
        dosageInstruction: [{text: 'Test sig: once daily'}],
      }),
    ]);

    expect(await shownRows()).toEqual([
      'Test drug B 5 mgTest sig: twice daily',
      'Test drug A 10 mgTest sig: once daily',
    ]);
  });

  it('when an entry has no dosage instructions, then the row is the name alone', async () => {
    renderMedications([medicationRequest({dosageInstruction: undefined})]);

    expect(await shownRows()).toEqual(['Test drug A 10 mg']);
  });

  it('when an entry carries several dosage instructions, then every one is shown, none dropped', async () => {
    renderMedications([
      medicationRequest({
        dosageInstruction: [{text: 'Test sig one'}, {}, {text: 'Test sig two'}],
      }),
    ]);

    expect(await shownRows()).toEqual([
      'Test drug A 10 mgTest sig one; Test sig two',
    ]);
  });

  it('when an entry has no name text but a coded display, then it shows the coded display; with neither, "Untitled medication"', async () => {
    renderMedications([
      medicationRequest({
        id: 'test-medreq-0001',
        medicationCodeableConcept: {
          coding: [{system: 'urn:test', code: 'X1', display: 'Coded drug A'}],
        },
        dosageInstruction: undefined,
      }),
      medicationRequest({
        id: 'test-medreq-0002',
        medicationCodeableConcept: undefined,
        dosageInstruction: undefined,
      }),
    ]);

    expect(await shownRows()).toEqual(['Coded drug A', 'Untitled medication']);
  });
});

// OpenEMR never sends a medication's end date. It maps the list entry to `status`: an end date — past or still to
// come — gives "completed", no end date "active", an inactive entry "stopped" (PrescriptionService, BUG-44). Legacy
// shows an entry ending later and hides one that has ended; "completed" cannot tell them apart, so the card shows
// every entry, and says when one may have ended rather than hiding it.
describe('given entries OpenEMR reports with a status other than active (BUG-44, review)', () => {
  it('when an entry is "completed" (it has an end date, which may still be to come), then it is shown, not hidden, marked as possibly ended', async () => {
    renderMedications([
      medicationRequest({
        medicationCodeableConcept: {text: 'Ending later'},
        status: 'completed',
        dosageInstruction: undefined,
      }),
    ]);

    expect(await shownRows()).toEqual([
      'Ending laterMay have ended (OpenEMR status: completed). Check its end date in OpenEMR.',
    ]);
  });

  it.each(['stopped', 'unknown', 'on-hold'] as const)(
    'when an entry is "%s", then it is shown, marked as possibly ended',
    async status => {
      renderMedications([
        medicationRequest({
          medicationCodeableConcept: {text: 'Test drug C'},
          status,
          dosageInstruction: [{text: 'Test sig'}],
        }),
      ]);

      expect(await shownRows()).toEqual([
        `Test drug CTest sigMay have ended (OpenEMR status: ${status}). Check its end date in OpenEMR.`,
      ]);
    },
  );

  it('when an entry is "active" (no end date), then no note is added', async () => {
    renderMedications([medicationRequest({status: 'active'})]);

    expect(await shownRows()).toEqual([
      'Test drug A 10 mgTest sig: once daily',
    ]);
  });
});

describe('given a patient with no medication-list entries', () => {
  it('when the card loads, then it shows the legacy empty wording "Nothing Recorded" (FR-CARD-4)', async () => {
    renderMedications([]);

    expect(
      await within(await card()).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
  });
});

describe('given an entry that does not match the schema (FR-CARD-3)', () => {
  it('when the card loads, then that row says "Could not display this item", after the plan rows as an entry of unknown intent, and the other rows still show (guards a dropped medication)', async () => {
    renderMedications([
      medicationRequest({id: 'test-medreq-0001'}),
      medicationRequest({id: 'test-medreq-0002', status: undefined}),
      medicationRequest({
        id: 'test-medreq-0003',
        medicationCodeableConcept: {text: 'Test drug B 5 mg'},
        dosageInstruction: undefined,
      }),
    ]);

    expect(await shownRows()).toEqual([
      'Test drug A 10 mgTest sig: once daily',
      'Test drug B 5 mg',
      '⚠ Could not display this item',
    ]);
  });
});

describe('given the read is slow', () => {
  it('when the card waits, then it says it is loading medications', async () => {
    renderCard(async () => {
      await delay('infinite');
      return HttpResponse.json(searchBundle([]));
    });

    expect(
      await within(await card()).findByText('Loading medications…'),
    ).toBeInTheDocument();
  });
});

describe('given the read fails', () => {
  it('when OpenEMR refuses it (403), then the card says the user is not authorised, never "Nothing Recorded" (FR-AUTH-5)', async () => {
    renderCard(() =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );

    const alert = await within(await card()).findByRole('alert');
    expect(alert).toHaveTextContent(
      "You're not authorised to view medications.",
    );
    expect(await card()).not.toHaveTextContent('Nothing Recorded');
  });

  it('when the server errors (500), then the card says it could not load medications and offers a retry', async () => {
    renderCard(() =>
      HttpResponse.json(operationOutcome('exception'), {status: 500}),
    );

    const alert = await within(await card()).findByRole('alert');
    expect(alert).toHaveTextContent(
      "Couldn't load medications (server error).",
    );
    expect(
      within(alert).getByRole('button', {name: 'Try again'}),
    ).toBeInTheDocument();
  });
});
