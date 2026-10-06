import Alert from '@mui/material/Alert';
import Paper from '@mui/material/Paper';
import {ThemeProvider} from '@mui/material/styles';
import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';

import {DashboardCard} from '../features/cards/DashboardCard';
import {contrastRatio, renderedColour} from './contrast';
import {createAppTheme, type ThemeMode} from './theme';
import {DARK_TOKENS, LIGHT_TOKENS, type ThemeTokens} from './tokens';

// reference: REQUIREMENTS.md NFR-A11Y-1 (raised surfaces)

const WCAG_AA_TEXT = 4.5;
const WCAG_AA_UI = 3;

/**
 * The #rrggbb an element's background renders as: its computed background-color with its background-image
 * blended over it. MUI paints a Paper's dark-mode elevation overlay as `background-image: var(--Paper-overlay)`,
 * so the variable is resolved against the element first.
 */
function renderedSurface(element: Element): string {
  const style = getComputedStyle(element);
  const variable = /^var\((--[\w-]+)\)$/.exec(style.backgroundImage)?.[1];
  const image =
    variable === undefined
      ? style.backgroundImage
      : style.getPropertyValue(variable).trim();
  return renderedColour(style.backgroundColor, image === '' ? 'none' : image);
}

/** Throws, naming both colours and the ratio, when `foreground` falls below `minimum` on what `surface` renders as. */
function expectReadableOn(
  foreground: string,
  surface: Element,
  minimum: number,
): void {
  const background = renderedSurface(surface);
  const ratio = contrastRatio(foreground, background);
  if (ratio < minimum) {
    throw new Error(
      `${foreground} on the rendered ${background} is ${ratio.toFixed(2)}:1, below ${String(minimum)}:1`,
    );
  }
}

function renderCard(mode: ThemeMode): HTMLElement {
  render(
    <ThemeProvider theme={createAppTheme(mode)}>
      <DashboardCard title="Allergies">
        <Alert severity="warning">
          You&apos;re not authorised to view allergies.
        </Alert>
        <Alert severity="error">Couldn&apos;t load allergies.</Alert>
      </DashboardCard>
    </ThemeProvider>,
  );
  return screen.getByRole('region', {name: 'Allergies'});
}

describe.each<[ThemeMode, ThemeTokens]>([
  ['dark', DARK_TOKENS],
  ['light', LIGHT_TOKENS],
])(
  'given a dashboard card drawn in the %s theme, when its text is checked against the surface it renders (NFR-A11Y-1)',
  (mode, tokens) => {
    // Every text colour a card paints on its own surface; the card's text is body size (16 px bold at most), never large.
    it.each<[string, keyof ThemeTokens]>([
      ['body text', 'text'],
      ['secondary text', 'muted'],
      ['a link', 'link'],
      ['a text button in the primary colour', 'primary'],
      ['success status text', 'success'],
      ['danger status text', 'danger'],
      ['info status text', 'info'],
    ])('then %s reaches 4.5:1', (_label, token) => {
      expect(() => {
        expectReadableOn(tokens[token], renderCard(mode), WCAG_AA_TEXT);
      }).not.toThrow();
    });

    it('then the focus ring on the collapse control reaches 3:1 against the card', () => {
      expect(() => {
        expectReadableOn(tokens.primary, renderCard(mode), WCAG_AA_UI);
      }).not.toThrow();
    });

    it.each([
      ['a warning (not authorised)', /not authorised/],
      ['an error (could not load)', /Couldn't load/],
    ])(
      'then the text of %s alert reaches 4.5:1 on the alert it sits in',
      (_label, text) => {
        renderCard(mode);
        const alert = screen
          .getAllByRole('alert')
          .find(element => text.test(element.textContent));
        expect(alert).toBeDefined();
        if (alert === undefined) return;
        expect(() => {
          expectReadableOn(
            renderedColour(getComputedStyle(alert).color),
            alert,
            WCAG_AA_TEXT,
          );
        }).not.toThrow();
      },
    );
  },
);

describe('given a seeded colour too faint for a dark card (guards a check that cannot fail)', () => {
  it('when it is checked on the card, then the check fails and names the ratio', () => {
    const seeded = '#6c6c6c';
    expect(() => {
      expectReadableOn(seeded, renderCard('dark'), WCAG_AA_TEXT);
    }).toThrow(/#6c6c6c on the rendered #212529 is \d\.\d\d:1, below 4\.5:1/);
  });

  it("when it passes on the surface token but not on a raised Paper's overlay, then the check fails (guards a check that ignores the overlay)", () => {
    // Elevation 1 is MUI Card's default: in dark its overlay lifts #212529 to #2c3034.
    render(
      <ThemeProvider theme={createAppTheme('dark')}>
        <Paper component="section" aria-label="Raised" elevation={1} />
      </ThemeProvider>,
    );
    const raised = screen.getByRole('region', {name: 'Raised'});
    const seeded = '#8e8e8e';
    expect(contrastRatio(seeded, DARK_TOKENS.surface)).toBeGreaterThanOrEqual(
      WCAG_AA_TEXT,
    );
    expect(renderedSurface(raised)).toBe('#2c3034');
    expect(() => {
      expectReadableOn(seeded, raised, WCAG_AA_TEXT);
    }).toThrow(/below 4\.5:1/);
  });
});
