import {cleanup, render, screen} from '@testing-library/react';

/**
 * Draws a few plain elements, reads them by role and computed style once, and removes them. The first render, role
 * query and computed style in a file compile React DOM and Testing Library afresh and start jsdom's style engine:
 * about half a second of CPU on an idle machine, which the loaded CI runner stretched past a file's first spec's 5 s
 * timeout. Run before the file's specs, that cost is the file's. It loads nothing the setup file has not
 * already loaded, so the hook it runs in does no import work.
 */
export function warmUp(): void {
  render(
    <section aria-label="Warm-up">
      <h2>Warm-up</h2>
      <button type="button">Warm-up</button>
    </section>,
  );
  screen.getByRole('button', {name: 'Warm-up'});
  getComputedStyle(screen.getByRole('heading'));
  cleanup();
}
