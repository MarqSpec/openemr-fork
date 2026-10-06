import {describe, expect, it} from 'vitest';

import pkg from '../../package.json';
import {APP_VERSION, formatAppVersion} from './version';

// reference: REQUIREMENTS.md FR-UI-3 (app version) · REQUIREMENTS.md W-1, W-9 · a separate change (note 87776)

describe('given the version the build injects', () => {
  it('when there is no commit, then it is the package version with a "v"', () => {
    expect(formatAppVersion('0.1.0', '')).toBe('v0.1.0');
  });

  it('when a commit is known, then its short form follows the version', () => {
    expect(
      formatAppVersion('0.1.0', '04a9991c2e8a80e8337d55246c6bddee8753be47'),
    ).toBe('v0.1.0 · 04a9991');
  });

  it('when the commit is blank, then it is left out', () => {
    expect(formatAppVersion('0.1.0', '   ')).toBe('v0.1.0');
  });

  it('when the app is built, then its version comes from package.json (guards a hand-typed version drifting)', () => {
    expect(APP_VERSION.startsWith(`v${pkg.version}`)).toBe(true);
  });
});
