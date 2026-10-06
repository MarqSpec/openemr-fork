import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent, {PointerEventsCheckLevel} from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {AccountMenu} from './AccountMenu';

// reference: REQUIREMENTS.md W-9, W-12c · REQUIREMENTS.md FR-UI-3, FR-UI-7, FR-AUTH-3 ·
// INTERFACES.md API-43

let submitted: {method: string; action: string; fields: string[]}[] = [];

function recordSubmit(event: SubmitEvent) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error('not a form');
  submitted.push({
    method: form.method,
    action: new URL(form.action).pathname,
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

const accountButton = () =>
  screen.getByRole('button', {name: 'Signed in as Dr. Avery Demo'});

async function openSignOutDialog() {
  await userEvent.click(accountButton());
  await userEvent.click(screen.getByRole('menuitem', {name: 'Sign out'}));
  return screen.findByRole('alertdialog', {name: 'Sign out?'});
}

describe('given a signed-in clinician', () => {
  it('when the app bar shows, then the account button names who is signed in', () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );

    expect(accountButton()).toHaveTextContent('Dr. Avery Demo');
    expect(accountButton()).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('when OpenEMR gave no name (BUG-10), then the account button still exists and says the user is signed in', () => {
    render(<AccountMenu displayName={null} version="v9.9.9" />);

    expect(screen.getByRole('button', {name: 'Signed in'})).toBeInTheDocument();
  });

  it('when the account menu opens, then it offers Sign out', async () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );

    await userEvent.click(accountButton());

    const menu = screen.getByRole('menu', {name: 'Account'});
    expect(
      within(menu).getByRole('menuitem', {name: 'Sign out'}),
    ).toBeInTheDocument();
  });

  it('when the account menu opens, then it shows the app version, as information rather than an action (FR-UI-3)', async () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );

    await userEvent.click(accountButton());

    const version = within(
      screen.getByRole('menu', {name: 'Account'}),
    ).getByRole('menuitem', {name: 'Version v9.9.9 · abc1234'});
    expect(version).toHaveAttribute('aria-disabled', 'true');
    // MUI turns off pointer events on a disabled item; press it anyway to prove it does nothing.
    await userEvent
      .setup({pointerEventsCheck: PointerEventsCheckLevel.Never})
      .click(version);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(submitted).toEqual([]);
  });

  it('when the account menu is open, then the Arrow keys reach the version, so a keyboard or screen-reader user hears it', async () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );
    await userEvent.click(accountButton());
    const signOut = screen.getByRole('menuitem', {name: 'Sign out'});
    await waitFor(() => {
      expect(signOut).toHaveFocus();
    });

    await userEvent.keyboard('{ArrowDown}');

    expect(
      screen.getByRole('menuitem', {name: 'Version v9.9.9 · abc1234'}),
    ).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(submitted).toEqual([]);
  });

  it('when Sign out is chosen, then nothing is posted yet: a modal "Sign out?" alertdialog asks first, with Cancel focused (W-12c)', async () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );

    const dialog = await openSignOutDialog();

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(
      'Patient data will be cleared from this tablet.',
    );
    expect(within(dialog).getByRole('button', {name: 'Cancel'})).toHaveFocus();
    expect(
      within(dialog).getByRole('button', {name: 'Sign out'}),
    ).toBeInTheDocument();
    expect(submitted).toEqual([]);
  });

  it('when Enter is pressed as the dialog opens, then it cancels — the safe action is the default', async () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );
    await openSignOutDialog();

    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(submitted).toEqual([]);
  });

  it('when Escape is pressed, then the dialog closes without signing out and focus returns to the account button', async () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );
    await openSignOutDialog();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(accountButton()).toHaveFocus();
    });
    expect(submitted).toEqual([]);
  });

  it('when Cancel is pressed, then the dialog closes without signing out and focus returns to the account button', async () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );
    const dialog = await openSignOutDialog();

    await userEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(accountButton()).toHaveFocus();
    });
    expect(submitted).toEqual([]);
  });

  it('when Sign out is confirmed, then the page form-posts an empty body to /bff/logout (API-43)', async () => {
    render(
      <AccountMenu displayName="Dr. Avery Demo" version="v9.9.9 · abc1234" />,
    );
    const dialog = await openSignOutDialog();

    await userEvent.click(
      within(dialog).getByRole('button', {name: 'Sign out'}),
    );

    expect(submitted).toEqual([
      {method: 'post', action: '/bff/logout', fields: []},
    ]);
  });
});
