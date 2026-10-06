import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {SignInScreen} from './SignInScreen';

// reference: REQUIREMENTS.md W-1 · REQUIREMENTS.md FR-AUTH-1 · INTERFACES.md API-40

interface Submitted {
  readonly method: string;
  readonly action: string;
  readonly enctype: string;
  readonly fields: readonly string[];
}

let submitted: Submitted[] = [];

/** Records a form submission the way the browser would send it, instead of navigating (jsdom cannot). */
function recordSubmit(event: SubmitEvent) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error('not a form');
  submitted.push({
    method: form.method,
    action: new URL(form.action).pathname,
    enctype: form.enctype,
    fields: [...new FormData(form).keys()],
  });
}

beforeEach(() => {
  submitted = [];
  document.addEventListener('submit', recordSubmit);
});

afterEach(() => {
  document.removeEventListener('submit', recordSubmit);
});

describe('given the sign-in screen (W-1)', () => {
  it('when it shows, then it names the app and offers one "Sign in with OpenEMR" action', () => {
    render(<SignInScreen />);

    expect(
      screen.getByRole('heading', {level: 1, name: 'Patient Dashboard'}),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Sign in with your OpenEMR account to continue.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(
      screen.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toBeInTheDocument();
  });

  it('when it shows, then there is no username or password field — credentials are OpenEMR’s to collect (FR-AUTH-1)', () => {
    const {container} = render(<SignInScreen />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
  });

  it('when it shows, then focus is on "Sign in with OpenEMR", so a session that just ended does not strand focus', () => {
    render(<SignInScreen />);

    expect(
      screen.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toHaveFocus();
  });

  it('when "Sign in with OpenEMR" is pressed, then the page form-posts an empty body to /bff/login (API-40)', async () => {
    render(<SignInScreen />);

    await userEvent.click(
      screen.getByRole('button', {name: 'Sign in with OpenEMR'}),
    );

    expect(submitted).toEqual([
      {
        method: 'post',
        action: '/bff/login',
        enctype: 'application/x-www-form-urlencoded',
        fields: [],
      },
    ]);
  });

  it('when a version is given, then it shows under the sign-in action (FR-UI-3, W-1)', () => {
    render(<SignInScreen version="v9.9.9 · abc1234" />);

    expect(screen.getByText('Version v9.9.9 · abc1234')).toBeInTheDocument();
  });

  it('when a notice is given, then it shows as an alert above the sign-in action', () => {
    render(
      <SignInScreen
        notice={{
          severity: 'warning',
          title: 'Session ended',
          body: 'Sign in again to continue.',
        }}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Session ended');
    expect(alert).toHaveTextContent('Sign in again to continue.');
    expect(
      screen.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toBeInTheDocument();
  });

  it('when a retry is offered, then "Try again" calls it and sign-in stays available', async () => {
    let retries = 0;
    render(
      <SignInScreen
        notice={{severity: 'error', title: 'Unavailable', body: 'Try again.'}}
        onRetry={() => {
          retries += 1;
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', {name: 'Try again'}));

    expect(retries).toBe(1);
    expect(submitted).toEqual([]);
  });
});
