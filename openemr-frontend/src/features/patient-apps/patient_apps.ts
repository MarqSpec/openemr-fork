import {z} from 'zod';

// Per-patient app launches (the AgentForge module first) as build-time configuration, not code. The SPA only builds
// a link: the target re-checks access and mints its own launch, so no OpenEMR change is needed (NFR-CON-1).
// reference: REQUIREMENTS.md FR-APP-1, NFR-SEC-1

/** One configured app: its visible label, launch URL template and an optional access hint for the clinician. */
export interface PatientApp {
  readonly label: string;
  /** Absolute URL holding `{patientId}`, replaced by the open patient's FHIR id (OpenEMR's patient uuid). */
  readonly url: string;
  readonly aclHint?: string;
}

const PLACEHOLDER = '{patientId}';

/** Local development OpenEMR stacks serve plain http; everything else must be https. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The URL with the placeholder filled by `sample`, or undefined if it is not a safe absolute launch URL. */
function resolved(template: string, sample: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(template.replaceAll(PLACEHOLDER, sample));
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
  if (!template.includes(PLACEHOLDER)) return false;
  const a = resolved(template, 'a');
  const b = resolved(template, 'b');
  return a !== undefined && a.origin === b?.origin;
}

const PatientAppSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    url: z.string().refine(isLaunchTemplate),
    aclHint: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const PatientAppListSchema = z.array(PatientAppSchema).max(8);

/** The configured apps; unset, blank or any invalid entry yields none, so a misconfiguration shows no slot. */
export function parsePatientApps(raw: unknown): readonly PatientApp[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = PatientAppListSchema.safeParse(json);
  if (!parsed.success) return [];
  return parsed.data.map(app =>
    app.aclHint === undefined
      ? {label: app.label, url: app.url}
      : {label: app.label, url: app.url, aclHint: app.aclHint},
  );
}

/** The launch URL for one patient: the placeholder becomes the percent-encoded id, and nothing else is added. */
export function launchUrl(template: string, patientId: string): string {
  return template.replaceAll(PLACEHOLDER, encodeURIComponent(patientId));
}

/** The apps this build was configured with (`VITE_PATIENT_APPS`, a JSON list). */
export const PATIENT_APPS = parsePatientApps(import.meta.env.VITE_PATIENT_APPS);
