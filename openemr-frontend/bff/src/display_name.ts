import {z} from 'zod';

const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
const MAX_LENGTH = 200;

const humanName = z.object({
  use: z.string().optional(),
  text: z.string().optional(),
  prefix: z.array(z.string()).optional(),
  given: z.array(z.string()).optional(),
  family: z.string().optional(),
  suffix: z.array(z.string()).optional(),
});

const practitionerSchema = z.object({
  resourceType: z.literal('Practitioner'),
  name: z.array(humanName).optional(),
});

/** `definitive`: OpenEMR answered (remember it, even as `null`); `transient`: ask again next time. */
export type DisplayNameResult =
  | {outcome: 'definitive'; displayName: string | null}
  | {outcome: 'transient'; reason: string};

/**
 * The URL of the signed-in clinician's own Practitioner, if `fhirUser` names one on this FHIR base — anything
 * else (a Patient, another host) is never fetched with the bearer.
 */
export function practitionerUrl(
  fhirUser: string | undefined,
  fhirBase: string,
): string | undefined {
  if (fhirUser === undefined) return undefined;
  const prefix = `${fhirBase.replace(/\/+$/, '')}/Practitioner/`;
  if (!fhirUser.startsWith(prefix)) return undefined;
  return FHIR_ID.test(fhirUser.slice(prefix.length)) ? fhirUser : undefined;
}

/** A person's name as shown in the app bar: `text`, else prefix, given, family and suffix; the official one first. */
function nameOf(json: unknown): string | null {
  const parsed = practitionerSchema.safeParse(json);
  if (!parsed.success) return null;
  const names = parsed.data.name ?? [];
  const name = names.find(n => n.use === 'official') ?? names[0];
  if (name === undefined) return null;
  const parts = [
    ...(name.prefix ?? []),
    ...(name.given ?? []),
    name.family ?? '',
    ...(name.suffix ?? []),
  ]
    .map(part => part.trim())
    .filter(part => part !== '');
  const text = name.text?.trim() ?? '';
  const display = text === '' ? parts.join(' ') : text;
  return display === '' ? null : display.slice(0, MAX_LENGTH);
}

/**
 * API-18 for the signed-in clinician (FR-UI-3): `GET {fhirUser}` with the session's bearer. The only PHI-free
 * datum API-42 returns, and it is the clinician's own.
 * reference: INTERFACES.md API-18, API-42
 */
export async function fetchDisplayName(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<DisplayNameResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/fhir+json',
        Authorization: `Bearer ${accessToken}`,
      },
      redirect: 'error',
      signal,
    });
  } catch {
    return {
      outcome: 'transient',
      reason: signal.aborted ? 'timeout' : 'unreachable',
    };
  }
  if (response.status >= 500) {
    return {outcome: 'transient', reason: String(response.status)};
  }
  if (!response.ok) return {outcome: 'definitive', displayName: null};
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return {outcome: 'definitive', displayName: nameOf(json)};
}
