import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {render, screen, within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../api/query_client';
import {regionsByName} from '../../test/dashboard';
import {
  TEST_PATIENT_ID,
  allergy,
  appointment,
  careTeam,
  condition,
  encounter,
  immunization,
  labResult,
  organization,
  practitioner,
  prescription,
  searchBundle,
  vitalsForm,
} from '../../test/fhir_fixtures';
import {server} from '../../test/msw_server';
import {HEAVY_SUITE} from '../../test/timeouts';
import {createAppTheme} from '../../theme/theme';
import {Dashboard} from './Dashboard';

// A data hook that throws is the one failure no card body can catch, so every slot is wrapped whole. The only
// way to make a real card's hook throw is to replace it. reference: REQUIREMENTS.md FR-CARD-1 ·
// review

/** The patient whose Problem List hook throws; every other patient's reads normally. */
const FAILING_PATIENT = 'test-patient-fails';

vi.mock('../../api/fhir/hooks', async importOriginal => {
  const hooks = await importOriginal<typeof import('../../api/fhir/hooks')>();
  return {
    ...hooks,
    useProblems: (patientId: string) => {
      if (patientId === FAILING_PATIENT) throw new Error('hook failure');
      return hooks.useProblems(patientId);
    },
  };
});

function answerOtherCards() {
  server.use(
    http.get('/bff/fhir/Encounter', () =>
      HttpResponse.json(searchBundle([encounter()])),
    ),
    http.get('/bff/fhir/CareTeam', () =>
      HttpResponse.json(searchBundle([careTeam()])),
    ),
    http.get('/bff/fhir/AllergyIntolerance', () =>
      HttpResponse.json(searchBundle([allergy()])),
    ),
    http.get('/bff/fhir/MedicationRequest', () =>
      HttpResponse.json(searchBundle([prescription()])),
    ),
    http.get('/bff/fhir/Practitioner/:id', () =>
      HttpResponse.json(practitioner()),
    ),
    http.get('/bff/fhir/Organization/:id', () =>
      HttpResponse.json(organization()),
    ),
    // The Labs card's read (API-22) first; every other Observation read is the Vitals card's (API-21).
    http.get('/bff/fhir/Observation', ({request}) =>
      new URL(request.url).searchParams.get('category') === 'laboratory'
        ? HttpResponse.json(searchBundle([labResult()]))
        : undefined,
    ),
    http.get('/bff/fhir/Observation', () =>
      HttpResponse.json(
        searchBundle(vitalsForm('2026-09-10T09:00:00-04:00', 'test-vitals')),
      ),
    ),
    http.get('/bff/fhir/Immunization', () =>
      HttpResponse.json(searchBundle([immunization()])),
    ),
    http.get('/bff/fhir/Appointment', () =>
      HttpResponse.json(searchBundle([appointment()])),
    ),
  );
}

function dashboardOf(client: QueryClient, patientId: string): ReactNode {
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider theme={createAppTheme('light')}>
        <Dashboard patientId={patientId} />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

describe(
  "given the Problem List's data hook throws (FR-CARD-1)",
  HEAVY_SUITE,
  () => {
    it('when the dashboard renders, then only that card says it could not be displayed, and every other card renders', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      answerOtherCards();
      render(
        dashboardOf(
          createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0}),
          FAILING_PATIENT,
        ),
      );

      const card = regionsByName(
        screen.getByRole('region', {name: 'Dashboard'}),
      );
      expect(within(card('Problem List')).getByRole('alert')).toHaveTextContent(
        "Couldn't display this card.",
      );
      expect(
        await within(card('Care Team')).findByText('Fakedoc Testdoctor'),
      ).toBeInTheDocument();
      expect(
        await within(card('Allergies')).findByText(
          'Test substance A (high criticality)',
        ),
      ).toBeInTheDocument();
      expect(
        await within(card('Medications')).findByText('Test drug A 10 mg'),
      ).toBeInTheDocument();
      expect(
        await within(card('Prescriptions')).findByText('Test drug A 10 mg'),
      ).toBeInTheDocument();
      expect(
        await within(card('Encounter History')).findByText('Test reason'),
      ).toBeInTheDocument();
      expect(
        await within(card('Vitals')).findByText('86 per min'),
      ).toBeInTheDocument();
      expect(
        await within(card('Labs')).findByText('Test hemoglobin A1c'),
      ).toBeInTheDocument();
      expect(
        await within(card('Immunizations')).findByText(
          'Test influenza vaccine, injectable',
        ),
      ).toBeInTheDocument();
      expect(
        await within(card('Appointments')).findByText('Test office visit'),
      ).toBeInTheDocument();
    });
  },
);

// Workspace remounts the dashboard per patient, but a slot's boundary must not rely on that: re-rendered
// in place for the next patient, a card that failed for the last one tries again.
describe(
  'given the Problem List failed for one patient (review)',
  HEAVY_SUITE,
  () => {
    it('when the same dashboard re-renders for another patient, without a remount, then the Problem List shows that patient’s problems, not the last failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      answerOtherCards();
      server.use(
        http.get('/bff/fhir/Condition', () =>
          HttpResponse.json(
            searchBundle([condition({code: {text: 'Next patient problem'}})]),
          ),
        ),
      );
      const client = createQueryClient({
        onSessionOver: vi.fn(),
        retryDelayMs: 0,
      });
      const {rerender} = render(dashboardOf(client, FAILING_PATIENT));
      const dashboard = screen.getByRole('region', {name: 'Dashboard'});
      expect(
        within(
          within(dashboard).getByRole('region', {name: 'Problem List'}),
        ).getByRole('alert'),
      ).toHaveTextContent("Couldn't display this card.");

      rerender(dashboardOf(client, TEST_PATIENT_ID));

      const problems = within(dashboard).getByRole('region', {
        name: 'Problem List',
      });
      expect(
        await within(problems).findByText('Next patient problem'),
      ).toBeInTheDocument();
      expect(within(problems).queryByRole('alert')).toBeNull();
    });
  },
);
