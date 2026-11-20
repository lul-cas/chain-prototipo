import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { firstRefused } from './pattern-subset';

interface SubsetCase {
  readonly pattern: string;
  readonly allowed: boolean;
  readonly construct?: string;
  readonly replacement?: string;
}

// The same file the C# validator runs (Chain.Forms.Tests/PatternSubsetTests), so the designer flags what FM005 refuses (card #149).
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../specs/testing/form-vectors/pattern-subset.json'), 'utf8')) as {
  readonly cases: readonly SubsetCase[];
};

describe('the pattern allowlist (forms.md F1, FM005), against the vectors shared with the server', () => {
  it('has cases of both kinds', () => {
    expect(vectors.cases.some((c) => c.allowed)).toBe(true);
    expect(vectors.cases.some((c) => !c.allowed)).toBe(true);
  });

  it.each(vectors.cases.map((c) => [c.pattern, c] as const))('%j', (pattern, c) => {
    expect(firstRefused(pattern)).toEqual(c.allowed ? null : { construct: c.construct, replacement: c.replacement ?? null });
  });
});
