// The app's in-app routes. A chart opens by the patient's logical id only — never a name, DOB or MRN in the URL.
// reference: REQUIREMENTS.md FR-PAT-2

export type Route =
  | {readonly kind: 'home'}
  | {readonly kind: 'patient'; readonly patientId: string};

const PATIENT = /^\/patient\/([^/]+)\/?$/;

/** The route for a URL path; anything unrecognised is home. The id is checked by the API layer, not here. */
export function parseRoute(pathname: string): Route {
  const segment = PATIENT.exec(pathname)?.[1];
  if (segment === undefined) return {kind: 'home'};
  try {
    return {kind: 'patient', patientId: decodeURIComponent(segment)};
  } catch {
    return {kind: 'home'};
  }
}

/** The dashboard path for a patient. */
export function patientPath(patientId: string): string {
  return `/patient/${encodeURIComponent(patientId)}`;
}
