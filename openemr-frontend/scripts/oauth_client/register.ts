// CLI for registration.ts: npm run oauth:register -- --env <name> --secret-out <path|-> (or --dry-run).
// reference: DEPLOYMENT.md;

import {existsSync} from 'node:fs';
import {rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import clients from '../../config/oauth-clients.json' with {type: 'json'};
import scopes from '../../config/oauth-scopes.json' with {type: 'json'};
import {run} from './registration.ts';

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(path.join(dir, '.git'))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`no git repository above ${start}`);
    }
    dir = parent;
  }
  return dir;
}

process.exitCode = await run(process.argv.slice(2), {
  fetch: globalThis.fetch,
  secretFile: {
    // wx: never overwrite an existing file; 0600: owner-only where the filesystem honours it.
    reserve: target => writeFile(target, '', {flag: 'wx', mode: 0o600}),
    write: (target, secret) => writeFile(target, `${secret}\n`, {mode: 0o600}),
    discard: target => rm(target, {force: true}),
  },
  out: line => {
    process.stdout.write(`${line}\n`);
  },
  err: line => {
    process.stderr.write(`${line}\n`);
  },
  clients,
  approvedScopes: scopes.scopes,
  repoRoot: findRepoRoot(path.dirname(fileURLToPath(import.meta.url))),
  cwd: process.cwd(),
});
