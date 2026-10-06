import {z} from 'zod';

export type NotReadyReason =
  'unreachable' | 'timeout' | 'upstream_status' | 'invalid_discovery';

export type Readiness = {ready: true} | {ready: false; reason: NotReadyReason};

/** The fields every SMART configuration carries; enough to tell it from a proxy's error page. */
const smartConfigurationSchema = z.object({
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
});

/**
 * Ready means OpenEMR's SMART discovery (API-2) answers with a SMART configuration.
 * reference: REQUIREMENTS.md BUG-28 (never FHIR `metadata`, which takes seconds)
 */
export async function checkReadiness(
  smartDiscoveryUrl: string,
  timeoutMs: number,
): Promise<Readiness> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(smartDiscoveryUrl, {
      headers: {Accept: 'application/json'},
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel();
      return {ready: false, reason: 'upstream_status'};
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ready: false,
        reason: controller.signal.aborted ? 'timeout' : 'invalid_discovery',
      };
    }
    return smartConfigurationSchema.safeParse(body).success
      ? {ready: true}
      : {ready: false, reason: 'invalid_discovery'};
  } catch {
    return {
      ready: false,
      reason: controller.signal.aborted ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** How long one readiness answer, ready or not, is reused before OpenEMR is asked again. */
export const READY_CACHE_MS = 5_000;

export interface ReadinessProbe {
  check(): Promise<Readiness>;
}

/**
 * {@link checkReadiness}, with its answer reused for {@link READY_CACHE_MS} and concurrent probes sharing one call,
 * so a probe storm reaches OpenEMR at most once per window. A failure is cached as well: that is when OpenEMR can
 * least afford the load. A separate change, INTERFACES.md API-45
 */
export function createReadinessProbe(
  smartDiscoveryUrl: string,
  timeoutMs: number,
  /** A monotonic clock in ms (`performance.now()`), never the wall clock. */
  deps: {now: () => number},
): ReadinessProbe {
  let cached: {readiness: Readiness; until: number} | undefined;
  let inFlight: Promise<Readiness> | undefined;
  return {
    check() {
      if (cached !== undefined && cached.until > deps.now()) {
        return Promise.resolve(cached.readiness);
      }
      inFlight ??= checkReadiness(smartDiscoveryUrl, timeoutMs)
        .then(readiness => {
          // The window starts when the answer arrives, so a slow check is not stale on arrival.
          cached = {readiness, until: deps.now() + READY_CACHE_MS};
          return readiness;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
