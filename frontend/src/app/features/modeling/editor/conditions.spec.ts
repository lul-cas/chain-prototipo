import { parseCondition } from '../../../expression';
import { CatalogEntry, Group, Row, addAt, fromZoneLocal, operatorsFor, problemsOf, removeAt, render, toJson, toRows, toZoneLocal, updateAt, valueText } from './conditions';

const path = (...segments: string[]) => ({ kind: 'path', path: segments });
const literal = (type: string, value: string) => ({ kind: 'literal', type, value });
const compare = (left: unknown, operator: string, right?: unknown) => ({ kind: 'compare', left, operator, ...(right === undefined ? {} : { right }) });

/** expression-language.md §5's example. */
const EXAMPLE = {
  kind: 'group',
  op: 'and',
  items: [
    compare(path('DataVencimento'), 'greaterOrEqual', { kind: 'system', name: 'currentDate' }),
    compare(path('valor'), 'lessOrEqual', literal('number', '50000')),
  ],
};

const CATALOG: CatalogEntry[] = [
  { path: ['DataVencimento'], type: 'date', presence: 'definite', sources: ['start'] },
  { path: ['aprovado'], type: 'boolean', presence: 'optional', sources: ['task_1'] },
  { path: ['documentos'], type: 'list<text>', presence: 'optional', sources: ['task_1'] },
  { path: ['endereco'], type: 'object', presence: 'optional', sources: ['task_1'] },
  { path: ['limite'], type: 'number', presence: 'definite', sources: ['start'] },
  { path: ['nome'], type: 'text', presence: 'definite', sources: ['start'] },
  { path: ['valor'], type: 'number', presence: 'definite', sources: ['start'] },
];

