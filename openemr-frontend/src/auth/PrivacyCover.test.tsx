import {ThemeProvider} from '@mui/material/styles';
import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';

import {createAppTheme} from '../theme/theme';
import {PrivacyCover} from './PrivacyCover';

// reference: REQUIREMENTS.md FR-UI-4 · REQUIREMENTS.md W-7 · a separate change (merge of !130 and !131)

describe('given the privacy cover (W-7)', () => {
  it.each(['light', 'dark'] as const)(
    'when it is drawn in the %s theme, then it stacks above every MUI layer that can hold patient data or sit over it: dialogs ("Open another chart?"), the update snackbar, menus and tooltips',
    mode => {
      const theme = createAppTheme(mode);
      render(
        <ThemeProvider theme={theme}>
          <PrivacyCover />
        </ThemeProvider>,
      );

      const cover = screen.getByText('Patient data hidden').parentElement;
      const z = Number(getComputedStyle(cover ?? document.body).zIndex);

      expect(getComputedStyle(cover ?? document.body).position).toBe('fixed');
      for (const layer of [
        theme.zIndex.appBar,
        theme.zIndex.drawer,
        theme.zIndex.modal,
        theme.zIndex.snackbar,
        theme.zIndex.tooltip,
      ]) {
        expect(z).toBeGreaterThan(layer);
      }
    },
  );
});
