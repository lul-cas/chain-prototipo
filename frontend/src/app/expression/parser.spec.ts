import { MAX_COMPARISONS, MAX_GROUP_DEPTH, MAX_NODES, MAX_VALUE_DEPTH, parseCondition, parseValue } from './parser';

/** The parser rejects anything outside expression-language.md §5.1, as the C# parser does. */
const n = (value: string) => ({ kind: 'literal', type: 'number', value });
const compare = { kind: 'compare', left: n('1'), operator: 'equals', right: n('1') };

const error = (result: ReturnType<typeof parseValue> | ReturnType<typeof parseCondition>) => (result.ok ? null : result.error);

describe('parser', () => {
  it.each([
    [{ kind: 'path', path: ['valor'], extra: true }, "Unknown property 'extra'."],
    [{ kind: 'path', path: [] }, 'Invalid path.'],
    [{ kind: 'path', path: ['[]', 'x'] }, 'Invalid path.'],
    [{ kind: 'path', path: ['a'.repeat(65)] }, 'Invalid path.'],
    [{ kind: 'path', path: Array.from({ length: 11 }, () => 'a') }, 'Invalid path.'],
    [{ kind: 'path', path: [1] }, 'Path segments are text.'],
    [{ kind: 'literal', type: 'number', value: '1e3' }, 'Invalid number literal.'],
    [{ kind: 'literal', type: 'number', value: '\u0661' }, 'Invalid number literal.'],
    [{ kind: 'literal', type: 'number', value: '12\0' }, 'Invalid number literal.'], // .NET's parser ignores a trailing NUL (#126)
    [{ kind: 'literal', type: 'date', value: '2025-02-29' }, 'Invalid date literal.'],
    [{ kind: 'literal', type: 'time', value: '9:00' }, 'Invalid time literal.'],
    [{ kind: 'literal', type: 'datetime', value: '2026-10-15T13:00:00' }, 'Invalid datetime literal.'],
    [{ kind: 'literal', type: 'boolean', value: 'yes' }, 'Invalid boolean literal.'],
    [{ kind: 'literal', type: 'money', value: '1' }, "Unknown literal type 'money'."],
    [{ kind: 'literal', type: 'number', value: 1 }, "'value' must be text."],
    [{ kind: 'system', name: 'today' }, "Unknown system value 'today'."],
    [{ kind: 'call', function: 'eval', args: [] }, "Unknown function 'eval'."],
    [{ kind: 'call', function: 'abs', args: [] }, "'abs' takes 1–1 arguments."],
    [{ kind: 'arithmetic', op: 'power', left: n('1'), right: n('2') }, "Unknown arithmetic op 'power'."],
    [{ kind: 'arithmetic', op: 'add', left: n('1') }, 'A required property is missing.'],
    [{ ...n('1'), offset: { amount: 1, unit: 'days' } }, 'Only date and datetime values can carry an offset.'],
    [{ kind: 'system', name: 'currentDate', offset: { amount: 1, unit: 'hours' } }, "Unknown offset unit 'hours'."],
    [{ kind: 'system', name: 'currentDateTime', offset: { amount: 10001, unit: 'hours' } }, 'An offset amount is an integer up to 10000.'],
    [{ kind: 'system', name: 'currentDateTime', offset: { amount: 1.5, unit: 'hours' } }, 'An offset amount is an integer up to 10000.'],
    [{ kind: 'system', name: 'currentDateTime', offset: [] }, 'An offset is an object.'],
    [[], 'A node is an object.'],
    [{ kind: 'script', code: 'alert(1)' }, 'Unknown value kind.'],
  ])('rejects %j', (tree, message) => {
    expect(error(parseValue(tree))).toBe(message);
  });

  it('accepts offsets by the kind of the value', () => {
    expect(error(parseValue({ kind: 'path', path: ['quando'], offset: { amount: -2, unit: 'hours' } }))).toBeNull();
    expect(error(parseValue({ kind: 'literal', type: 'date', value: '2026-10-15', offset: { amount: 1, unit: 'months' } }))).toBeNull();
    expect(error(parseValue({ kind: 'call', function: 'datetime', args: [{ kind: 'literal', type: 'text', value: 'x' }], offset: { amount: 1, unit: 'minutes' } }))).toBeNull();
  });

  it.each([
    ['a unary operator with a right operand', { kind: 'compare', left: n('1'), operator: 'isEmpty', right: n('1') }],
    ['a binary operator without one', { kind: 'compare', left: n('1'), operator: 'equals' }],
    ['an unknown operator', { kind: 'compare', left: n('1'), operator: 'like', right: n('1') }],
    ['a group with another op', { kind: 'group', op: 'xor', items: [] }],
    ['a value where a condition belongs', n('1')],
  ])('rejects %s', (_name, tree) => {
    expect(parseCondition(tree).ok).toBe(false);
  });

  it('accepts groups nested to the limit and no deeper', () => {
    const nest = (depth: number): unknown => (depth === 0 ? compare : { kind: 'group', op: 'and', items: [nest(depth - 1)] });
    expect(parseCondition(nest(MAX_GROUP_DEPTH)).ok).toBe(true);
    expect(error(parseCondition(nest(MAX_GROUP_DEPTH + 1)))).toBe(`Groups nest at most ${MAX_GROUP_DEPTH} levels.`);
  });

  it('accepts values nested to the limit and no deeper', () => {
    const nest = (depth: number): unknown => (depth === 1 ? n('1') : { kind: 'call', function: 'abs', args: [nest(depth - 1)] });
    expect(parseValue(nest(MAX_VALUE_DEPTH)).ok).toBe(true);
    expect(error(parseValue(nest(MAX_VALUE_DEPTH + 1)))).toBe(`Values nest at most ${MAX_VALUE_DEPTH} levels.`);
  });

  it('limits the comparisons and the nodes of one expression', () => {
    const group = (count: number) => ({ kind: 'group', op: 'or', items: Array.from({ length: count }, () => compare) });
    expect(parseCondition(group(MAX_COMPARISONS)).ok).toBe(true);
    expect(error(parseCondition(group(MAX_COMPARISONS + 1)))).toBe(`At most ${MAX_COMPARISONS} comparisons per expression.`);

    const wide = { kind: 'call', function: 'max', args: Array.from({ length: 50 }, () => ({ kind: 'call', function: 'abs', args: [{ kind: 'call', function: 'abs', args: [{ kind: 'call', function: 'abs', args: [n('1')] }] }] })) };
    expect(error(parseValue(wide))).toBe(`Expressions are limited to ${MAX_NODES} nodes.`);
  });
});
