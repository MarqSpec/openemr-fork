import {z} from 'zod';

import {ApiError, httpFailure, parseErrorBody} from '../api_error';
import {readJson} from '../json_body';

// The SPA's per-environment settings, served by the token handler from its own environment (PATIENT_APPS,
// PRIVACY_GRACE_SECONDS) so one image runs in every environment. The token handler parses them first; this is the
// SPA's own boundary, with the same rules the build-time VITE_* variables had. Both parsers' suites run one rule
// table, config/runtime-config-rules.json, so a rule changed on one side only turns that side red.
// reference: INTERFACES.md API-48 · REQUIREMENTS.md FR-APP-1, FR-UI-4, NFR-SEC-1

/** API-48: same origin, no session needed, nothing stored. */
export const BFF_CONFIG_PATH = '/bff/config';

/** In an app's launch URL, replaced by the open patient's FHIR id. */
export const PATIENT_ID_PLACEHOLDER = '{patientId}';

/** One configured app: its visible label, launch URL template and an optional access hint for the clinician. */
export interface PatientApp {
  readonly label: string;
  /** Absolute URL holding `{patientId}`, replaced by the open patient's FHIR id (OpenEMR's patient uuid). */
  readonly url: string;
  readonly aclHint?: string;
}

/** What this environment's token handler says the SPA should do. */
export interface RuntimeConfig {
  /** The patient-apps slot's entries (FR-APP-1); empty = no slot. */
  readonly patientApps: readonly PatientApp[];
  /** Seconds the app may stay hidden, behind the privacy cover, before it signs out (FR-UI-4, W-7). */
  readonly privacyGraceSeconds: number;
}

/** No longer than the default idle timeout: a hidden app must never outlast an idle one. */
const MAX_PRIVACY_GRACE_SECONDS = 15 * 60;

/** Local development OpenEMR stacks serve plain http; everything else must be https. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The URL with the placeholder filled by `sample`, or undefined if it is not a safe absolute launch URL. */
function resolved(template: string, sample: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(template.replaceAll(PATIENT_ID_PLACEHOLDER, sample));
  } catch {
    return undefined;
  }
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '') return undefined;
  return url;
}

/** The patient may fill only the path or query: the server a launch goes to is fixed by configuration. */
function isLaunchTemplate(template: string): boolean {
  if (!template.includes(PATIENT_ID_PLACEHOLDER)) return false;
  const a = resolved(template, 'a');
  const b = resolved(template, 'b');
  return a !== undefined && a.origin === b?.origin;
}

const patientAppListSchema = z
  .array(
    z
      .object({
        label: z.string().trim().min(1).max(60),
        url: z.string().refine(isLaunchTemplate),
        aclHint: z.string().trim().min(1).max(120).optional(),
      })
      .strict(),
  )
  .max(8);

const runtimeConfigSchema = z.object({
  patientApps: z.unknown(),
  privacyGraceSeconds: z.number().int().min(0).max(MAX_PRIVACY_GRACE_SECONDS),
});

/** The apps in `value`; any invalid entry refuses the whole list, so a misconfiguration shows no slot. */
function patientAppsFrom(value: unknown): readonly PatientApp[] {
  const parsed = patientAppListSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map(app =>
    app.aclHint === undefined
      ? {label: app.label, url: app.url}
      : {label: app.label, url: app.url, aclHint: app.aclHint},
  );
}

/**
 * Reads API-48. A bad app list is no apps (no slot); a grace that is not whole seconds 0–900 is `malformed-response`
 * — never a guessed grace, which would decide how long PHI is only covered. Throws only {@link ApiError}.
 */
export async function readRuntimeConfig(
  signal?: AbortSignal,
): Promise<RuntimeConfig> {
  const apiId = 'API-48';
  let response: Response;
  try {
    response = await fetch(new URL(BFF_CONFIG_PATH, window.location.origin), {
      method: 'GET',
      credentials: 'same-origin',
      headers: {Accept: 'application/json'},
      ...(signal === undefined ? {} : {signal}),
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new ApiError({kind: 'network-error', apiId});
  }

  const json = await readJson(response, signal);
  if (!response.ok) {
    throw new ApiError(
      httpFailure(apiId, response.status, parseErrorBody(json)),
    );
  }
  const parsed = runtimeConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      kind: 'malformed-response',
      apiId,
      status: response.status,
    });
  }
  return {
    patientApps: patientAppsFrom(parsed.data.patientApps),
    privacyGraceSeconds: parsed.data.privacyGraceSeconds,
  };
}
