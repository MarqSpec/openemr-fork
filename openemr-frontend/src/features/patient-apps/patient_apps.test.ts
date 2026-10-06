import {describe, expect, it} from 'vitest';

import {launchUrl, parsePatientApps} from './patient_apps';

// reference: REQUIREMENTS.md FR-APP-1, NFR-SEC-1, NFR-CON-1

const PATIENT_UUID = '9a1f3c2e-0b7d-4e6a-8c11-5d2f0e9b7a64';
const AGENTFORGE =
  'https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient={patientId}';

describe('given the build-time patient app list (VITE_PATIENT_APPS)', () => {
  it('when it is unset or blank, then there are no apps, so no slot renders', () => {
    expect(parsePatientApps(undefined)).toEqual([]);
    expect(parsePatientApps('')).toEqual([]);
    expect(parsePatientApps('   ')).toEqual([]);
  });

  it('when it lists AgentForge, then the entry keeps its label, launch URL template and access hint', () => {
    const raw = JSON.stringify([
      {label: 'Launch AgentForge', url: AGENTFORGE, aclHint: 'patients/demo'},
    ]);

    expect(parsePatientApps(raw)).toEqual([
      {label: 'Launch AgentForge', url: AGENTFORGE, aclHint: 'patients/demo'},
    ]);
  });

  it('when an entry has no access hint, then it is still an app, without one', () => {
    const raw = JSON.stringify([{label: 'Launch AgentForge', url: AGENTFORGE}]);

    expect(parsePatientApps(raw)).toEqual([
      {label: 'Launch AgentForge', url: AGENTFORGE},
    ]);
  });

  it.each([
    ['not JSON', 'Launch AgentForge'],
    [
      'not a list',
      JSON.stringify({label: 'Launch AgentForge', url: AGENTFORGE}),
    ],
    ['an entry with no label', JSON.stringify([{url: AGENTFORGE}])],
    [
      'an entry with a blank label',
      JSON.stringify([{label: '  ', url: AGENTFORGE}]),
    ],
    [
      'a URL with no {patientId} placeholder (the launch would not be for this patient)',
      JSON.stringify([
        {label: 'App', url: 'https://openemr.example.test/launch.php'},
      ]),
    ],
    [
      'a javascript: URL',
      JSON.stringify([{label: 'App', url: 'javascript:alert({patientId})'}]),
    ],
    [
      'a relative URL',
      JSON.stringify([{label: 'App', url: '/launch.php?patient={patientId}'}]),
    ],
    [
      'plain http to a host other than localhost',
      JSON.stringify([
        {
          label: 'App',
          url: 'http://openemr.example.test/launch.php?patient={patientId}',
        },
      ]),
    ],
    [
      'credentials in the URL',
      JSON.stringify([
        {
          label: 'App',
          url: 'https://user:pw@openemr.example.test/launch.php?patient={patientId}',
        },
      ]),
    ],
    [
      'the placeholder in the host (the patient would pick the server)',
      JSON.stringify([
        {label: 'App', url: 'https://{patientId}.example.test/launch.php'},
      ]),
    ],
    [
      'one bad entry among good ones',
      JSON.stringify([
        {label: 'Launch AgentForge', url: AGENTFORGE},
        {label: 'Bad', url: 'javascript:void({patientId})'},
      ]),
    ],
  ])(
    'when it holds %s, then the whole list is refused and no slot renders (guards a misconfigured launch)',
    (_case, raw) => {
      expect(parsePatientApps(raw)).toEqual([]);
    },
  );

  it('when an entry targets a local development OpenEMR over plain http, then it is accepted', () => {
    const url = 'http://localhost:8300/launch.php?patient={patientId}';

    expect(parsePatientApps(JSON.stringify([{label: 'Dev', url}]))).toEqual([
      {label: 'Dev', url},
    ]);
  });
});

describe('given a configured app and the open patient', () => {
  it('when the launch URL is built, then the placeholder becomes the patient uuid and nothing else about the patient', () => {
    expect(launchUrl(AGENTFORGE, PATIENT_UUID)).toBe(
      `https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient=${PATIENT_UUID}`,
    );
  });

  it('when the id carries URL syntax, then it is percent-encoded and cannot add parameters', () => {
    expect(launchUrl(AGENTFORGE, 'a&b=c#d')).toBe(
      'https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient=a%26b%3Dc%23d',
    );
  });
});
