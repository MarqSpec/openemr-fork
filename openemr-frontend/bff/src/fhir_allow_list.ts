/**
 * API-44's allow-list: the FHIR reads INTERFACES.md §3–§5 lists (API-10…24), each as an exact path
 * shape and the query parameters it may carry. Nothing here is derived from the request; a request either matches
 * a row exactly or is refused.
 * API-15 and API-16 are one row, `API-15/16`: both cards send the same request, and the proxy cannot tell which.
 * reference: INTERFACES.md API-10…24, API-44 · REQUIREMENTS.md FR-BFF-3
 */

export type FhirApiId =
  | 'API-10'
  | 'API-11'
  | 'API-12'
  | 'API-13'
  | 'API-14'
  | 'API-15/16'
  | 'API-17'
  | 'API-18'
  | 'API-19'
  | 'API-20'
  | 'API-21'
  | 'API-22'
  | 'API-23'
  | 'API-24';

/** A value rule for one query parameter. */
type ValueRule = (value: string) => boolean;

interface ParamRule {
  required: boolean;
  valid: ValueRule;
}

interface Row {
  apiId: FhirApiId;
  /** The resource type (or `metadata`) — the first path segment, matched exactly. */
  resource: string;
  /** `read`: `{resource}/{id}`, no query. `search`: `{resource}` with the listed parameters. */
  kind: 'read' | 'search';
  params: Readonly<Record<string, ParamRule>>;
}

/** An allow-listed read, rebuilt from validated parts only. */
export interface AllowListedRead {
  apiId: FhirApiId;
  kind: 'read' | 'search';
  /** Path under the FHIR base, e.g. `Patient/{id}` or `Condition`. */
  path: string;
  /** Validated parameters, re-encoded; empty for a read. */
  query: URLSearchParams;
}

/** FHIR `id` (R4 §2.24.0.1) character shape, matching the SPA's own `schemas.ts` `FHIR_ID` regex — which,
 * like this one, still matches the literals `.` and `..`. The SPA's parser (`resources.ts` `fhirId`) rejects
 * those two separately on top of the regex; the `id` rule below does the same. */
const FHIR_ID = /^[A-Za-z0-9.-]{1,64}$/;
const FHIR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const id: ValueRule = value =>
  FHIR_ID.test(value) && value !== '.' && value !== '..';
const exactly =
  (...allowed: string[]): ValueRule =>
  value =>
    allowed.includes(value);
const pattern =
  (regex: RegExp): ValueRule =>
  value =>
    regex.test(value);
/** `ge{YYYY-MM-DD}`: every dated search in the inventory is a lower bound. */
const onOrAfter: ValueRule = value =>
  value.startsWith('ge') && FHIR_DATE.test(value.slice(2));
const idList: ValueRule = value => {
  const ids = value.split(',');
  return ids.length <= 50 && ids.every(id);
};

const need = (valid: ValueRule): ParamRule => ({required: true, valid});
const may = (valid: ValueRule): ParamRule => ({required: false, valid});

const patient = need(id);

