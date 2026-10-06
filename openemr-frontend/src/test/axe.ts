import axe from 'axe-core';

// axe-core in jsdom for component tests: WCAG 2.x A/AA rules, serious and critical findings only, as the
// Playwright spec does. jsdom has no layout, so colour contrast is checked on the tokens instead
// (src/theme/tokens.test.ts) and in the browser (tests/e2e/a11y.spec.ts).
// reference: REQUIREMENTS.md NFR-A11Y-1

const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
];

/** The ids of every serious or critical axe violation under `node`, with the offending selectors. */
export async function blockingAxeViolations(node: Element): Promise<string[]> {
  const results = await axe.run(node, {
    runOnly: {type: 'tag', values: WCAG_TAGS},
    rules: {'color-contrast': {enabled: false}},
  });
  return results.violations
    .filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
}
