import {describe, expect, it} from 'vitest';

import {createAppTheme} from './theme';
import {DARK_TOKENS, LIGHT_TOKENS} from './tokens';

// reference: REQUIREMENTS.md FR-HDR-2, NFR-A11Y-1 (deviations from OpenEMR's colours)

describe.each([
  ['light', LIGHT_TOKENS],
  ['dark', DARK_TOKENS],
] as const)('given the %s theme', (mode, tokens) => {
  it('when a filled danger surface (the deceased chip) takes its label colour, then it is the token that reaches AA on danger', () => {
    const {palette} = createAppTheme(mode);
    expect(palette.error.main).toBe(tokens.danger);
    expect(palette.error.contrastText).toBe(tokens.onDanger);
  });
});
