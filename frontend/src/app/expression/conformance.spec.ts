import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExpressionError } from './errors';
import { evaluateCondition, evaluateValue, EvaluationContext } from './evaluator';
import { parseCondition, parseValue } from './parser';
import { parseDateTime } from './temporal';
import { canonical } from './values';

/**
 * Runs every shared conformance vector (expression-language.md §7, ADR-0010 D5): the C# interpreter runs the same files, so
 * a divergence fails the build. A missing directory or an empty file fails too; nothing is skipped silently.
 */
interface VectorCase {
  readonly name: string;
  readonly now?: string;
  readonly condition?: unknown;
  readonly value?: unknown;
  readonly expect: { readonly result?: boolean; readonly type?: string; readonly value?: string; readonly error?: string };
}

interface VectorFile {
  readonly now: string;
  readonly zone: string;
  readonly data: unknown;
  readonly cases: readonly VectorCase[];
}

const DIRECTORY = resolve(process.cwd(), '../specs/testing/expression-vectors');
const FILES = readdirSync(DIRECTORY).filter((name) => name.endsWith('.json')).sort();
const load = (name: string): VectorFile => JSON.parse(readFileSync(resolve(DIRECTORY, name), 'utf8')) as VectorFile;

function zoneMinutes(zone: string): number {
  const match = /^([+-])?([0-9]{2}):([0-9]{2})$/.exec(zone);
  if (!match) {
    throw new Error(`Invalid zone '${zone}' in the vectors.`);
  }
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

function run(file: VectorFile, testCase: VectorCase): unknown {
  const now = parseDateTime(testCase.now ?? file.now);
  if (!now) {
    throw new Error(`Invalid now in '${testCase.name}'.`);
  }
  const context: EvaluationContext = { data: file.data, now, zone: zoneMinutes(file.zone) };
  if (testCase.condition !== undefined) {
    const parsed = parseCondition(testCase.condition);
    if (!parsed.ok) {
      throw new Error(`The condition does not parse: ${parsed.error}`);
    }
    return evaluateCondition(parsed.node, context);
  }
  const parsed = parseValue(testCase.value);
  if (!parsed.ok) {
    throw new Error(`The value does not parse: ${parsed.error}`);
  }
  return evaluateValue(parsed.node, context);
}

describe('expression conformance vectors', () => {
  it('finds the shared vector files, each with cases', () => {
    expect(FILES.length).toBeGreaterThan(0);
    for (const name of FILES) {
      expect(load(name).cases.length, name).toBeGreaterThan(0);
    }
  });

  for (const name of FILES) {
    const file = load(name);
    describe(name, () => {
      for (const testCase of file.cases) {
        it(testCase.name, () => {
          const { expect: expected } = testCase;
          if (expected.error !== undefined) {
            let error: unknown;
            try {
              run(file, testCase);
            } catch (e) {
              error = e;
            }
            expect(error).toBeInstanceOf(ExpressionError);
            expect((error as ExpressionError).code).toBe(expected.error);
          } else if (expected.result !== undefined) {
            expect(run(file, testCase)).toBe(expected.result);
          } else {
            const value = run(file, testCase) as Parameters<typeof canonical>[0];
            expect(value.kind).toBe(expected.type);
            expect(canonical(value)).toBe(expected.value);
          }
        });
      }
    });
  }
});
