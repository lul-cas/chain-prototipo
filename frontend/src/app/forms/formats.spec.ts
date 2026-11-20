import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidFormat } from './formats';

interface FormatCase {
  readonly format: string;
  readonly value: string;
  readonly valid: boolean;
}

// The same file the C# validator runs (Chain.Forms.Tests/FormatVectorTests), so browser and server agree (forms.md F3).
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../specs/testing/form-vectors/formats.json'), 'utf8')) as {
  readonly cases: readonly FormatCase[];
};

describe('built-in formats, against the vectors shared with the server', () => {
  it.each(vectors.cases.map((c) => [c.format, c.value, c.valid] as const))('%s %j is valid: %s', (format, value, valid) => {
    expect(isValidFormat(format, value)).toBe(valid);
  });

  it('knows no other format', () => {
    expect(isValidFormat('iban', 'BR15 0000 0000 0000 1093 2840 814 P2')).toBe(false);
  });
});
