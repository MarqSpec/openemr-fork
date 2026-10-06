// Dependency hygiene (NFR-SEC-8): the pure checks behind check.ts — audit allow-list, licence allow-list, no
// runtime CDN references in the build. No I/O here; check.ts reads files and runs npm.
// reference: REQUIREMENTS.md NFR-SEC-8;

/** One `packages` entry of an npm v2/v3 lockfile, as far as these checks read it. */
export interface LockEntry {
  version?: string;
  license?: unknown;
  dev?: boolean;
  link?: boolean;
  name?: string;
}

export interface Lockfile {
  name?: string;
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

export interface AuditAllowEntry {
  id: string;
  package: string;
  in: string[];
  // "dev" (verified against the lockfile) or "production"; typed loosely because it is read from JSON.
  scope: string;
  reason: string;
  reviewed: string;
  expires: string;
}

export interface AuditAllowlist {
  advisories: AuditAllowEntry[];
}

export interface Advisory {
  id: string;
  package: string;
  severity: string;
  title: string;
  url: string;
  nodes: string[];
}

export interface CheckResult {
  problems: string[];
  notes: string[];
}

const BLOCKING = new Set(['high', 'critical']);
const GHSA = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** The longest an allow-list entry may stand before its review is due. Here, not in the file it limits. */
export const MAX_REVIEW_DAYS = 90;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDate(value: string): number | null {
  if (!ISO_DATE.test(value)) {
    return null;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** The advisories an `npm audit --json` (report v2) names; throws if it is not one, so a failed audit is red. */
export function advisoriesFromReport(report: unknown): Advisory[] {
  if (!isRecord(report)) {
    throw new Error('npm audit printed no JSON object');
  }
  if (isRecord(report.error)) {
    const summary = report.error.summary;
    throw new Error(
      `npm audit failed: ${typeof summary === 'string' ? summary : 'unknown error'}`,
    );
  }
  const vulnerabilities = report.vulnerabilities;
  if (report.auditReportVersion !== 2 || !isRecord(vulnerabilities)) {
    throw new Error('npm audit output is not an audit report (version 2)');
  }
  const found = new Map<string, Advisory>();
  for (const vulnerability of Object.values(vulnerabilities)) {
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
      continue;
    }
    for (const via of vulnerability.via as unknown[]) {
      // A string `via` is a dependency path to another entry, which carries the advisory itself.
      if (!isRecord(via) || typeof via.url !== 'string') {
        continue;
      }
      const pkg = String(via.name);
      const id = via.url.split('/').pop() ?? via.url;
      const owner = vulnerabilities[pkg];
      const nodes =
        isRecord(owner) && Array.isArray(owner.nodes)
          ? (owner.nodes as unknown[]).map(String)
          : [];
      found.set(`${pkg} ${id}`, {
        id,
        package: pkg,
        severity: String(via.severity),
        title: String(via.title),
        url: via.url,
        nodes,
      });
    }
  }
  return [...found.values()].sort((a, b) =>
    `${a.package} ${a.id}`.localeCompare(`${b.package} ${b.id}`),
  );
}

/**
 * Problems with the allow-list file itself: every entry reasoned, reviewed no later than today, and expiring at most
 * MAX_REVIEW_DAYS after both its review and today, so a future-dated entry cannot stretch the window.
 */
export function allowlistProblems(
  list: AuditAllowlist,
  today: string,
): string[] {
  const problems: string[] = [];
  const todayMs = parseDate(today);
  if (todayMs === null) {
    return [`today (${today}) is not YYYY-MM-DD`];
  }
  const cap = MAX_REVIEW_DAYS * DAY_MS;
  for (const entry of list.advisories) {
    const label = `${entry.id} (${entry.package})`;
    if (!GHSA.test(entry.id)) {
      problems.push(`${label}: id must be a GHSA id`);
    }
    if (entry.reason.trim().length < 20) {
      problems.push(`${label}: reason must say why it is acceptable`);
    }
    if (entry.in.length === 0) {
      problems.push(`${label}: "in" names no package`);
    }
    if (entry.scope !== 'dev' && entry.scope !== 'production') {
      problems.push(`${label}: scope must be "dev" or "production"`);
    }
    const reviewed = parseDate(entry.reviewed);
    const expires = parseDate(entry.expires);
    if (reviewed === null || expires === null) {
      problems.push(`${label}: reviewed and expires must be YYYY-MM-DD`);
      continue;
    }
    if (reviewed > todayMs) {
      problems.push(`${label}: reviewed ${entry.reviewed} is after today`);
    }
    if (expires <= reviewed) {
      problems.push(`${label}: expires must be after reviewed`);
    } else if (expires - todayMs > cap) {
      problems.push(
        `${label}: expires ${entry.expires}, more than ${String(MAX_REVIEW_DAYS)} days from today`,
      );
    } else if (expires - reviewed > cap) {
      problems.push(
        `${label}: expires ${entry.expires}, more than ${String(MAX_REVIEW_DAYS)} days after reviewed`,
      );
    }
  }
  return problems;
}

/**
 * The audit gate for one package: every high/critical advisory must be allow-listed for it, unexpired, and (scope
 * "dev") reachable only through dev dependencies; every entry for it must still match an advisory.
 */
export function evaluateAudit(
  advisories: Advisory[],
  list: AuditAllowlist,
  lock: Lockfile,
  today: string,
): CheckResult {
  const pkgName = lock.name ?? '(unnamed)';
  const problems = allowlistProblems(list, today);
  const notes: string[] = [];
  const entries = list.advisories.filter(entry => entry.in.includes(pkgName));
  const used = new Set<AuditAllowEntry>();
  const todayMs = parseDate(today);
  for (const advisory of advisories) {
    const label = `${advisory.severity} ${advisory.id} in ${advisory.package} — ${advisory.title}`;
    if (!BLOCKING.has(advisory.severity)) {
      notes.push(`below the gate (not blocking): ${label}`);
      continue;
    }
    const entry = entries.find(
      e => e.id === advisory.id && e.package === advisory.package,
    );
    if (entry === undefined) {
      problems.push(`not allow-listed: ${label} (${advisory.url})`);
      continue;
    }
    used.add(entry);
    const expires = parseDate(entry.expires);
    if (todayMs === null || expires === null || expires < todayMs) {
      problems.push(
        `allow-list entry expired ${entry.expires}: ${label} — review it again`,
      );
      continue;
    }
    if (entry.scope === 'dev') {
      const shipped = advisory.nodes.filter(
        node => lock.packages?.[node]?.dev !== true,
      );
      if (advisory.nodes.length === 0 || shipped.length > 0) {
        problems.push(
          `allow-listed as dev-only but reachable from production dependencies: ${label} (${shipped.join(', ') || 'no install path reported'})`,
        );
        continue;
      }
    }
    notes.push(`allow-listed until ${entry.expires}: ${label}`);
  }
  for (const entry of entries) {
    if (!used.has(entry)) {
      problems.push(
        `stale allow-list entry: ${entry.id} (${entry.package}) is no longer reported for ${pkgName} — remove it`,
      );
    }
  }
  return {problems, notes};
}

export interface LicenceException {
  package: string;
  in: string[];
  version: string;
  license: string;
  reason: string;
}

export interface LicencePolicy {
  allowed: string[];
  exceptions: LicenceException[];
}

type Expr =
  {kind: 'id'; id: string} | {kind: 'and' | 'or'; left: Expr; right: Expr};

/** A small SPDX expression parser: identifiers (a `WITH` exception stays part of the id), AND, OR, parentheses. */
export function parseSpdx(text: string): Expr | null {
  const tokens = text.replace(/[()]/g, ' $& ').trim().split(/\s+/);
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  function primary(): Expr | null {
    const token = tokens[at++];
    if (token === undefined || token === ')' || /^(AND|OR|WITH)$/.test(token)) {
      return null;
    }
    if (token === '(') {
      const inner = or();
      return tokens[at++] === ')' ? inner : null;
    }
    let id = token;
    if (peek() === 'WITH') {
      const exception = tokens[at + 1];
      if (exception === undefined || exception === '(' || exception === ')') {
        return null;
      }
      id = `${id} WITH ${exception}`;
      at += 2;
    }
    return {kind: 'id', id};
  }
  function and(): Expr | null {
    let left = primary();
    while (left !== null && peek() === 'AND') {
      at++;
      const right = primary();
      left = right === null ? null : {kind: 'and', left, right};
    }
    return left;
  }
  function or(): Expr | null {
    let left = and();
    while (left !== null && peek() === 'OR') {
      at++;
      const right = and();
      left = right === null ? null : {kind: 'or', left, right};
    }
    return left;
  }
  const expr = or();
  return expr !== null && at === tokens.length ? expr : null;
}

function satisfies(expr: Expr, allowed: ReadonlySet<string>): boolean {
  switch (expr.kind) {
    case 'id':
      return allowed.has(expr.id);
    case 'and':
      return satisfies(expr.left, allowed) && satisfies(expr.right, allowed);
    case 'or':
      return satisfies(expr.left, allowed) || satisfies(expr.right, allowed);
  }
}

/** Is this `license` field acceptable under the allow-list? An OR needs one allowed side, an AND both. */
export function licenceAllowed(
  license: unknown,
  allowed: readonly string[],
): boolean {
  if (typeof license !== 'string') {
    return false;
  }
  const expr = parseSpdx(license);
  return expr !== null && satisfies(expr, new Set(allowed));
}

function packageName(lockPath: string, entry: LockEntry): string {
  if (entry.name !== undefined) {
    return entry.name;
  }
  const at = lockPath.lastIndexOf('node_modules/');
  return at === -1 ? lockPath : lockPath.slice(at + 'node_modules/'.length);
}

/**
 * The licence gate for one lockfile: every package installed outside the dev tree (what the SPA bundles, or what
 * the token handler's image runs) must carry an allowed licence or be an exact-version exception; exceptions must
 * still match. The root entry is this project itself.
 */
export function evaluateLicences(
  lock: Lockfile,
  policy: LicencePolicy,
): CheckResult & {checked: number} {
  const problems: string[] = [];
  const notes: string[] = [];
  const used = new Set<LicenceException>();
  let checked = 0;
  if (lock.lockfileVersion === undefined || lock.lockfileVersion < 2) {
    return {
      problems: ['lockfile is not npm lockfile version 2 or 3'],
      notes,
      checked,
    };
  }
  for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
    if (lockPath === '' || entry.dev === true || entry.link === true) {
      continue;
    }
    checked++;
    const name = packageName(lockPath, entry);
    const version = entry.version ?? '?';
    if (licenceAllowed(entry.license, policy.allowed)) {
      continue;
    }
    const exception = policy.exceptions.find(
      e =>
        e.in.includes(lock.name ?? '') &&
        e.package === name &&
        e.version === version &&
        e.license === entry.license,
    );
    const shown =
      typeof entry.license === 'string'
        ? entry.license
        : JSON.stringify(entry.license ?? null);
    if (exception === undefined) {
      problems.push(`licence not allowed: ${name}@${version} — ${shown}`);
    } else {
      used.add(exception);
      notes.push(`exception: ${name}@${version} — ${shown}`);
    }
  }
  for (const exception of policy.exceptions) {
    if (!used.has(exception) && exception.in.includes(lock.name ?? '')) {
      problems.push(
        `stale licence exception: ${exception.package}@${exception.version} is not in ${lock.name ?? 'this lockfile'}'s production tree`,
      );
    }
  }
  return {problems, notes, checked};
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const TAG = /<(script|link)\b([^>]*)>/gi;
const ATTR = /\b(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const JS_IMPORT =
  /\b(?:importScripts|import)\s*\(\s*(['"`])((?:[a-z][a-z0-9+.-]*:)?\/\/[^'"`]+)\1|\bfrom\s*(['"])((?:[a-z][a-z0-9+.-]*:)?\/\/[^'"]+)\3/gi;

const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_REF =
  /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1|\burl\(\s*(['"]?)([^'")\s]+)\3\s*\)/gi;

/** Other-origin URLs a stylesheet pulls in at run time: `@import` and `url()` (fonts, images, other sheets). */
export function externalCssReferences(css: string): string[] {
  return [...css.matchAll(CSS_REF)]
    .map(match => match[2] ?? match[4] ?? '')
    .filter(url => EXTERNAL.test(url));
}

/**
 * External (other-origin) `<script src>` / `<link href>` in an HTML file, and `@import` / `url()` in its inline
 * `<style>` blocks; returns the offending references.
 */
export function externalHtmlReferences(html: string): {
  external: string[];
  scripts: number;
} {
  const external: string[] = [];
  let scripts = 0;
  for (const tag of html.matchAll(TAG)) {
    const [, name = '', attrs = ''] = tag;
    if (name.toLowerCase() === 'script') {
      scripts++;
    }
    for (const attr of attrs.matchAll(ATTR)) {
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (EXTERNAL.test(value.trim())) {
        external.push(`<${name.toLowerCase()} ${String(attr[1])}="${value}">`);
      }
    }
  }
  for (const style of html.matchAll(STYLE)) {
    external.push(
      ...externalCssReferences(style[1] ?? '').map(url => `<style> ${url}`),
    );
  }
  return {external, scripts};
}

/** Scripts a built JS file would load from another origin at run time: import(), importScripts(), `from "https://…"`. */
export function externalJsImports(js: string): string[] {
  return [...js.matchAll(JS_IMPORT)].map(match => match[2] ?? match[4] ?? '');
}
