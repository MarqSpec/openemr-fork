// CLI for policy.ts (NFR-SEC-8), run the same locally and in CI (frontend:deps, frontend:test):
//   node scripts/deps/check.ts audit <package-dir>...     npm audit (lockfile only) against config/audit-allowlist.json
//   node scripts/deps/check.ts licences <package-dir>...  production licences against config/licence-allowlist.json
//   node scripts/deps/check.ts no-cdn <dist-dir>          no script or stylesheet from another origin in the build
// reference: DEPLOYMENT.md (frontend:deps)

import {spawnSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  advisoriesFromReport,
  evaluateAudit,
  evaluateLicences,
  externalCssReferences,
  externalHtmlReferences,
  externalJsImports,
  type AuditAllowlist,
  type CheckResult,
  type LicencePolicy,
  type Lockfile,
} from './policy.ts';

const CONFIG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../config',
);

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function readLock(dir: string): Lockfile {
  return readJson(path.join(dir, 'package-lock.json')) as Lockfile;
}

function report(title: string, result: CheckResult): boolean {
  process.stdout.write(`${title}\n`);
  for (const note of result.notes) {
    process.stdout.write(`  info  ${note}\n`);
  }
  for (const problem of result.problems) {
    process.stdout.write(`  FAIL  ${problem}\n`);
  }
  return result.problems.length === 0;
}

function audit(dirs: string[]): boolean {
  const list = readJson(
    path.join(CONFIG, 'audit-allowlist.json'),
  ) as AuditAllowlist;
  const today = new Date().toISOString().slice(0, 10);
  let pass = true;
  for (const dir of dirs) {
    const lock = readLock(dir);
    // --package-lock-only: reads the committed lockfile, so no install is needed. npm exits 1 when it finds any
    // advisory; the verdict is ours, so its status is ignored and its JSON must parse.
    // One constant command string (no arguments to escape) so the shell also finds npm.cmd on Windows.
    const run = spawnSync('npm audit --package-lock-only --json', {
      cwd: dir,
      encoding: 'utf8',
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    let result: CheckResult;
    try {
      result = evaluateAudit(
        advisoriesFromReport(JSON.parse(run.stdout) as unknown),
        list,
        lock,
        today,
      );
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      result = {problems: [`${why} ${run.stderr.trim()}`.trim()], notes: []};
    }
    pass =
      report(`npm audit (high+) — ${lock.name ?? dir} (${dir})`, result) &&
      pass;
  }
  return pass;
}

function licences(dirs: string[]): boolean {
  const policy = readJson(
    path.join(CONFIG, 'licence-allowlist.json'),
  ) as LicencePolicy;
  let pass = true;
  for (const dir of dirs) {
    const lock = readLock(dir);
    const result = evaluateLicences(lock, policy);
    if (result.checked === 0) {
      result.problems.push('no production packages found — nothing checked');
    }
    pass =
      report(
        `licences — ${lock.name ?? dir}: ${String(result.checked)} production packages`,
        result,
      ) && pass;
  }
  return pass;
}

function noCdn(dist: string): boolean {
  const problems: string[] = [];
  let pages = 0;
  let scripts = 0;
  for (const entry of readdirSync(dist, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) {
      continue;
    }
    const file = path.join(entry.parentPath, entry.name);
    const shown = path.relative(dist, file);
    if (/\.html?$/i.test(entry.name)) {
      pages++;
      const found = externalHtmlReferences(readFileSync(file, 'utf8'));
      scripts += found.scripts;
      problems.push(...found.external.map(ref => `${shown}: ${ref}`));
    } else if (/\.css$/i.test(entry.name)) {
      problems.push(
        ...externalCssReferences(readFileSync(file, 'utf8')).map(
          url => `${shown}: pulls ${url}`,
        ),
      );
    } else if (/\.m?js$/i.test(entry.name)) {
      problems.push(
        ...externalJsImports(readFileSync(file, 'utf8')).map(
          url => `${shown}: loads ${url}`,
        ),
      );
    }
  }
  // A check that read no page, or a page with no script, checked nothing: the build is not where it was expected.
  if (pages === 0 || scripts === 0) {
    problems.push(
      `found ${String(pages)} HTML page(s) and ${String(scripts)} <script> tag(s) under ${dist} — run the build first`,
    );
  }
  return report(
    `no runtime CDN — ${dist}: ${String(pages)} HTML page(s), ${String(scripts)} <script> tag(s)`,
    {problems, notes: []},
  );
}

const [command, ...targets] = process.argv.slice(2);
const checks: Record<string, (targets: string[]) => boolean> = {
  audit,
  licences,
  'no-cdn': ([dist]) => noCdn(dist ?? 'dist'),
};
const check = command === undefined ? undefined : checks[command];
if (check === undefined || (command !== 'no-cdn' && targets.length === 0)) {
  process.stderr.write(
    'usage: check.ts audit|licences <package-dir>... | no-cdn <dist-dir>\n',
  );
  process.exitCode = 2;
} else {
  process.exitCode = check(targets) ? 0 : 1;
}
