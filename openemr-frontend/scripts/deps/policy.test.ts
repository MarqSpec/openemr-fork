import {describe, expect, it} from 'vitest';

import auditAllowlist from '../../config/audit-allowlist.json' with {type: 'json'};
import licencePolicy from '../../config/licence-allowlist.json' with {type: 'json'};
import {
  advisoriesFromReport,
  allowlistProblems,
  evaluateAudit,
  evaluateLicences,
  externalCssReferences,
  externalHtmlReferences,
  externalJsImports,
  licenceAllowed,
  MAX_REVIEW_DAYS,
  parseSpdx,
  type AuditAllowEntry,
  type AuditAllowlist,
  type Lockfile,
} from './policy.ts';

// reference: REQUIREMENTS.md NFR-SEC-8;

const GHSA_HIGH = 'GHSA-hmw2-7cc7-3qxx';
const GHSA_LOW = 'GHSA-52f5-9888-hmc6';

function report(nodes: string[] = ['node_modules/form-data']): unknown {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      'form-data': {
        name: 'form-data',
        severity: 'high',
        via: [
          {
            source: 1,
            name: 'form-data',
            title: 'CRLF injection',
            url: `https://github.com/advisories/${GHSA_HIGH}`,
            severity: 'high',
          },
        ],
        nodes,
      },
      tmp: {
        name: 'tmp',
        severity: 'low',
        via: [
          {
            source: 2,
            name: 'tmp',
            title: 'symlink dir',
            url: `https://github.com/advisories/${GHSA_LOW}`,
            severity: 'low',
          },
        ],
        nodes: ['node_modules/tmp'],
      },
      // A package that is vulnerable only through another: its `via` is a string and carries no advisory.
      '@usebruno/cli': {
        name: '@usebruno/cli',
        severity: 'high',
        via: ['form-data'],
        nodes: ['node_modules/@usebruno/cli'],
      },
    },
    metadata: {vulnerabilities: {high: 2, low: 1}},
  };
}

const LOCK: Lockfile = {
  name: 'openemr-frontend',
  lockfileVersion: 3,
  packages: {
    '': {version: '0.1.0', license: 'GPL-3.0'},
    'node_modules/form-data': {version: '4.0.4', license: 'MIT', dev: true},
    'node_modules/axios/node_modules/form-data': {
      version: '4.0.4',
      license: 'MIT',
    },
    'node_modules/react': {version: '19.3.0', license: 'MIT'},
    'node_modules/tmp': {version: '0.0.33', license: 'MIT', dev: true},
  },
};

function entry(overrides: Partial<AuditAllowEntry> = {}): AuditAllowEntry {
  return {
    id: GHSA_HIGH,
    package: 'form-data',
    in: ['openemr-frontend'],
    scope: 'dev',
    reason: 'dev-only, never shipped, reached only by our own collection',
    reviewed: '2026-09-28',
    expires: '2026-10-28',
    ...overrides,
  };
}

function list(...advisories: AuditAllowEntry[]): AuditAllowlist {
  return {advisories};
}

describe('advisoriesFromReport', () => {
  it('reads each advisory once, with the install paths of its package, and skips path-only entries', () => {
    const advisories = advisoriesFromReport(report());
    expect(advisories.map(a => `${a.package} ${a.id} ${a.severity}`)).toEqual([
      `form-data ${GHSA_HIGH} high`,
      `tmp ${GHSA_LOW} low`,
    ]);
    expect(advisories[0]?.nodes).toEqual(['node_modules/form-data']);
  });

  it('throws on an npm error or anything that is not a v2 report, so a failed audit is never green', () => {
    expect(() =>
      advisoriesFromReport({error: {code: 'ENOAUDIT', summary: 'offline'}}),
    ).toThrow(/offline/);
    expect(() => advisoriesFromReport({vulnerabilities: {}})).toThrow(
      /version 2/,
    );
    expect(() => advisoriesFromReport(null)).toThrow();
  });
});

