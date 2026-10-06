export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_PREFERENCE_KEY = 'openemr-frontend.theme';

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

function isThemePreference(value: unknown): value is ThemePreference {
  return PREFERENCES.some(preference => preference === value);
}

/** The stored theme choice, or 'system' when none is stored or storage is unavailable. */
export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_PREFERENCE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Persists the theme choice on this device; silently a no-op when storage is unavailable. */
export function writeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_PREFERENCE_KEY, preference);
  } catch {
    // Private mode or blocked site data: the choice lasts for this session only.
  }
}
