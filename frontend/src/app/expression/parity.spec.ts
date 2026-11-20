import { ExpressionError } from './errors';
import { EvaluationContext, evaluateCondition, evaluateValue } from './evaluator';
import { parseCondition, parseValue } from './parser';
import { parseDateTime } from './temporal';
import { canonical } from './values';

/**
 * Behavior outside the shared vectors where a TypeScript port could drift from C#. Every expected value below was produced by
 * the C# interpreter (Chain.Expressions, .NET 10.0.302) on 2026-10-16, with the same data, now and zone.
 */
const context: EvaluationContext = {
  data: { itens: [{ x: 1 }, {}], fim: '2026-01-31T23:00:00-03:00' },
  now: parseDateTime('2026-10-15T12:00:00Z')!,
  zone: -180,
};

const n = (value: string) => ({ kind: 'literal', type: 'number', value });
const t = (value: string) => ({ kind: 'literal', type: 'text', value });
const ar = (op: string, left: unknown, right: unknown) => ({ kind: 'arithmetic', op, left, right });
const call = (fn: string, ...args: unknown[]) => ({ kind: 'call', function: fn, args });
const projection = { kind: 'path', path: ['itens', '[]', 'x'] };

function value(tree: unknown): string {
  const parsed = parseValue(tree);
  if (!parsed.ok) {
    return `parse: ${parsed.error}`;
  }
  try {
    const result = evaluateValue(parsed.node, context);
    return `${result.kind} ${canonical(result)}`;
  } catch (error) {
    if (error instanceof ExpressionError) {
      return `error ${error.code}`;
    }
    throw error;
  }
}

describe('parity with the C# interpreter', () => {
  it.each([
    ['division keeps up to 29 significant digits', ar('divide', n('10'), n('3')), 'number 3.3333333333333333333333333333'],
    ['and fewer decimals when the integer part grows', ar('divide', n('100'), n('3')), 'number 33.333333333333333333333333333'],
    ['and rounds the last digit', ar('divide', n('2'), n('3')), 'number 0.6666666666666666666666666667'],
    ['division rounds half to even', ar('divide', n('3'), n('20000000000000000000000000000')), 'number 0.0000000000000000000000000002'],
    ['multiplication rounds half to even', ar('multiply', n('0.0000000000000000000000000025'), n('0.5')), 'number 0.0000000000000000000000000012'],
    ['addition overflows past the decimal range', ar('add', n('79228162514264337593543950335'), n('1')), 'error overflow'],
    ['multiplication overflows', ar('multiply', n('79228162514264337593543950335'), n('10')), 'error overflow'],
    ['subtraction overflows below the range', ar('subtract', n('-79228162514264337593543950335'), n('1')), 'error overflow'],
    ['round goes half away from zero', call('round', n('-2.5')), 'number -3'],
    ['round to places', call('round', n('2.345'), n('2')), 'number 2.35'],
    ['round never gives negative zero', call('round', n('-0.4')), 'number 0'],
    ['ceil never gives negative zero', call('ceil', n('-0.5')), 'number 0'],
    ['max of numbers', call('max', n('3'), n('7.5'), n('-1')), 'number 7.5'],
    ['month steps keep the clock of a datetime with an offset', { kind: 'literal', type: 'datetime', value: '2026-01-31T23:00:00-03:00', offset: { amount: 1, unit: 'months' } }, 'datetime 2026-03-01T02:00:00Z'],
    ['including stored text', { kind: 'path', path: ['fim'], offset: { amount: 1, unit: 'months' } }, 'datetime 2026-03-01T02:00:00Z'],
    ['month steps clamp on the clock, not in UTC', { kind: 'literal', type: 'datetime', value: '2026-01-30T23:00:00-03:00', offset: { amount: 1, unit: 'months' } }, 'datetime 2026-03-01T02:00:00Z'],
    ['a year from 29 February clamps on the clock', { kind: 'literal', type: 'datetime', value: '2024-02-29T12:00:00+05:00', offset: { amount: 1, unit: 'years' } }, 'datetime 2025-02-28T07:00:00Z'],
    ['the zone moves the first instant before year 1', call('date', t('0001-01-01T00:00:00Z')), 'error overflow'],
    ['dates stop at year 1', { kind: 'system', name: 'currentDate', offset: { amount: -10000, unit: 'years' } }, 'error overflow'],
    ['number() takes leading zeros', call('number', t('00012.50')), 'number 12.5'],
    ['number() takes a leading point', call('number', t('.5')), 'number 0.5'],
    ['number() takes a trailing point', call('number', t('5.')), 'number 5'],
    ['number() rejects spaces', call('number', t(' 5')), 'error invalid_number'],
    ['time() of an instant keeps its fraction but shows seconds', call('time', call('datetime', t('2026-10-15T13:00:00.5Z'))), 'time 10:00:00'],
    ['string() of a time has seconds', call('string', call('time', t('23:59'))), 'text 23:59:00'],
    ['count() counts projected rows without the field', call('count', projection), 'number 2'],
    ['sum() skips them', call('sum', projection), 'number 1'],
    ['string() drops trailing zeros', call('string', n('1.10')), 'text 1.1'],
    ['string() of negative zero', call('string', n('-0.0')), 'text 0'],
    ['datetime(date, time) reads the clock of the zone', call('datetime', t('2026-10-15'), t('23:30')), 'datetime 2026-10-16T02:30:00Z'],
    ['near year 1 it still fits', call('datetime', t('0001-01-01'), t('01:00')), 'datetime 0001-01-01T04:00:00Z'],
    ['avg takes one list', call('avg', n('1'), n('2'), n('2')), "parse: 'avg' takes 1–1 arguments."],
  ])('%s', (_name, tree, expected) => {
    expect(value(tree)).toBe(expected);
  });

  it.each([
    ['0.1 + 0.2 equals 0.3 in decimal', { kind: 'compare', left: ar('add', n('0.1'), n('0.2')), operator: 'equals', right: n('0.3') }, true],
    [
      'a time with a fraction differs from the whole second',
      { kind: 'compare', left: call('time', call('datetime', t('2026-10-15T13:00:00.5Z'))), operator: 'equals', right: { kind: 'literal', type: 'time', value: '10:00:00' } },
      false,
    ],
    [
      'and stops before an error in a later item',
      {
        kind: 'group',
        op: 'and',
        items: [
          { kind: 'compare', left: n('1'), operator: 'equals', right: n('2') },
          { kind: 'compare', left: ar('divide', n('1'), n('0')), operator: 'equals', right: n('1') },
        ],
      },
      false,
    ],
    ['contains skips projected rows without the field', { kind: 'compare', left: projection, operator: 'contains', right: n('1') }, true],
    ['and still skips them when nothing matches', { kind: 'compare', left: projection, operator: 'contains', right: n('5') }, false],
  ])('%s', (_name, tree, expected) => {
    const parsed = parseCondition(tree);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && evaluateCondition(parsed.node, context)).toBe(expected);
  });
});
