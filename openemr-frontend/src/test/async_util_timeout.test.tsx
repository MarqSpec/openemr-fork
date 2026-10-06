import {getConfig, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {ASYNC_UTIL_TIMEOUT} from './timeouts';

// The setup file's Testing Library wait budget. A wait that gives up at the 1 s default fails a correct
// spec on a loaded runner; one that outlasts its spec hides which state never arrived behind "Test timed out".

const VITEST_DEFAULT_TIMEOUT = 5_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('given the setup file has configured Testing Library', () => {
  it('when a wait names no timeout, then it allows ASYNC_UTIL_TIMEOUT, more than the 1 s default a loaded runner outlasts', () => {
    expect(getConfig().asyncUtilTimeout).toBe(ASYNC_UTIL_TIMEOUT);
    expect(ASYNC_UTIL_TIMEOUT).toBeGreaterThan(1_000);
  });

  it('when a wait names no timeout, then it gives up before a default spec does, so the failure names the state that never came', () => {
    expect(ASYNC_UTIL_TIMEOUT).toBeLessThan(VITEST_DEFAULT_TIMEOUT);
  });

  it('when a state never arrives, then the wait still fails once ASYNC_UTIL_TIMEOUT has passed, and not before (guards a wait that never gives up)', async () => {
    vi.useFakeTimers();
    render(<p>Loading</p>);
    const outcome: {found: boolean; failure: unknown} = {
      found: false,
      failure: undefined,
    };
    void screen.findByText('Loaded').then(
      () => (outcome.found = true),
      (error: unknown) => (outcome.failure = error),
    );

    await vi.advanceTimersByTimeAsync(ASYNC_UTIL_TIMEOUT - 100);
    expect(outcome).toEqual({found: false, failure: undefined});

    await vi.advanceTimersByTimeAsync(200);
    expect(outcome.found).toBe(false);
    expect(outcome.failure).toBeInstanceOf(Error);
    expect(outcome.failure).toHaveProperty(
      'message',
      expect.stringContaining(
        'Unable to find an element with the text: Loaded',
      ),
    );
  });
});
