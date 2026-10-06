import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  THEME_PREFERENCE_KEY,
  readThemePreference,
  writeThemePreference,
} from './theme_preference';

// reference: REQUIREMENTS.md FR-UI-2, NFR-SEC-1 (theme is one of the two allowed stored preferences)

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('given no stored theme preference', () => {
  it('when read, then it defaults to matching the device', () => {
    expect(readThemePreference()).toBe('system');
  });
});

describe('given a stored preference', () => {
  it('when it is a known value, then it is returned', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
    expect(readThemePreference()).toBe('dark');
  });

  it('when it is an unknown value, then it falls back to matching the device', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'purple');
    expect(readThemePreference()).toBe('system');
  });

  it('when it differs from a known value only in case, then it falls back to matching the device', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'Dark');
    expect(readThemePreference()).toBe('system');
  });
});

describe('given storage that throws (private mode, blocked site data)', () => {
  it('when read, then it defaults to matching the device instead of crashing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readThemePreference()).toBe('system');
  });

  it('when written, then it does not throw', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => {
      writeThemePreference('light');
    }).not.toThrow();
  });
});

describe('given a preference is written', () => {
  it('then the next read returns it', () => {
    writeThemePreference('light');
    expect(readThemePreference()).toBe('light');
  });
});
