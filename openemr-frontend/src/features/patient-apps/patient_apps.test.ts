import {describe, expect, it} from 'vitest';

import {launchUrl} from './patient_apps';

// Which apps are configured, and the rules an entry must meet, are the token handler's runtime config (API-48):
// src/api/config/runtime_config.test.ts. reference: REQUIREMENTS.md FR-APP-1, NFR-SEC-1, NFR-CON-1 ·

const PATIENT_UUID = '9a1f3c2e-0b7d-4e6a-8c11-5d2f0e9b7a64';
const AGENTFORGE =
  'https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient={patientId}';

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
