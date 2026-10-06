import {z} from 'zod';

// reference: REQUIREMENTS.md FR-AUTH-5, NFR-SEC-6 · REQUIREMENTS.md BUG-33

/**
 * The inventory row a call implements (`INTERFACES.md`); the only call identity an error carries. API-15 and
 * API-16 are one request, `API-15/16`, as the token handler logs it.
 */
export type ApiId = `API-${number}` | 'API-15/16';

/**
 * What an error body said, reduced to values that cannot carry PHI: FHIR IssueType codes (allow-listed), or counts from
 * OpenEMR's REST envelope. Diagnostics text and validation messages can echo request values, so they are dropped.
 */
export type ErrorBody =
  | {readonly format: 'operation-outcome'; readonly issueCodes: string[]}
  | {
      readonly format: 'rest-envelope';
      readonly validationErrorCount: number;
      readonly internalErrorCount: number;
    }
  | {readonly format: 'unrecognised'};

interface HttpFailure<K extends string, S extends number = number> {
  readonly kind: K;
  readonly apiId: ApiId;
  readonly status: S;
  readonly body: ErrorBody;
}

/** 401 from `/bff/*`: the token handler has no live session — clear PHI and sign in again (FR-AUTH-5). */
export type SessionOver = HttpFailure<'session-over', 401>;
/** 403: scope declined or ACL refused — the card shows "Not authorised to view" (FR-AUTH-5). */
export type NotAuthorised = HttpFailure<'not-authorised', 403>;
/** 404: no such resource, or a path the token handler does not allow-list (FR-BFF-3). */
export type NotFound = HttpFailure<'not-found', 404>;
/** Any other 4xx, e.g. OpenEMR's 400 with the REST envelope (BUG-33). */
export type Rejected = HttpFailure<'rejected'>;
/** 5xx, or a status the layer has no other meaning for. */
export type ServerError = HttpFailure<'server-error'>;

/** The request never got an HTTP answer (offline, DNS, connection reset). */
export interface NetworkError {
  readonly kind: 'network-error';
  readonly apiId: ApiId;
}

/** An id the caller passed is not a valid FHIR id (or is `.`/`..`); nothing was sent. */
export interface InvalidId {
  readonly kind: 'invalid-id';
  readonly apiId: ApiId;
}

/** A 2xx whose body is not the FHIR shape the call expects (not JSON, wrong resourceType, no Bundle). */
export interface MalformedResponse {
  readonly kind: 'malformed-response';
  readonly apiId: ApiId;
  readonly status: number;
}

export type ApiFailure =
  | SessionOver
  | NotAuthorised
  | NotFound
  | Rejected
  | ServerError
  | NetworkError
  | MalformedResponse
  | InvalidId;

/** The one error the API layer throws. Its message names the call and the failure kind only — never a value. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(readonly failure: ApiFailure) {
    super(
      'status' in failure
        ? `${failure.apiId} ${failure.kind} (${String(failure.status)})`
        : `${failure.apiId} ${failure.kind}`,
    );
  }
}

/** True for failures worth one more attempt: the server or the network may recover; nothing else will. */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const {kind} = error.failure;
  return kind === 'server-error' || kind === 'network-error';
}

/** FHIR R4 IssueType (http://hl7.org/fhir/issue-type): the only issue text an error keeps. */
const ISSUE_TYPES: ReadonlySet<string> = new Set([
  'invalid',
  'structure',
  'required',
  'value',
  'invariant',
  'security',
  'login',
  'unknown',
  'expired',
  'forbidden',
  'suppressed',
  'processing',
  'not-supported',
  'duplicate',
  'multiple-matches',
  'not-found',
  'deleted',
  'too-long',
  'code-invalid',
  'extension',
  'too-costly',
  'business-rule',
  'conflict',
  'transient',
  'lock-error',
  'no-store',
  'exception',
  'timeout',
  'incomplete',
  'throttled',
  'informational',
]);

const operationOutcomeSchema = z.object({
  resourceType: z.literal('OperationOutcome'),
  issue: z.array(z.object({code: z.string()})),
});

const restEnvelopeSchema = z
  .object({
    validationErrors: z
      .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
      .optional(),
    internalErrors: z
      .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
      .optional(),
  })
  .refine(
    envelope =>
      envelope.validationErrors !== undefined ||
      envelope.internalErrors !== undefined,
  );

function countOf(errors: unknown[] | Record<string, unknown> | undefined) {
  if (errors === undefined) return 0;
  return Array.isArray(errors) ? errors.length : Object.keys(errors).length;
}

/** Accepts both error shapes OpenEMR's FHIR routes return (BUG-33); anything else is `unrecognised`. */
export function parseErrorBody(json: unknown): ErrorBody {
  const outcome = operationOutcomeSchema.safeParse(json);
  if (outcome.success) {
    return {
      format: 'operation-outcome',
      issueCodes: outcome.data.issue
        .map(issue => issue.code)
        .filter(code => ISSUE_TYPES.has(code)),
    };
  }
  const envelope = restEnvelopeSchema.safeParse(json);
  if (envelope.success) {
    return {
      format: 'rest-envelope',
      validationErrorCount: countOf(envelope.data.validationErrors),
      internalErrorCount: countOf(envelope.data.internalErrors),
    };
  }
  return {format: 'unrecognised'};
}

/** Maps a non-2xx status to its failure kind (FR-AUTH-5: 401 ends the session, 403 is per card). */
export function httpFailure(
  apiId: ApiId,
  status: number,
  body: ErrorBody,
): ApiFailure {
  switch (status) {
    case 401:
      return {kind: 'session-over', apiId, status, body};
    case 403:
      return {kind: 'not-authorised', apiId, status, body};
    case 404:
      return {kind: 'not-found', apiId, status, body};
    default:
      return status >= 400 && status < 500
        ? {kind: 'rejected', apiId, status, body}
        : {kind: 'server-error', apiId, status, body};
  }
}
