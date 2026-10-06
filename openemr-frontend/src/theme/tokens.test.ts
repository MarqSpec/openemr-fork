import {describe, expect, it} from 'vitest';

import {contrastRatio} from './contrast';
import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  TOUCH_TARGET,
  type ThemeTokens,
} from './tokens';

// reference: REQUIREMENTS.md (theme tokens; deviations from them exist only to reach WCAG AA)

const WCAG_AA_TEXT = 4.5;

describe('given the OpenEMR light theme tokens', () => {
  it('then they carry the style_light values the legacy dashboard uses', () => {
    expect(LIGHT_TOKENS.page).toBe('#e6e6e6');
    expect(LIGHT_TOKENS.surface).toBe('#ffffff');
    expect(LIGHT_TOKENS.text).toBe('#111827');
    expect(LIGHT_TOKENS.link).toBe('#1d4ed8');
    expect(LIGHT_TOKENS.warning).toBe('#ffc107');
  });

  it('then muted text uses style_light gray-600, not gray-500, so it also passes on the page grey', () => {
    expect(LIGHT_TOKENS.muted).toBe('#4b5563');
  });
});

describe('given the OpenEMR dark theme tokens', () => {
  it('then they carry the style_dark values', () => {
    expect(DARK_TOKENS.page).toBe('#000000');
    expect(DARK_TOKENS.surface).toBe('#212529');
    expect(DARK_TOKENS.text).toBe('#f8f9fa');
    expect(DARK_TOKENS.muted).toBe('#ced4da');
    expect(DARK_TOKENS.warning).toBe('#ffc107');
  });
});

describe.each<[string, ThemeTokens]>([
  ['light', LIGHT_TOKENS],
  ['dark', DARK_TOKENS],
])(
  'given the %s tokens, when checked for WCAG 2.2 AA (NFR-A11Y-1)',
  (_name, tokens) => {
    // Every text colour is checked on BOTH backgrounds text can sit on: a card and the bare page.
    it.each<[string, keyof ThemeTokens, keyof ThemeTokens]>([
      ['body text on a card', 'text', 'surface'],
      ['body text on the page', 'text', 'page'],
      ['muted text on a card', 'muted', 'surface'],
      ['muted text on the page', 'muted', 'page'],
      ['a link on a card', 'link', 'surface'],
      ['a link on the page', 'link', 'page'],
      ['a filled primary button label', 'onPrimary', 'primary'],
      ['success status text on a card', 'success', 'surface'],
      ['success status text on the page', 'success', 'page'],
      ['danger status text on a card', 'danger', 'surface'],
      ['danger status text on the page', 'danger', 'page'],
      ['a filled danger chip label (deceased, FR-HDR-2)', 'onDanger', 'danger'],
      ['info text on a card', 'info', 'surface'],
      ['info text on the page', 'info', 'page'],
      ['text on the severe-allergy highlight', 'onWarning', 'warning'],
    ])('then %s reaches 4.5:1', (_label, fg, bg) => {
      expect(contrastRatio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(
        WCAG_AA_TEXT,
      );
    });
  },
);

describe('given the touch-target token (NFR-A11Y-2)', () => {
  it('then an interactive target is at least 48 dp on each side', () => {
    expect(TOUCH_TARGET).toBeGreaterThanOrEqual(48);
  });
});

describe('given two colours', () => {
  it('when they are black and white, then the contrast ratio is 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('when the order is swapped, then the ratio is the same', () => {
    expect(contrastRatio('#007bff', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#007bff'),
      10,
    );
  });

  it('when one is a mid grey on white, then the ratio is the WCAG value (#777777 just misses 4.5:1)', () => {
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('when a colour is not a 6-digit hex, then it throws', () => {
    expect(() => contrastRatio('blue', '#ffffff')).toThrow();
  });
});
