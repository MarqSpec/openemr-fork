import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../api/query_client';
import {blockingAxeViolations} from '../../test/axe';
import {answerDashboardReads, regionsByName} from '../../test/dashboard';
import {
  TEST_PATIENT_ID,
  condition,
  medicationRequest,
  operationOutcome,
  prescription,
  searchBundle,
} from '../../test/fhir_fixtures';
import {server} from '../../test/msw_server';
import {HEAVY_SUITE} from '../../test/timeouts';
import {createAppTheme, type ThemeMode} from '../../theme/theme';
import {Dashboard} from './Dashboard';

// Layout is proven in the browser (tests/e2e/dashboard.spec.ts); jsdom has none, so these tests hold the reading
// order, which is the medium (single-column) order and the expanded order read row by row.
// reference: REQUIREMENTS.md FR-UI-1, FR-CARD-1, NFR-UX-1, NFR-A11Y-1 · REQUIREMENTS.md SCR-DASH ·
// REQUIREMENTS.md W-3, W-4, W-5

/** The legacy order (SCR-DASH §5.3): the PAMI row, the full-width cards, then the left and right columns. */
const LEGACY_ORDER = [
  'Allergies',
  'Problem List',
  'Medications',
  'Prescriptions',
  'Care Team',
  'Encounter History',
  'Vitals',
  'Labs',
  'Immunizations',
  'Appointments',
];