/** The inventory's rows, in its order. Rows sharing a path are told apart by their fixed values. */
const ROWS: readonly Row[] = [
  {apiId: 'API-10', resource: 'metadata', kind: 'search', params: {}},
  {
    apiId: 'API-11',
    resource: 'Patient',
    kind: 'search',
    params: {
      name: may(pattern(/^[\p{L}\p{M}' .-]{1,64}$/u)),
      birthdate: may(value =>
        FHIR_DATE.test(value.startsWith('eq') ? value.slice(2) : value),
      ),
      identifier: may(pattern(/^[A-Za-z0-9|._:-]{1,64}$/)),
      _count: may(pattern(/^[1-9]\d{0,2}$/)),
      _offset: may(pattern(/^\d{1,6}$/)),
    },
  },
  {apiId: 'API-12', resource: 'Patient', kind: 'read', params: {}},
  {
    apiId: 'API-13',
    resource: 'AllergyIntolerance',
    kind: 'search',
    params: {patient},
  },
  {
    apiId: 'API-14',
    resource: 'Condition',
    kind: 'search',
    params: {patient, category: need(exactly('problem-list-item'))},
  },
  // Every intent, no `intent` or `status`: the Medications and Prescriptions cards both read this.
  {
    apiId: 'API-15/16',
    resource: 'MedicationRequest',
    kind: 'search',
    params: {patient},
  },
  {
    apiId: 'API-17',
    resource: 'CareTeam',
    kind: 'search',
    params: {
      patient,
      status: may(
        exactly(
          'proposed',
          'active',
          'suspended',
          'inactive',
          'entered-in-error',
        ),
      ),
    },
  },
  {apiId: 'API-18', resource: 'Practitioner', kind: 'read', params: {}},
  // The `_id` batch is [CONFIRM] in the inventory: allowed so NFR-PERF-3 can use it once confirmed.
  {
    apiId: 'API-18',
    resource: 'Practitioner',
    kind: 'search',
    params: {_id: need(idList)},
  },
  {apiId: 'API-19', resource: 'Organization', kind: 'read', params: {}},
  {
    apiId: 'API-20',
    resource: 'Encounter',
    kind: 'search',
    params: {patient, date: need(onOrAfter)},
  },
  // The Vitals card's read and nothing wider: it shows every vital of the newest set, so no `code`.
  {
    apiId: 'API-21',
    resource: 'Observation',
    kind: 'search',
    params: {
      patient,
      category: need(exactly('vital-signs')),
      date: need(onOrAfter),
    },
  },
  // The Labs card's read and nothing wider: it shows the latest result of every test, so no `code`.
  {
    apiId: 'API-22',
    resource: 'Observation',
    kind: 'search',
    params: {
      patient,
      category: need(exactly('laboratory')),
      date: need(onOrAfter),
    },
  },
  // The Immunizations card's read and nothing wider: every immunization, as legacy lists them.
  {
    apiId: 'API-23',
    resource: 'Immunization',
    kind: 'search',
    params: {patient},
  },
  // The Appointments card's read and nothing wider: every appointment from the tablet's today on.
  {
    apiId: 'API-24',
    resource: 'Appointment',
    kind: 'search',
    params: {patient, date: need(onOrAfter)},
  },
];

export const FHIR_PROXY_PREFIX = '/bff/fhir/';

/**
 * Only unreserved path characters and `/`: no `%` (so no encoded `/`, `\` or `.`), no `\`, no `;`. Checked on the
 * raw request target, before anything decodes it.
 */
const RAW_PATH = /^[A-Za-z0-9.-]+(?:\/[A-Za-z0-9.-]+)?$/;

/**
 * Matches the raw request target (`/bff/fhir/…?…`, as received) against the allow-list. Anything that is not an
 * exact match — an unknown resource or parameter, a repeated or empty parameter, a traversal or encoded
 * separator, an empty segment — is `undefined`.
 */
export function matchAllowListed(rawUrl: string): AllowListedRead | undefined {
  const queryAt = rawUrl.indexOf('?');
  const rawPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : rawUrl.slice(queryAt + 1);
  if (!rawPath.startsWith(FHIR_PROXY_PREFIX)) return undefined;
  const path = rawPath.slice(FHIR_PROXY_PREFIX.length);
  if (!RAW_PATH.test(path)) return undefined;
  const [resource = '', resourceId] = path.split('/');

  const params = parseQuery(rawQuery);
  if (params === undefined) return undefined;

  for (const row of ROWS) {
    if (row.resource !== resource) continue;
    if (row.kind === 'read') {
      if (resourceId === undefined || !id(resourceId) || params.size > 0) {
        continue;
      }
      return {
        apiId: row.apiId,
        kind: 'read',
        path: `${resource}/${resourceId}`,
        query: new URLSearchParams(),
      };
    }
    if (resourceId !== undefined || !paramsMatch(row, params)) continue;
    return {
      apiId: row.apiId,
      kind: 'search',
      path: resource,
      query: new URLSearchParams([...params]),
    };
  }
  return undefined;
}

/** Decoded parameters, or `undefined` when one repeats, is empty or has an empty name. */
function parseQuery(rawQuery: string): Map<string, string> | undefined {
  const params = new Map<string, string>();
  if (rawQuery === '') return params;
  for (const [name, value] of new URLSearchParams(rawQuery)) {
    if (name === '' || value === '' || params.has(name)) return undefined;
    params.set(name, value);
  }
  return params;
}

function paramsMatch(row: Row, params: Map<string, string>): boolean {
  for (const [name, value] of params) {
    // Own keys only: a parameter named `constructor` or `__proto__` must not find Object's.
    const rule = Object.hasOwn(row.params, name) ? row.params[name] : undefined;
    if (!rule?.valid(value)) return false;
  }
  return Object.entries(row.params).every(
    ([name, rule]) => !rule.required || params.has(name),
  );
}
