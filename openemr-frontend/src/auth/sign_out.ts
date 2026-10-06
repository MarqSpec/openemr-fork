import {BFF_LOGOUT_PATH} from '../api/auth/paths';

// reference: INTERFACES.md API-43 · REQUIREMENTS.md FR-AUTH-3, FR-AUTH-4, FR-BFF-6

export type SignOutReason = 'idle';

export interface SignOutOptions {
  readonly reason?: SignOutReason;
}

/**
 * Signs out without a click: the same top-level form post to API-43 as the account menu's Sign out (an empty
 * urlencoded body when there is no reason, no custom header), so the token handler ends the session and OpenEMR's,
 * then lands on W-1b. Automatic logoff and the privacy-screen grace period pass `reason=idle`.
 */
export function submitSignOut(options: SignOutOptions = {}): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = BFF_LOGOUT_PATH;
  form.hidden = true;
  if (options.reason !== undefined) {
    const reason = document.createElement('input');
    reason.type = 'hidden';
    reason.name = 'reason';
    reason.value = options.reason;
    form.append(reason);
  }
  document.body.append(form);
  form.submit();
}
