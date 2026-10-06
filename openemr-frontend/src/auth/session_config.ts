// Build-time session settings. The idle timeout itself is the token handler's (BFF_IDLE_TIMEOUT_SECONDS, reported as
// API-42's idleTimeoutSeconds), so client and server agree on it; only the privacy grace is the SPA's own.
// reference: REQUIREMENTS.md FR-AUTH-4, FR-UI-4, NFR-SEC-3

/** How long the app may stay hidden (W-7) before it signs out, when `VITE_PRIVACY_GRACE_SECONDS` is unset. */
export const DEFAULT_PRIVACY_GRACE_SECONDS = 60;

/** No longer than the default idle timeout: a hidden app must never outlast an idle one. */
const MAX_PRIVACY_GRACE_SECONDS = 15 * 60;

/** The grace period in seconds: a whole number from 0 to 900, else the default. */
export function privacyGraceSeconds(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) {
    return DEFAULT_PRIVACY_GRACE_SECONDS;
  }
  const seconds = Number(raw);
  return seconds <= MAX_PRIVACY_GRACE_SECONDS
    ? seconds
    : DEFAULT_PRIVACY_GRACE_SECONDS;
}

/** The grace this build was configured with. */
export const PRIVACY_GRACE_SECONDS = privacyGraceSeconds(
  import.meta.env.VITE_PRIVACY_GRACE_SECONDS,
);
