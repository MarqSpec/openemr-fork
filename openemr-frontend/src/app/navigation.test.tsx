import {act, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';

import {navigate, useLocationPath} from './navigation';

// reference: REQUIREMENTS.md FR-PAT-2 (in-app routes; Back returns to results), NFR-SEC-6

function ShowPath() {
  return <p>path: {useLocationPath()}</p>;
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('given the in-app router', () => {
  it('when the app navigates, then the path changes, a history entry is added and the view follows it', () => {
    render(<ShowPath />);
    const before = window.history.length;

    act(() => {
      navigate('/patient/test-patient-0001');
    });

    expect(window.location.pathname).toBe('/patient/test-patient-0001');
    expect(window.history.length).toBe(before + 1);
    expect(screen.getByText('path: /patient/test-patient-0001')).toBeVisible();
  });

  it('when the app navigates, then the history entry carries no state (guards PHI in history)', () => {
    act(() => {
      navigate('/patient/test-patient-0001');
    });

    expect(window.history.state).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('when the browser goes back (popstate), then the view follows the new path', () => {
    render(<ShowPath />);
    act(() => {
      navigate('/patient/test-patient-0001');
    });

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(screen.getByText('path: /')).toBeVisible();
  });

  it('when the app navigates to the path it is already on, then no history entry is added', () => {
    const before = window.history.length;
    act(() => {
      navigate('/');
    });
    expect(window.history.length).toBe(before);
  });
});
