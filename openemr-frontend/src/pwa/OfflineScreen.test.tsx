import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';

import {OfflineScreen} from './OfflineScreen';

// reference: REQUIREMENTS.md FR-PWA-4, NFR-SEC-1 · REQUIREMENTS.md W-8

describe('given the shell opened with no connection (W-8)', () => {
  it('when it renders, then it says there is no connection and that patient data is not available offline', () => {
    render(<OfflineScreen onRetry={vi.fn()} />);

    expect(
      screen.getByRole('heading', {level: 1, name: 'No connection'}),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Patient data isn.t available offline\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/you may need to sign in again/),
    ).toBeInTheDocument();
  });

  it('when it renders, then focus starts on Retry, so it is never stranded', () => {
    render(<OfflineScreen onRetry={vi.fn()} />);

    expect(screen.getByRole('button', {name: 'Retry'})).toHaveFocus();
  });

  it('when the clinician taps Retry, then the app tries again', async () => {
    const onRetry = vi.fn();
    render(<OfflineScreen onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', {name: 'Retry'}));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
