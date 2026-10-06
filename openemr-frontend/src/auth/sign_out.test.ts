import {afterEach, describe, expect, it, vi} from 'vitest';

import {BFF_LOGOUT_PATH} from '../api/auth/paths';
import {submitSignOut} from './sign_out';

// reference: REQUIREMENTS.md FR-AUTH-3, FR-AUTH-4 · INTERFACES.md API-43

describe('given a programmatic sign-out through the token handler (API-43)', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('when there is no reason, then the form post has no reason field (explicit sign-out)', () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(() => undefined);
    submitSignOut();

    const form = document.querySelector('form');
    expect(form?.method).toBe('post');
    expect(form?.getAttribute('action')).toBe(BFF_LOGOUT_PATH);
    expect(form?.querySelector('input[name="reason"]')).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('when the reason is idle, then the form post carries reason=idle (inactivity sign-out)', () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(() => undefined);
    submitSignOut({reason: 'idle'});

    const input = document.querySelector<HTMLInputElement>(
      'input[name="reason"]',
    );
    expect(input?.type).toBe('hidden');
    expect(input?.value).toBe('idle');
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
