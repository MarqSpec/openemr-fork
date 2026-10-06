import {ThemeProvider} from '@mui/material/styles';
import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it} from 'vitest';

import {blockingAxeViolations} from '../../test/axe';
import {createAppTheme} from '../../theme/theme';
import {PatientApps} from './PatientApps';
import type {PatientApp} from './patient_apps';

// reference: REQUIREMENTS.md FR-APP-1, NFR-SEC-1, NFR-A11Y-1 · REQUIREMENTS.md
// W-13 · REQUIREMENTS.md BUG-24, BUG-25

const PATIENT_UUID = '9a1f3c2e-0b7d-4e6a-8c11-5d2f0e9b7a64';
const AGENTFORGE: PatientApp = {
  label: 'Launch AgentForge',
  url: 'https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient={patientId}',
  aclHint: 'patients/demo',
};

function renderApps(
  apps: readonly PatientApp[],
  mode: 'light' | 'dark' = 'light',
) {
  return render(
    <ThemeProvider theme={createAppTheme(mode)}>
      <PatientApps patientId={PATIENT_UUID} apps={apps} />
    </ThemeProvider>,
  );
}

describe('given no patient apps are configured', () => {
  it('when the chart renders, then no patient-apps slot is drawn at all', () => {
    const {container} = renderApps([]);

    expect(
      screen.queryByRole('group', {name: 'Patient apps'}),
    ).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('given AgentForge is configured as a patient app', () => {
  it('when the chart renders, then a "Patient apps" group offers "Launch AgentForge", naming the new tab', () => {
    renderApps([AGENTFORGE]);

    const group = screen.getByRole('group', {name: 'Patient apps'});
    expect(
      within(group).getByRole('link', {
        name: 'Launch AgentForge — opens in a new tab',
      }),
    ).toBeInTheDocument();
  });

  it('when the link is inspected, then it opens the launch for this patient uuid in a new top-level tab with no opener or referrer (never an iframe, BUG-25)', () => {
    const {container} = renderApps([AGENTFORGE]);

    const link = screen.getByRole('link', {name: /Launch AgentForge/});
    expect(link).toHaveAttribute(
      'href',
      `https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient=${PATIENT_UUID}`,
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')?.split(' ')).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer']),
    );
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('when the link is described, then it warns that OpenEMR may ask for a sign-in (BUG-24) and names the access it needs', () => {
    renderApps([AGENTFORGE]);

    const link = screen.getByRole('link', {name: /Launch AgentForge/});
    expect(link).toHaveAccessibleDescription(
      'OpenEMR may ask you to sign in first. Needs OpenEMR access: patients/demo',
    );
  });

  it('when an app has no access hint, then its description is only the sign-in warning', () => {
    renderApps([{label: 'Launch AgentForge', url: AGENTFORGE.url}]);

    expect(
      screen.getByRole('link', {name: /Launch AgentForge/}),
    ).toHaveAccessibleDescription('OpenEMR may ask you to sign in first.');
  });

  it('when the clinician launches it, then nothing is written to web storage (NFR-SEC-1)', async () => {
    localStorage.clear();
    sessionStorage.clear();
    renderApps([AGENTFORGE]);

    await userEvent.click(
      screen.getByRole('link', {name: /Launch AgentForge/}),
    );

    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('when two apps are configured, then each is its own link, in the configured order', () => {
    renderApps([
      AGENTFORGE,
      {
        label: 'Open Growth Charts',
        url: 'https://apps.example.test/growth?patient={patientId}',
      },
    ]);

    const names = within(screen.getByRole('group', {name: 'Patient apps'}))
      .getAllByRole('link')
      .map(link => link.textContent);
    expect(names).toEqual([
      expect.stringContaining('Launch AgentForge'),
      expect.stringContaining('Open Growth Charts'),
    ]);
  });

  it.each(['light', 'dark'] as const)(
    'when axe scans the slot in the %s theme, then it finds no serious or critical violations',
    async mode => {
      const {container} = renderApps([AGENTFORGE], mode);

      expect(await blockingAxeViolations(container)).toEqual([]);
    },
  );
});
