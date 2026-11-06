import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

// The SPA's per-environment settings, read from this service's environment at start-up and served at /bff/config,
// so one image runs in every environment. The SPA re-parses the answer at its own boundary; the rules
// here are the ones it applies. The two share no code, so both test suites run one rule table,
// config/runtime-config-rules.json: a rule changed on one side only turns that side red.
// reference: INTERFACES.md API-48 · REQUIREMENTS.md FR-APP-1, FR-UI-4, NFR-SEC-1

/** One per-patient app: its label, a launch URL template holding `{patientId}` and an optional access hint. */
export interface PatientApp {
  readonly label: string;
  readonly url: string;
  readonly aclHint?: string;
}

/** What `/bff/config` answers: public, per-environment, never a secret and never PHI. */
export interface SpaRuntimeConfig {
  readonly patientApps: readonly PatientApp[];
  /** Seconds the app may stay hidden, behind the privacy cover, before it signs out (W-7). */
  readonly privacyGraceSeconds: number;
}

export const DEFAULT_PRIVACY_GRACE_SECONDS = 60;
/** No longer than the default idle timeout: a hidden app must never outlast an idle one. */
const MAX_PRIVACY_GRACE_SECONDS = 15 * 60;
const MAX_PATIENT_APPS = 8;
const PLACEHOLDER = '{patientId}';
/** Local development OpenEMR stacks serve plain http; everything else must be https. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const PATIENT_APPS_RULE =
  'must be a JSON list of at most 8 apps, each {"label" (1-60 characters), "url" (an absolute https URL with ' +
  '{patientId} in its path or query), "aclHint"? (1-120 characters)}; no Patient apps slot is shown';
const GRACE_RULE = `must be whole seconds from 0 to ${String(MAX_PRIVACY_GRACE_SECONDS)}; the default ${String(DEFAULT_PRIVACY_GRACE_SECONDS)} is used`;

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

const PatientAppListSchema = z
  .array(
    z
      .object({
        label: z.string().trim().min(1).max(60),
        url: z.string().refine(isLaunchTemplate),
        aclHint: z.string().trim().min(1).max(120).optional(),
      })
      .strict(),
  )
  .max(MAX_PATIENT_APPS);

/**
 * `PATIENT_APPS`, a JSON list. Unset or blank is no apps; anything invalid is no apps too — one bad entry refuses the
 * whole list — with a `problem` naming the rule and where, never the value.
 */
export function parsePatientApps(raw: string | undefined): {
  apps: readonly PatientApp[];
  problem?: string;
} {
  if (raw === undefined || raw.trim() === '') return {apps: []};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {apps: [], problem: `${PATIENT_APPS_RULE} (not JSON)`};
  }
  const parsed = PatientAppListSchema.safeParse(json);
  if (!parsed.success) {
    // Zod issue paths are indexes and key names only, never a value.
    const where = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    return {
      apps: [],
      problem: `${PATIENT_APPS_RULE} (first problem at ${where === '' ? 'the list' : where})`,
    };
  }
  return {
    apps: parsed.data.map(app =>
      app.aclHint === undefined
        ? {label: app.label, url: app.url}
        : {label: app.label, url: app.url, aclHint: app.aclHint},
    ),
  };
}

/** `PRIVACY_GRACE_SECONDS`: whole seconds from 0 to 900; unset or blank is the default, anything else is too. */
export function parsePrivacyGraceSeconds(raw: string | undefined): {
  seconds: number;
  problem?: string;
} {
  if (raw === undefined || raw === '') {
    return {seconds: DEFAULT_PRIVACY_GRACE_SECONDS};
  }
  if (/^\d{1,4}$/.test(raw) && Number(raw) <= MAX_PRIVACY_GRACE_SECONDS) {
    return {seconds: Number(raw)};
  }
  return {seconds: DEFAULT_PRIVACY_GRACE_SECONDS, problem: GRACE_RULE};
}

/**
 * The SPA's settings from the environment. A bad value never stops start-up — a misconfigured link list must not
 * take the clinical app down — but each is reported through `warn` by variable and rule.
 */
export function parseSpaRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
  warn: (variable: string, rule: string) => void,
): SpaRuntimeConfig {
  const apps = parsePatientApps(env.PATIENT_APPS);
  if (apps.problem !== undefined) warn('PATIENT_APPS', apps.problem);
  const grace = parsePrivacyGraceSeconds(env.PRIVACY_GRACE_SECONDS);
  if (grace.problem !== undefined) warn('PRIVACY_GRACE_SECONDS', grace.problem);
  return {patientApps: apps.apps, privacyGraceSeconds: grace.seconds};
}

/**
 * API-48: `GET /bff/config`. No session needed — the SPA reads it beside API-42 before it renders a chart — and
 * nothing upstream: the answer is fixed at start-up. `no-store` like every `/bff/*` answer (server.ts onSend).
 */
export function registerRuntimeConfigRoute(
  app: FastifyInstance,
  spa: SpaRuntimeConfig,
): void {
  const body = {
    patientApps: spa.patientApps,
    privacyGraceSeconds: spa.privacyGraceSeconds,
  };
  app.get('/bff/config', {exposeHeadRoute: false}, () => body);
  app.route({
    method: ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/bff/config',
    handler: (_request, reply) =>
      reply
        .code(405)
        .header('allow', 'GET')
        .send({error: 'method_not_allowed'}),
  });
}
