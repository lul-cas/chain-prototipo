import axe from 'axe-core';

/**
 * Runs axe-core's WCAG rules on a rendered fragment and fails with the rule ids and targets.
 * Color contrast is disabled here because jsdom does not compute styles; contrast is enforced
 * on the tokens instead (src/styles/tokens/contrast.spec.ts) and checked visually on /_design.
 */
export async function expectNoAxeViolations(context: Element | Document = document.body): Promise<void> {
  const results = await axe.run(context, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: {
      'color-contrast': { enabled: false },
      // Fragments are tested in isolation, outside the page landmarks of the app shell.
      region: { enabled: false },
      'page-has-heading-one': { enabled: false },
      'landmark-one-main': { enabled: false },
    },
  });
  const violations = results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`,
  );
  expect(violations).toEqual([]);
}
