// @vitest-environment node
import {fileURLToPath} from 'node:url';

import {ESLint, Linter} from 'eslint';
import {beforeAll, describe, expect, it} from 'vitest';

// reference: CONVENTIONS.md (Stack standards: Typography colour)
// Resolves the repo's own eslint.config.mjs for a component file, then lints fixture strings with the
// no-restricted-syntax rule it resolved (no type-aware parse, so the test stays fast).

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COMPONENT = 'src/features/cards/DashboardCard.tsx';
const RULE = 'no-restricted-syntax';

const eslint = new ESLint({cwd: ROOT});
const linter = new Linter();

async function colourErrors(jsx: string) {
  const resolved = (await eslint.calculateConfigForFile(COMPONENT)) as {
    rules?: Linter.RulesRecord;
  };
  const rule = resolved.rules?.[RULE];
  if (rule === undefined) return [];
  const messages = linter.verify(
    `const x = ${jsx};`,
    {
      languageOptions: {
        sourceType: 'module',
        parserOptions: {ecmaFeatures: {jsx: true}},
      },
      rules: {[RULE]: rule},
    },
    'fixture.js',
  );
  // A fixture that did not parse, or matched no config, lints clean: fail loudly instead.
  const broken = messages.find(m => m.ruleId === null);
  if (broken !== undefined) throw new Error(broken.message);
  return messages.filter(
    m => m.ruleId === RULE && m.message.includes('Typography'),
  );
}

describe('given the Typography colour lint rule', () => {
  // Loading the config (gts, typescript-eslint) is slow once; every lint after it is fast.
  beforeAll(async () => {
    await eslint.calculateConfigForFile(COMPONENT);
  }, 120_000);

  it.each([
    '<Typography color="text.secondary">x</Typography>',
    "<Typography color={'text.secondary'}>x</Typography>",
    '<Typography color={`text.secondary`}>x</Typography>',
    '<Typography variant="body2" color="text.primary">x</Typography>',
    '<Typography color="error.main">x</Typography>',
    '<Typography color="#6c757d">x</Typography>',
    "<Typography color={ok ? 'textSecondary' : 'text.disabled'}>x</Typography>",
    '<Typography color="secondary">x</Typography>',
  ])('when `%s` is written, then lint rejects it', async jsx => {
    expect(await colourErrors(jsx)).not.toHaveLength(0);
  });

  it.each([
    '<Typography color="textSecondary">x</Typography>',
    '<Typography color="textPrimary">x</Typography>',
    '<Typography color="error">x</Typography>',
    '<Typography color="inherit">x</Typography>',
    "<Typography color={ok ? 'success' : 'error'}>x</Typography>",
    "<Typography sx={{color: 'text.secondary'}}>x</Typography>",
    '<Typography>x</Typography>',
    '<Button color="inherit">x</Button>',
  ])('when `%s` is written, then lint allows it', async jsx => {
    expect(await colourErrors(jsx)).toHaveLength(0);
  });
});
