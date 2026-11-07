import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../api/query_client';
import {SessionProvider, useSession} from '../auth/SessionProvider';
import {answerDashboardReads, regionsByName} from '../test/dashboard';
import {TEST_PATIENT_ID, condition, patient} from '../test/fhir_fixtures';
import {server} from '../test/msw_server';
import {HEAVY_SUITE} from '../test/timeouts';
import {createAppTheme} from '../theme/theme';
import {PatientView} from './PatientView';

// reference: REQUIREMENTS.md FR-HDR-1, FR-UI-1, FR-UI-7, FR-APP-1 · REQUIREMENTS.md
// W-3, W-4, W-12c, W-13 · INTERFACES.md API-48

const AGENTFORGE = {
  label: 'Launch AgentForge',
  url: 'https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient={patientId}',
} as const;

function renderView(): void {
  render(
    <QueryClientProvider
      client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
    >
      <ThemeProvider theme={createAppTheme('light')}>
        <PatientView
          patientId={TEST_PATIENT_ID}
          clock={() => new Date(2026, 8, 25)}
        />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** Says when the session and the runtime config have both arrived, as the app shell waits for before a chart. */
function SignedInMark(): ReactNode {
  return useSession().kind === 'signed-in' ? <p>Signed in</p> : null;
}

/**
 * Signed in, as the app opens a chart: API-42 names a synthetic clinician and the token handler's runtime config
 * (API-48) serves `apps` — the only place the patient-apps slot takes its entries from.
 */
function renderSignedInView(
  apps: readonly {label: string; url: string}[],
): void {
  server.use(
    http.get('/bff/session', () =>
      HttpResponse.json({
        authenticated: true,
        user: {displayName: 'Dr. Avery Demo'},
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        idleTimeoutSeconds: 900,
        grantedScopes: ['openid', 'fhirUser'],
      }),
    ),
    http.get('/bff/config', () =>
      HttpResponse.json({patientApps: apps, privacyGraceSeconds: 60}),
    ),
  );
  render(
    <SessionProvider>
      <ThemeProvider theme={createAppTheme('light')}>
        <SignedInMark />
        <PatientView
          patientId={TEST_PATIENT_ID}
          clock={() => new Date(2026, 8, 25)}
        />
      </ThemeProvider>
    </SessionProvider>,
  );
}

/** Holds the patient read (API-12) until the returned function is called, so the cards load first. */
function answerPatientLate(): () => void {
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  server.use(
    http.get(`/bff/fhir/Patient/${TEST_PATIENT_ID}`, async () => {
      await held;
      return HttpResponse.json(patient());
    }),
  );
  return release;
}

/** Answers every card's read and the patient read (API-12) at once. */
function answerAllReads(): void {
  answerDashboardReads([condition()]);
  server.use(
    http.get(`/bff/fhir/Patient/${TEST_PATIENT_ID}`, () =>
      HttpResponse.json(patient()),
    ),
  );
}

describe('given a patient chart is open', HEAVY_SUITE, () => {
  it('when the patient view renders, then the patient header comes first, above the dashboard and its cards', async () => {
    answerDashboardReads([condition()]);
    server.use(
      http.get(`/bff/fhir/Patient/${TEST_PATIENT_ID}`, () =>
        HttpResponse.json(patient()),
      ),
    );
    render(
      <QueryClientProvider
        client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
      >
        <ThemeProvider theme={createAppTheme('light')}>
          <PatientView
            patientId={TEST_PATIENT_ID}
            clock={() => new Date(2026, 8, 25)}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await screen.findByText('Fakey Testperson');
    const region = regionsByName(document.body);
    const header = region('Patient');
    expect(
      within(header).getByRole('heading', {
        level: 1,
        name: 'Fakey Testperson',
      }),
    ).toBeInTheDocument();
    const dashboard = region('Dashboard');
    expect(
      header.compareDocumentPosition(dashboard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      await within(dashboard).findByText('Test problem A'),
    ).toBeInTheDocument();
  });

  it('when the patient read is slow and the user has tabbed to a card control, then the arriving header leaves focus on that control (guards focus stolen from the user, W-12c)', async () => {
    answerDashboardReads([condition()]);
    const release = answerPatientLate();
    renderView();

    const dashboard = regionsByName(document.body)('Dashboard');
    await within(dashboard).findByText('Test problem A');
    await userEvent.tab();
    const control = document.activeElement;
    expect(control).not.toBe(document.body);
    expect(dashboard.contains(control)).toBe(true);

    release();
    await screen.findByRole('heading', {level: 1, name: 'Fakey Testperson'});
    expect(control).toHaveFocus();
  });

  it('when the patient read is slow and focus has not moved, then the header takes focus when it arrives (W-12c)', async () => {
    answerDashboardReads([condition()]);
    const release = answerPatientLate();
    renderView();

    await within(regionsByName(document.body)('Dashboard')).findByText(
      'Test problem A',
    );
    expect(document.body).toHaveFocus();

    release();
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'Fakey Testperson',
    });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it('when the control that opened the chart still holds focus as the header arrives, then the header takes focus', async () => {
    answerDashboardReads([condition()]);
    const release = answerPatientLate();
    const opener = document.createElement('button');
    opener.textContent = 'Open chart';
    document.body.append(opener);
    opener.focus();
    try {
      renderView();
      await within(regionsByName(document.body)('Dashboard')).findByText(
        'Test problem A',
      );
      expect(opener).toHaveFocus();

      release();
      const heading = await screen.findByRole('heading', {
        level: 1,
        name: 'Fakey Testperson',
      });
      await waitFor(() => {
        expect(heading).toHaveFocus();
      });
    } finally {
      opener.remove();
    }
  });
});

describe(
  'given the token handler serves AgentForge as a patient app (FR-APP-1, API-48)',
  HEAVY_SUITE,
  () => {
    it('when the chart renders, then the patient-apps slot sits under the patient header, above the dashboard, and launches this patient in a new tab (guards a launch for another patient or inside the app)', async () => {
      answerAllReads();
      renderSignedInView([AGENTFORGE]);

      await screen.findByText('Fakey Testperson');
      await screen.findByRole('group', {name: 'Patient apps'});
      const region = regionsByName(document.body);
      const header = region('Patient');
      const dashboard = region('Dashboard');
      const apps = screen.getByRole('group', {name: 'Patient apps'});
      expect(
        header.compareDocumentPosition(apps) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        apps.compareDocumentPosition(dashboard) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      const link = within(apps).getByRole('link', {
        name: 'Launch AgentForge — opens in a new tab',
      });
      expect(link).toHaveAttribute(
        'href',
        AGENTFORGE.url.replace('{patientId}', TEST_PATIENT_ID),
      );
      expect(link).toHaveAttribute('target', '_blank');
    });
  },
);

describe(
  'given the token handler serves no patient apps (PATIENT_APPS unset, blank or invalid)',
  HEAVY_SUITE,
  () => {
    it('when the chart renders, then there is no patient-apps slot', async () => {
      answerAllReads();
      renderSignedInView([]);

      await screen.findByText('Fakey Testperson');
      await screen.findByText('Signed in');
      expect(
        screen.queryByRole('group', {name: 'Patient apps'}),
      ).not.toBeInTheDocument();
    });
  },
);