function renderDashboard(mode: ThemeMode = 'light') {
  return render(
    <QueryClientProvider
      client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
    >
      <ThemeProvider theme={createAppTheme(mode)}>
        <Dashboard patientId={TEST_PATIENT_ID} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const dashboard = () => screen.getByRole('region', {name: 'Dashboard'});

/**
 * Waits inside each wired card for its row, then until nothing on the dashboard says "Loading", so axe scans every
 * card loaded, never one still loading (review: "Test Clinic" is in both Care Team and Encounter History).
 */
async function everyWiredCardLoaded(): Promise<void> {
  const board = dashboard();
  const card = regionsByName(board);
  await within(card('Problem List')).findByText('Test problem A');
  await within(card('Allergies')).findByText(
    'Test substance A (high criticality)',
  );
  await within(card('Medications')).findByText('Test drug A 10 mg');
  await within(card('Labs')).findByText('Test hemoglobin A1c');
  await within(card('Prescriptions')).findByText('Test drug A 10 mg');
  await within(card('Care Team')).findByText('Test Clinic');
  await within(card('Encounter History')).findByText('Test Clinic');
  await within(card('Vitals')).findByText('86 per min');
  await within(card('Immunizations')).findByText(
    'Test influenza vaccine, injectable',
  );
  await within(card('Appointments')).findByText('Test office visit');
  await waitFor(() => {
    expect(board).not.toHaveTextContent('Loading');
  });
}

beforeEach(() => {
  answerDashboardReads();
});

describe('given an open chart', HEAVY_SUITE, () => {
  it('when the dashboard renders, then its cards come in the legacy order (FR-UI-1, NFR-UX-1)', () => {
    renderDashboard();

    const headings = within(dashboard()).getAllByRole('heading', {level: 2});
    expect(headings).toHaveLength(LEGACY_ORDER.length);
    for (const [index, name] of LEGACY_ORDER.entries()) {
      expect(headings[index]).toHaveAccessibleName(name);
    }
  });

  it('when the dashboard renders, then every slot is a wired card and none is a placeholder', () => {
    renderDashboard();

    const card = regionsByName(dashboard());
    expect(LEGACY_ORDER).toHaveLength(10);
    for (const title of LEGACY_ORDER) {
      expect(card(title)).not.toHaveTextContent('Not shown in this app yet.');
    }
  });

  it('when the dashboard renders, then the Appointments slot is the Appointments card with its appointments, not a placeholder', async () => {
    renderDashboard();

    const appointments = within(dashboard()).getByRole('region', {
      name: 'Appointments',
    });
    expect(
      await within(appointments).findByText('Test office visit'),
    ).toBeInTheDocument();
    expect(appointments).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the dashboard renders, then the Allergies slot is the wired card, listing the allergies API-13 returned', async () => {
    renderDashboard();

    const allergies = within(dashboard()).getByRole('region', {
      name: 'Allergies',
    });
    expect(
      await within(allergies).findByText('Test substance A (high criticality)'),
    ).toBeInTheDocument();
    expect(allergies).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the dashboard renders, then the Medications slot is the Medications card with its entries, not a placeholder', async () => {
    renderDashboard();

    const medications = within(dashboard()).getByRole('region', {
      name: 'Medications',
    });
    expect(
      await within(medications).findByText('Test drug A 10 mg'),
    ).toBeInTheDocument();
    expect(medications).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the dashboard renders, then the Labs slot is the Labs card with the latest result of each test, not a placeholder', async () => {
    renderDashboard();

    const labs = within(dashboard()).getByRole('region', {name: 'Labs'});
    expect(
      await within(labs).findByText('Test hemoglobin A1c'),
    ).toBeInTheDocument();
    expect(labs).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the dashboard renders, then the Immunizations slot is the Immunizations card with its vaccines, not a placeholder', async () => {
    renderDashboard();

    const immunizations = within(dashboard()).getByRole('region', {
      name: 'Immunizations',
    });
    expect(
      await within(immunizations).findByText(
        'Test influenza vaccine, injectable',
      ),
    ).toBeInTheDocument();
    expect(immunizations).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the dashboard renders, then the Prescriptions slot is the Prescriptions card with its rows, not a placeholder', async () => {
    renderDashboard();

    const prescriptions = within(dashboard()).getByRole('region', {
      name: 'Prescriptions',
    });
    expect(
      await within(prescriptions).findByText('Test drug A 10 mg'),
    ).toBeInTheDocument();
    expect(prescriptions).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the chart loads, then one MedicationRequest read feeds both the Medications and Prescriptions cards, each keeping its own rows (guards the double read)', async () => {
    const queries: string[] = [];
    server.use(
      http.get('/bff/fhir/Condition', () =>
        HttpResponse.json(searchBundle([])),
      ),
      http.get('/bff/fhir/MedicationRequest', ({request}) => {
        queries.push(new URL(request.url).search);
        return HttpResponse.json(
          searchBundle([
            medicationRequest({
              id: 'test-medreq-0001',
              medicationCodeableConcept: {text: 'Test list drug'},
            }),
            prescription({
              medicationCodeableConcept: {text: 'Test prescribed drug'},
            }),
          ]),
        );
      }),
    );
    renderDashboard();

    const medications = within(dashboard()).getByRole('region', {
      name: 'Medications',
    });
    const prescriptions = within(dashboard()).getByRole('region', {
      name: 'Prescriptions',
    });
    expect(
      await within(medications).findByText('Test list drug'),
    ).toBeInTheDocument();
    expect(
      within(medications).getByText('Test prescribed drug'),
    ).toBeInTheDocument();
    expect(
      await within(prescriptions).findByText('Test prescribed drug'),
    ).toBeInTheDocument();
    // A plan entry with no dispensing details is the Medications card's alone (BUG-13).
    expect(prescriptions).not.toHaveTextContent('Test list drug');
    expect(queries).toEqual([`?patient=${TEST_PATIENT_ID}`]);
  });

  it('when the dashboard renders, then the Care Team slot is the Care Team card with its members, not a placeholder', async () => {
    renderDashboard();

    const team = within(dashboard()).getByRole('region', {name: 'Care Team'});
    expect(
      await within(team).findByText('Fakedoc Testdoctor'),
    ).toBeInTheDocument();
    expect(team).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the dashboard renders, then the Encounter History slot is the Encounter History card with its encounters, not a placeholder', async () => {
    renderDashboard();

    const encounters = within(dashboard()).getByRole('region', {
      name: 'Encounter History',
    });
    expect(
      await within(encounters).findByText('Test reason'),
    ).toBeInTheDocument();
    expect(encounters).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the dashboard renders, then the Vitals slot is the Vitals card with the most recent set, not a placeholder', async () => {
    renderDashboard();

    const vitals = within(dashboard()).getByRole('region', {name: 'Vitals'});
    expect(
      await within(vitals).findByText(
        'Most recent vitals from: 2026-09-10 09:00:00',
      ),
    ).toBeInTheDocument();
    expect(vitals).not.toHaveTextContent('Not shown in this app yet.');
  });

  it('when the Problem List read fails, then every other card still renders (FR-CARD-1)', async () => {
    server.use(
      http.get('/bff/fhir/Condition', () =>
        HttpResponse.json(operationOutcome('exception'), {status: 500}),
      ),
    );
    renderDashboard();

    const board = dashboard();
    const problems = within(board).getByRole('region', {name: 'Problem List'});
    expect(await within(problems).findByRole('alert')).toBeInTheDocument();
    const headings = within(board).getAllByRole('heading', {level: 2});
    expect(headings).toHaveLength(LEGACY_ORDER.length);
    for (const [index, name] of LEGACY_ORDER.entries()) {
      expect(headings[index]).toHaveAccessibleName(name);
    }
  });
});

describe.each(['light', 'dark'] as const)(
  'given the %s theme (NFR-A11Y-1)',
  HEAVY_SUITE,
  mode => {
    it('when axe scans the loaded dashboard, then it finds no serious or critical violations', async () => {
      server.use(
        http.get('/bff/fhir/Condition', () =>
          HttpResponse.json(searchBundle([condition()])),
        ),
      );
      const {container} = renderDashboard(mode);
      await everyWiredCardLoaded();

      expect(await blockingAxeViolations(container)).toEqual([]);
    });
  },
);
