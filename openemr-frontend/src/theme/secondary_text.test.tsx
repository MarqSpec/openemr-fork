import Typography from '@mui/material/Typography';
import {ThemeProvider} from '@mui/material/styles';
import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';

import {DashboardCard} from '../features/cards/DashboardCard';
import {renderedColour} from './contrast';
import {createAppTheme, type ThemeMode} from './theme';
import {DARK_TOKENS, LIGHT_TOKENS, type ThemeTokens} from './tokens';

// reference: CONVENTIONS.md (Stack standards: Typography colour) · REQUIREMENTS.md NFR-A11Y-1
// MUI 9.4's Typography styles only its own colour names (a palette key, or text + a capitalised text key); a
// palette path such as "text.secondary" reaches no style rule, so the text keeps the colour it inherits.

/** The #rrggbb an element's text renders in. */
function textColour(element: Element): string {
  return renderedColour(getComputedStyle(element).color);
}

describe.each<[ThemeMode, ThemeTokens]>([
  ['light', LIGHT_TOKENS],
  ['dark', DARK_TOKENS],
])('given the %s theme', (mode, tokens) => {
  it("when a card shows its standing notice, then the notice renders in the theme's secondary text colour", () => {
    render(
      <ThemeProvider theme={createAppTheme(mode)}>
        <DashboardCard title="Medications" notice="As reported by OpenEMR.">
          <p>Body</p>
        </DashboardCard>
      </ThemeProvider>,
    );
    expect(textColour(screen.getByText('As reported by OpenEMR.'))).toBe(
      tokens.muted,
    );
  });

  it.each<[string, keyof ThemeTokens]>([
    ['textSecondary', 'muted'],
    ['textPrimary', 'text'],
    ['primary', 'primary'],
    ['error', 'danger'],
    ['success', 'success'],
    ['info', 'info'],
    ['warning', 'warning'],
  ])(
    'when Typography is given color="%s", then it renders the %s token',
    (color, token) => {
      render(
        <ThemeProvider theme={createAppTheme(mode)}>
          <Typography color={color}>Sample</Typography>
        </ThemeProvider>,
      );
      expect(textColour(screen.getByText('Sample'))).toBe(tokens[token]);
    },
  );

  // The premise of the lint rule: if MUI starts honouring these, the rule can widen.
  it.each(['text.secondary', 'text.primary', 'error.main', '#123456'])(
    'when Typography is given color="%s", then MUI applies no colour and the text inherits (why lint rejects it)',
    color => {
      render(
        <ThemeProvider theme={createAppTheme(mode)}>
          <div style={{color: 'rgb(1, 2, 3)'}}>
            <Typography color={color}>Sample</Typography>
          </div>
        </ThemeProvider>,
      );
      expect(textColour(screen.getByText('Sample'))).toBe('#010203');
    },
  );
});