describe('the condition builder model (workflow-editor.md §10.7, expression-language.md §3–§6)', () => {
  it('offers the operators valid for each type of left operand', () => {
    expect(operatorsFor('text')).toEqual(['equals', 'notEquals', 'contains', 'isEmpty', 'isNotEmpty']);
    expect(operatorsFor('number')).toEqual(['equals', 'notEquals', 'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual', 'isEmpty', 'isNotEmpty']);
    expect(operatorsFor('date')).toEqual(operatorsFor('number'));
    expect(operatorsFor('datetime')).toEqual(operatorsFor('number'));
    expect(operatorsFor('boolean')).toEqual(['equals', 'notEquals', 'isEmpty', 'isNotEmpty']);
    expect(operatorsFor('list<text>')).toEqual(['contains', 'isEmpty', 'isNotEmpty']);
    expect(operatorsFor('object')).toEqual([]);
    expect(operatorsFor('unknown')).toHaveLength(9);
  });

  it('reads a condition into rows, a single comparison as a group of one, and writes it back unchanged', () => {
    const rows = toRows(EXAMPLE);
    expect(rows).toEqual({
      kind: 'group',
      op: 'and',
      items: [
        { kind: 'compare', left: { kind: 'path', path: ['DataVencimento'] }, operator: 'greaterOrEqual', right: { kind: 'system', name: 'currentDate' } },
        { kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'lessOrEqual', right: { kind: 'literal', type: 'number', value: '50000' } },
      ],
    });
    expect(toJson(rows)).toEqual({ json: EXAMPLE });

    const single = compare(path('nome'), 'isEmpty');
    expect(toRows(single)).toEqual({ kind: 'group', op: 'and', items: [{ kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: 'isEmpty', right: null }] });
    expect(toJson(toRows(single))).toEqual({ json: { kind: 'group', op: 'and', items: [single] } });
    expect(toRows(null)).toEqual({ kind: 'group', op: 'and', items: [] });
  });

  // Card #201: the operator comes from the stored document, so a name every object inherits is an unknown operator.
  it.each(['constructor', 'toString', '__proto__'])('shows an arithmetic operator named %s as an unknown one', (op) => {
    const arithmetic = (name: string) => ({ kind: 'arithmetic', op: name, left: path('valor'), right: literal('number', '2') });

    expect(valueText(arithmetic(op))).toBe(valueText(arithmetic('power')));
    expect(valueText(arithmetic(op))).toContain(' ? ');
  });

  it('keeps what it cannot edit, as it is: functions, arithmetic, offsets it cannot edit and unknown nodes', () => {
    const call = { kind: 'call', function: 'sum', args: [path('itens', '[]', 'valor')] };
    const offset = { kind: 'literal', type: 'date', value: '2026-01-31', offset: { amount: 1, unit: 'months' } };
    const strange = { kind: 'mystery', anything: true };
    const tree = { kind: 'group', op: 'or', items: [compare(call, 'greaterThan', literal('number', '10')), compare(path('DataVencimento'), 'lessThan', offset), strange] };

    const rows = toRows(tree);
    expect(rows.items[0]).toMatchObject({ left: { kind: 'kept', json: call } });
    expect(rows.items[1]).toMatchObject({ right: { kind: 'kept', json: offset } });
    expect(rows.items[2]).toEqual({ kind: 'kept', json: strange });
    expect(toJson(rows)).toEqual({ json: tree });
  });

  // #247: a node it can't read is kept, and its text read it again without end.
  it('renders a comparison or group it cannot read as ?, instead of recursing', () => {
    const unknownOperator = { kind: 'compare', left: { kind: 'path', path: ['x'] }, operator: 'nope' };
    const badGroup = { kind: 'group', op: 'xor', items: [] };

    expect(render(toRows(unknownOperator))).toBe('?');
    expect(render(toRows({ kind: 'group', op: 'and', items: [unknownOperator, badGroup] }))).toBe('? E ?');
  });

  it('reads and writes an offset on a datum or a system value, by its sign, quantity and unit (§10.8)', () => {
    const tree = {
      kind: 'group',
      op: 'and',
      items: [
        compare({ ...path('DataEmissao'), offset: { amount: -1, unit: 'months' } }, 'lessOrEqual', { kind: 'system', name: 'currentDate', offset: { amount: 30, unit: 'days' } }),
        compare(path('DataVencimento'), 'greaterThan', { kind: 'system', name: 'currentDateTime', offset: { amount: 0, unit: 'hours' } }),
      ],
    };

    const rows = toRows(tree);
    expect(rows.items[0]).toEqual({
      kind: 'compare',
      left: { kind: 'path', path: ['DataEmissao'], offset: { sign: '-', amount: '1', unit: 'months' } },
      operator: 'lessOrEqual',
      right: { kind: 'system', name: 'currentDate', offset: { sign: '+', amount: '30', unit: 'days' } },
    });
    expect(toJson(rows)).toEqual({ json: tree });
    expect(render(rows)).toBe('data.DataEmissao − 1 mês ≤ currentDate + 30 dias E data.DataVencimento > currentDateTime + 0 horas');

    for (const bad of [{ amount: 1.5, unit: 'days' }, { amount: 10_001, unit: 'days' }, { amount: '3', unit: 'days' }, { amount: 3, unit: 'weeks' }, { amount: 3, unit: 'days', extra: 1 }, 'soon']) {
      const right = { kind: 'system', name: 'currentDate', offset: bad };
      expect(toRows(compare(path('DataVencimento'), 'lessThan', right)).items[0]).toMatchObject({ right: { kind: 'kept', json: right } });
    }
  });

  it('asks for the quantity of an offset, and refuses one that is not a whole number up to 10 000', () => {
    const rows = (amount: string): Group => ({
      kind: 'group',
      op: 'and',
      items: [{ kind: 'compare', left: { kind: 'path', path: ['DataVencimento'] }, operator: 'lessThan', right: { kind: 'system', name: 'currentDate', offset: { sign: '-', amount, unit: 'days' } } }],
    });
    expect(problemsOf(rows(''), CATALOG).get('0')).toEqual({ error: 'Informe a quantidade do ajuste.' });
    for (const amount of ['1,5', '1e3', '-3', '10001', '٣']) {
      expect(problemsOf(rows(amount), CATALOG).get('0')).toEqual({ error: 'Quantidade inválida: um número inteiro de 0 a 10.000.' });
      expect(toJson(rows(amount))).toEqual({ incomplete: true });
    }
    expect(problemsOf(rows('10000'), CATALOG).get('0')).toBeUndefined();
    expect(toJson(rows('007'))).toEqual({ json: { kind: 'group', op: 'and', items: [compare(path('DataVencimento'), 'lessThan', { kind: 'system', name: 'currentDate', offset: { amount: -7, unit: 'days' } })] } });

    const left: Group = {
      kind: 'group',
      op: 'and',
      items: [{ kind: 'compare', left: { kind: 'path', path: ['DataVencimento'], offset: { sign: '+', amount: '', unit: 'days' } }, operator: 'isEmpty', right: null }],
    };
    expect(problemsOf(left, CATALOG).get('0')).toEqual({ error: 'Informe a quantidade do ajuste.' });
  });

  it('writes nothing while a row is incomplete or a number is invalid, and drops the right operand of a unary operator', () => {
    const rows = (items: Row[]): Group => ({ kind: 'group', op: 'and', items });
    expect(toJson(rows([{ kind: 'compare', left: null, operator: 'equals', right: null }]))).toEqual({ incomplete: true });
    expect(toJson(rows([{ kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: null, right: null }]))).toEqual({ incomplete: true });
    expect(toJson(rows([{ kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: 'equals', right: null }]))).toEqual({ incomplete: true });
    expect(toJson(rows([{ kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'equals', right: { kind: 'literal', type: 'number', value: '12,5' } }]))).toEqual({ incomplete: true });

    const unary = toJson(rows([{ kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: 'isEmpty', right: { kind: 'literal', type: 'text', value: 'x' } }]));
    expect(unary).toEqual({ json: { kind: 'group', op: 'and', items: [compare(path('nome'), 'isEmpty')] } });
  });

  it('writes conditions the expression parser accepts', () => {
    const rows: Group = {
      kind: 'group',
      op: 'and',
      items: [
        { kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'lessOrEqual', right: { kind: 'literal', type: 'number', value: '-12.50' } },
        {
          kind: 'group',
          op: 'or',
          items: [
            { kind: 'compare', left: { kind: 'path', path: ['aprovado'] }, operator: 'equals', right: { kind: 'literal', type: 'boolean', value: 'true' } },
            { kind: 'compare', left: { kind: 'path', path: ['DataVencimento'] }, operator: 'lessThan', right: { kind: 'path', path: ['DataVencimento'] } },
            { kind: 'compare', left: { kind: 'path', path: ['documentos'] }, operator: 'contains', right: { kind: 'literal', type: 'text', value: 'RG' } },
            {
              kind: 'compare',
              left: { kind: 'path', path: ['DataVencimento'], offset: { sign: '-', amount: '2', unit: 'years' } },
              operator: 'greaterOrEqual',
              right: { kind: 'system', name: 'currentDate', offset: { sign: '+', amount: '10', unit: 'days' } },
            },
          ],
        },
      ],
    };
    const written = toJson(rows);
    expect('json' in written && parseCondition(written.json).ok).toBe(true);
  });

  it('renders a preview: paths as data.…, symbols, quoted text, E and OU, nested groups in parentheses', () => {
    expect(render(toRows(EXAMPLE))).toBe('data.DataVencimento ≥ currentDate E data.valor ≤ 50000');
    const nested = {
      kind: 'group',
      op: 'and',
      items: [
        compare(path('nome'), 'equals', literal('text', 'Ana')),
        { kind: 'group', op: 'or', items: [compare(path('aprovado'), 'equals', literal('boolean', 'true')), compare(path('documentos'), 'isNotEmpty')] },
      ],
    };
    expect(render(toRows(nested))).toBe('data.nome = "Ana" E (data.aprovado = verdadeiro OU data.documentos não está vazio)');
    const call = { kind: 'call', function: 'sum', args: [path('itens', '[]', 'valor')] };
    expect(render(toRows(compare(call, 'greaterThan', literal('number', '10'))))).toBe('sum(data.itens[].valor) > 10');
    expect(render({ kind: 'group', op: 'and', items: [{ kind: 'compare', left: null, operator: null, right: null }] })).toBe('… … …');
    expect(render(toRows(null))).toBe('');
  });

  it('says what a row lacks, and warns about types that do not match and empty groups', () => {
    const rows: Group = {
      kind: 'group',
      op: 'and',
      items: [
        { kind: 'compare', left: null, operator: null, right: null },
        { kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: null, right: null },
        { kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: 'equals', right: { kind: 'path', path: [] } },
        { kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'equals', right: { kind: 'literal', type: 'number', value: 'abc' } },
        { kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'equals', right: { kind: 'path', path: ['nome'] } },
        { kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'equals', right: { kind: 'path', path: ['limite'] } },
        { kind: 'group', op: 'or', items: [] },
      ],
    };

    expect(problemsOf(rows, CATALOG)).toEqual(
      new Map([
        ['0', { error: 'Escolha o dado.' }],
        ['1', { error: 'Escolha o operador.' }],
        ['2', { error: 'Informe o valor.' }],
        ['3', { error: 'Número inválido.' }],
        ['4', { warning: 'Os tipos não combinam.' }],
        ['6', { warning: 'Grupo vazio.' }],
      ]),
    );
    expect(problemsOf({ kind: 'group', op: 'and', items: [] }, CATALOG)).toEqual(new Map([['', { warning: 'Grupo vazio.' }]]));
  });

  it('adds, changes and removes rows by their place in the tree', () => {
    const empty: Group = { kind: 'group', op: 'and', items: [] };
    const one = addAt(empty, [], { kind: 'compare', left: null, operator: null, right: null });
    const two = addAt(one, [], { kind: 'group', op: 'or', items: [] });
    const three = addAt(two, [1], { kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: null, right: null });
    expect(three).toEqual({
      kind: 'group',
      op: 'and',
      items: [
        { kind: 'compare', left: null, operator: null, right: null },
        { kind: 'group', op: 'or', items: [{ kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: null, right: null }] },
      ],
    });

    const changed = updateAt(three, [1, 0], (row) => ({ ...row, operator: 'isEmpty' }) as Row);
    expect((changed.items[1] as Group).items[0]).toMatchObject({ operator: 'isEmpty' });
    expect(removeAt(changed, [1, 0])).toEqual({ ...two });
    expect(removeAt(two, [0])).toEqual({ kind: 'group', op: 'and', items: [{ kind: 'group', op: 'or', items: [] }] });
  });

  it('enters a datetime in the evaluation zone, UTC−03:00, and shows a stored one there', () => {
    expect(fromZoneLocal('2026-10-15T14:30')).toBe('2026-10-15T14:30-03:00');
    expect(toZoneLocal('2026-10-15T17:30:00Z')).toBe('2026-10-15T14:30');
    expect(toZoneLocal('2026-10-15T14:30-03:00')).toBe('2026-10-15T14:30');
    expect(toZoneLocal('2026-10-16T01:00:00+02:00')).toBe('2026-10-15T20:00');
    expect(toZoneLocal('not a datetime')).toBeNull();
  });
});