describe('evaluateAudit', () => {
  const advisories = advisoriesFromReport(report());

  it('fails a high advisory that is not allow-listed, and never blocks on a low one', () => {
    const result = evaluateAudit(advisories, list(), LOCK, '2026-09-28');
    expect(result.problems).toEqual([
      expect.stringContaining(`not allow-listed: high ${GHSA_HIGH}`),
    ]);
    expect(result.notes.join('\n')).toContain(GHSA_LOW);
  });

  it('passes an allow-listed dev-only advisory until the day it expires, then fails', () => {
    expect(
      evaluateAudit(advisories, list(entry()), LOCK, '2026-10-28').problems,
    ).toEqual([]);
    expect(
      evaluateAudit(advisories, list(entry()), LOCK, '2026-10-29').problems,
    ).toEqual([expect.stringContaining('expired 2026-10-28')]);
  });

  it('only counts an entry for the package it names', () => {
    const other = entry({in: ['openemr-frontend-bff']});
    expect(
      evaluateAudit(advisories, list(other), LOCK, '2026-09-28').problems,
    ).toEqual([expect.stringContaining('not allow-listed')]);
  });

  it('refuses a dev-scoped entry once the advisory is reachable from a production dependency', () => {
    const shipped = advisoriesFromReport(
      report([
        'node_modules/form-data',
        'node_modules/axios/node_modules/form-data',
      ]),
    );
    expect(
      evaluateAudit(shipped, list(entry()), LOCK, '2026-09-28').problems,
    ).toEqual([
      expect.stringContaining(
        'reachable from production dependencies: high GHSA-hmw2-7cc7-3qxx',
      ),
    ]);
    expect(
      evaluateAudit(
        shipped,
        list(entry({scope: 'production'})),
        LOCK,
        '2026-09-28',
      ).problems,
    ).toEqual([]);
  });

  it('fails a stale entry the audit no longer reports', () => {
    const result = evaluateAudit([], list(entry()), LOCK, '2026-09-28');
    expect(result.problems).toEqual([
      expect.stringContaining(`stale allow-list entry: ${GHSA_HIGH}`),
    ]);
  });
});

describe('allowlistProblems', () => {
  const TODAY = '2026-09-28';

  it('requires a GHSA id, a reason, a package and dates in order', () => {
    expect(allowlistProblems(list(entry()), TODAY)).toEqual([]);
    const bad = allowlistProblems(
      list(
        entry({id: 'CVE-2026-1234'}),
        entry({reason: 'fine'}),
        entry({in: []}),
        entry({expires: '2026-09-28'}),
        entry({reviewed: 'yesterday'}),
      ),
      TODAY,
    );
    expect(bad).toEqual([
      expect.stringContaining('GHSA id'),
      expect.stringContaining('reason'),
      expect.stringContaining('names no package'),
      expect.stringContaining('after reviewed'),
      expect.stringContaining('YYYY-MM-DD'),
    ]);
  });

  it('refuses a review dated in the future and an expiry more than 90 days from today', () => {
    // review: a future-dated pair passed while only expires - reviewed was checked.
    expect(
      allowlistProblems(
        list(entry({reviewed: '2031-01-01', expires: '2031-03-31'})),
        TODAY,
      ),
    ).toEqual([
      expect.stringContaining('reviewed 2031-01-01 is after today'),
      expect.stringContaining('more than 90 days from today'),
    ]);
    expect(
      allowlistProblems(list(entry({expires: '2026-12-28'})), TODAY),
    ).toEqual([expect.stringContaining('more than 90 days from today')]);
    expect(
      allowlistProblems(list(entry({expires: '2026-12-27'})), TODAY),
    ).toEqual([]);
  });

  it('refuses an expiry more than 90 days after the review, however close it is today', () => {
    expect(
      allowlistProblems(
        list(entry({reviewed: '2026-06-01', expires: '2026-10-28'})),
        TODAY,
      ),
    ).toEqual([expect.stringContaining('more than 90 days after reviewed')]);
  });

  it('pins the 90-day cap in code, not in the file it limits', () => {
    expect(MAX_REVIEW_DAYS).toBe(90);
    expect(Object.keys(auditAllowlist)).not.toContain('maxDays');
  });

  it('holds for the committed allow-list on the day it was reviewed', () => {
    expect(allowlistProblems(auditAllowlist as AuditAllowlist, TODAY)).toEqual(
      [],
    );
  });
});

