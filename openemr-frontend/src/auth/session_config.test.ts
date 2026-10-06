import {describe, expect, it} from 'vitest';

import {
  DEFAULT_PRIVACY_GRACE_SECONDS,
  privacyGraceSeconds,
} from './session_config';

// reference: REQUIREMENTS.md FR-UI-4, NFR-SEC-3

describe('given the privacy grace period (VITE_PRIVACY_GRACE_SECONDS)', () => {
  it('when it is not set, then the default of 60 seconds applies', () => {
    expect(DEFAULT_PRIVACY_GRACE_SECONDS).toBe(60);
    expect(privacyGraceSeconds(undefined)).toBe(60);
  });

  it('when it is a whole number of seconds up to 15 minutes, then that is the grace period', () => {
    expect(privacyGraceSeconds('30')).toBe(30);
    expect(privacyGraceSeconds('0')).toBe(0);
    expect(privacyGraceSeconds('900')).toBe(900);
  });

  it.each([['abc'], ['-5'], ['1.5'], [''], ['901'], [42]])(
    'when it is %j, then the default applies rather than an unbounded or unparsed grace',
    value => {
      expect(privacyGraceSeconds(value)).toBe(60);
    },
  );
});
