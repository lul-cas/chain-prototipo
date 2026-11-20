import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchesPattern } from './rules';

interface PatternCase {
  readonly pattern: string;
  readonly value: string;
  readonly valid: boolean;
}

// The same file the C# validator runs (Chain.Forms.Tests/PatternTests), so browser and server agree (forms.md F1, "Patterns").
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../specs/testing/form-vectors/patterns.json'), 'utf8')) as {
  readonly cases: readonly PatternCase[];
};

describe('Modeler patterns, against the vectors shared with the server', () => {
  it('has cases', () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  it.each(vectors.cases.map((c) => [c.pattern, c.value, c.valid] as const))('%j on %j is valid: %s', (pattern, value, valid) => {
    expect(matchesPattern(pattern, value)).toBe(valid);
  });
});
