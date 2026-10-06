import {z} from 'zod';

import {ApiError} from '../api_error';
import type {ApiId} from '../api_error';

// Parse, don't validate: every FHIR body becomes a typed value here, per entry, so one bad resource costs one
// row and never the card. reference: REQUIREMENTS.md FR-CARD-3, NFR-SEC-6

/** A resource that parsed; `resource` is safe to render. */
export interface Displayable<T> {
  readonly kind: 'ok';
  readonly resource: T;
}

/**
 * A resource that did not parse — the card renders "Could not display this item" in its place (FR-CARD-3).
 * `reason` names schema paths and Zod issue codes only; it never holds a field value, so it may be logged.
 */
export interface CouldNotDisplay {
  readonly kind: 'could-not-display';
  readonly resourceType: string;
  readonly reason: string;
}

/**
 * The last item of a search that says it holds more than it sent — a `next` link, or a `total` above its entries.
 * OpenEMR does not page these searches (BUG-7), so this is insurance: the card says more are not shown rather than
 * presenting a partial list as whole. `reason` names the cue and counts only, so it may be logged.
 */
export interface MoreNotShown {
  readonly kind: 'more-not-shown';
  readonly resourceType: string;
  readonly reason: string;
}

export type FhirItem<T> = Displayable<T> | CouldNotDisplay | MoreNotShown;

/** A schema for one resource type: an object whose `resourceType` is a literal. */
export type ResourceSchema<T> = z.ZodType<T> & {
  readonly shape: {readonly resourceType: z.ZodLiteral<string>};
};

const MAX_REASONS = 3;

const nextLinkSchema = z.object({
  relation: z.literal('next'),
  url: z.string().min(1),
});

const bundleSchema = z.object({
  resourceType: z.literal('Bundle'),
  entry: z.array(z.unknown()).optional(),
  // Paging cues only; a malformed one is ignored, never a failure of the entries it came with.
  total: z.number().int().nonnegative().optional().catch(undefined),
  link: z
    .array(z.unknown())
    .optional()
    .catch(undefined)
    .transform(links =>
      (links ?? []).some(link => nextLinkSchema.safeParse(link).success),
    ),
});

const entrySchema = z.object({resource: z.unknown().optional()});
const typedSchema = z.object({resourceType: z.string()});

function resourceTypeOf<T>(schema: ResourceSchema<T>): string {
  return schema.shape.resourceType.value;
}

function couldNotDisplay(resourceType: string, reason: string) {
  return {kind: 'could-not-display', resourceType, reason} as const;
}

/** Describes a schema failure by field path and issue code — never by value (NFR-SEC-6). */
function describeIssues(error: z.ZodError): string {
  const fields = error.issues
    .slice(0, MAX_REASONS)
    .map(issue => `${issue.path.map(String).join('.')} (${issue.code})`);
  const more =
    error.issues.length > MAX_REASONS
      ? `; +${String(error.issues.length - MAX_REASONS)} more`
      : '';
  const label = error.issues.length === 1 ? 'invalid field' : 'invalid fields';
  return `${label}: ${fields.join('; ')}${more}`;
}

/** Parses one resource of the expected type into an item; a wrong or missing type is its own reason. */
export function parseResource<T>(
  schema: ResourceSchema<T>,
  resource: unknown,
): FhirItem<T> {
  const expected = resourceTypeOf(schema);
  const typed = typedSchema.safeParse(resource);
  if (!typed.success || typed.data.resourceType !== expected) {
    return couldNotDisplay(expected, `entry is not a ${expected}`);
  }
  const parsed = schema.safeParse(resource);
  return parsed.success
    ? {kind: 'ok', resource: parsed.data}
    : couldNotDisplay(expected, describeIssues(parsed.error));
}

/** The "more not shown" item when the Bundle says it holds more than it sent, else nothing. */
function moreNotShown(
  resourceType: string,
  hasNext: boolean,
  total: number | undefined,
  sent: number,
): MoreNotShown[] {
  const cues = [
    ...(hasNext ? ['next link'] : []),
    ...(total !== undefined && total > sent
      ? [`total ${String(total)}, ${String(sent)} sent`]
      : []),
  ];
  return cues.length === 0
    ? []
    : [
        {
          kind: 'more-not-shown',
          resourceType,
          reason: `more results not shown: ${cues.join('; ')}`,
        },
      ];
}

/**
 * Parses a search Bundle entry by entry, in server order. Only a body that is not a Bundle at all is a
 * malformed response. OpenEMR never pages these searches (`self` link only — BUG-7), so no `next` is followed; a
 * Bundle that says it holds more than it sent ends in a {@link MoreNotShown} item instead.
 */
export function parseSearchBundle<T>(
  apiId: ApiId,
  schema: ResourceSchema<T>,
  json: unknown,
): FhirItem<T>[] {
  const bundle = bundleSchema.safeParse(json);
  if (!bundle.success) {
    throw new ApiError({kind: 'malformed-response', apiId, status: 200});
  }
  const entries = bundle.data.entry ?? [];
  const items = entries.map((entry): FhirItem<T> => {
    const parsed = entrySchema.safeParse(entry);
    if (!parsed.success || parsed.data.resource === undefined) {
      return couldNotDisplay(resourceTypeOf(schema), 'entry has no resource');
    }
    return parseResource(schema, parsed.data.resource);
  });
  return [
    ...items,
    ...moreNotShown(
      resourceTypeOf(schema),
      bundle.data.link,
      bundle.data.total,
      entries.length,
    ),
  ];
}

/** Parses a read by id: a different resource type is a malformed response; a bad resource is an item. */
export function parseRead<T>(
  apiId: ApiId,
  schema: ResourceSchema<T>,
  json: unknown,
): FhirItem<T> {
  const typed = typedSchema.safeParse(json);
  if (!typed.success || typed.data.resourceType !== resourceTypeOf(schema)) {
    throw new ApiError({kind: 'malformed-response', apiId, status: 200});
  }
  return parseResource(schema, json);
}