describe('licences', () => {
  const allowed = ['MIT', 'Apache-2.0', 'BSD-3-Clause'];

  it('parses SPDX expressions and applies OR (either side) and AND (both sides)', () => {
    expect(licenceAllowed('MIT', allowed)).toBe(true);
    expect(licenceAllowed('(MIT OR GPL-3.0)', allowed)).toBe(true);
    expect(licenceAllowed('MIT AND GPL-3.0', allowed)).toBe(false);
    expect(licenceAllowed('(MIT AND BSD-3-Clause) OR LGPL-2.1', allowed)).toBe(
      true,
    );
    expect(licenceAllowed('Apache-2.0 WITH LLVM-exception', allowed)).toBe(
      false,
    );
    expect(parseSpdx('MIT OR')).toBeNull();
    expect(parseSpdx('(MIT')).toBeNull();
    for (const odd of ['UNLICENSED', 'SEE LICENSE IN LICENSE', undefined, {}]) {
      expect(licenceAllowed(odd, allowed)).toBe(false);
    }
  });

  it('checks every non-dev lockfile package, skipping the project itself', () => {
    const lock: Lockfile = {
      ...LOCK,
      packages: {
        ...LOCK.packages,
        'node_modules/left-pad': {version: '1.0.0', license: 'WTFPL'},
        'node_modules/dev-only': {
          version: '1.0.0',
          license: 'GPL-3.0',
          dev: true,
        },
      },
    };
    const result = evaluateLicences(lock, {allowed, exceptions: []});
    expect(result.checked).toBe(3);
    expect(result.problems).toEqual([
      'licence not allowed: left-pad@1.0.0 — WTFPL',
    ]);
  });

  it('accepts an exact-version exception for the package it names, and fails one that no longer matches', () => {
    const lock: Lockfile = {
      ...LOCK,
      packages: {
        'node_modules/left-pad': {version: '1.0.0', license: 'WTFPL'},
      },
    };
    const exception = {
      package: 'left-pad',
      in: ['openemr-frontend'],
      version: '1.0.0',
      license: 'WTFPL',
      reason: 'reviewed',
    };
    expect(
      evaluateLicences(lock, {allowed, exceptions: [exception]}).problems,
    ).toEqual([]);
    expect(
      evaluateLicences(lock, {
        allowed,
        exceptions: [{...exception, version: '0.9.0'}],
      }).problems,
    ).toEqual([
      'licence not allowed: left-pad@1.0.0 — WTFPL',
      expect.stringContaining('stale licence exception: left-pad@0.9.0'),
    ]);
  });

  it('refuses a lockfile older than version 2 (no licence fields)', () => {
    expect(
      evaluateLicences({lockfileVersion: 1}, licencePolicy).problems,
    ).toEqual([expect.stringContaining('version 2 or 3')]);
  });
});

describe('no runtime CDN', () => {
  it('flags script and link tags pointing at another origin, not same-origin ones', () => {
    const html = `<!doctype html><html><head>
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel=stylesheet href=https://fonts.googleapis.com/css?family=Roboto>
      <script type="module" crossorigin src="/assets/index-abc.js"></script>
      <script src='//cdn.jsdelivr.net/npm/lib.js'></script>
      <a href="https://www.open-emr.org">not a script</a>
    </head></html>`;
    expect(externalHtmlReferences(html)).toEqual({
      external: [
        '<link href="https://fonts.googleapis.com/css?family=Roboto">',
        '<script src="//cdn.jsdelivr.net/npm/lib.js">',
      ],
      scripts: 2,
    });
  });

  it('flags a stylesheet, font or image a built CSS file or an inline <style> pulls from another origin', () => {
    const css = `@import url("https://fonts.googleapis.com/css?family=Roboto");
      @import '//cdn.example.test/reset.css';
      .a{background:url(https://images.example.test/bg.png)}
      .b{background:url('/assets/bg-abc.png')}
      .c{background:url(data:image/png;base64,AAAA)}`;
    expect(externalCssReferences(css)).toEqual([
      'https://fonts.googleapis.com/css?family=Roboto',
      '//cdn.example.test/reset.css',
      'https://images.example.test/bg.png',
    ]);
    const html = `<html><head><style>@import "https://cdn.example.test/x.css";</style>
      <script src="/assets/index.js"></script></head></html>`;
    expect(externalHtmlReferences(html).external).toEqual([
      '<style> https://cdn.example.test/x.css',
    ]);
  });

  it('flags a script a bundle or the service worker loads from another origin, not an ordinary URL string', () => {
    const js = `importScripts("https://storage.googleapis.com/workbox.js");
      const m = await import('https://esm.sh/react');
      import x from "//cdn.example.test/x.js";
      const docs = "https://mui.com/production-error/?code=";
      import("./assets/chunk-abc.js");`;
    expect(externalJsImports(js)).toEqual([
      'https://storage.googleapis.com/workbox.js',
      'https://esm.sh/react',
      '//cdn.example.test/x.js',
    ]);
  });
});
