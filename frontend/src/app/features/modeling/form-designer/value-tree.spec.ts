import { parseValue } from '../../../expression';
import { fromDocument } from './form-edits';
import { FUNCTIONS, inferType, laterComputedReads, pathsIn, unmarkedSensitiveReads } from './value-tree';

const path = (...segments: string[]) => ({ kind: 'path', path: segments });
const number = (value: string) => ({ kind: 'literal', type: 'number', value });

describe('value trees for computed fields (form-designer.md §12.6, expression-language.md §3b)', () => {
  it('offers every function of §3b, each a call the parser accepts', () => {
    expect(FUNCTIONS.map((spec) => spec.name)).toEqual(['abs', 'round', 'floor', 'ceil', 'min', 'max', 'sum', 'avg', 'count', 'string', 'number', 'date', 'time', 'datetime']);
    for (const spec of FUNCTIONS) {
      const args = spec.args.map((_, i) => (spec.name === 'number' || (spec.name === 'datetime' && i === 0) ? { kind: 'literal', type: 'text', value: '1' } : number('1')));
      const tree = { kind: 'call', function: spec.name, args: spec.name === 'sum' || spec.name === 'avg' || spec.name === 'count' ? [path('itens', '[]', 'valor')] : args };
      expect(parseValue(tree).ok).toBe(true);
    }
  });

  it('infers the type an expression produces, with every path unknown (workflow-definition.md §6.1)', () => {
    expect(inferType({ kind: 'arithmetic', op: 'multiply', left: path('a'), right: path('b') })).toBe('number');
    expect(inferType({ kind: 'call', function: 'sum', args: [path('itens', '[]', 'valor')] })).toBe('number');
    expect(inferType({ kind: 'call', function: 'string', args: [path('a')] })).toBe('text');
    expect(inferType({ kind: 'call', function: 'date', args: [path('a')] })).toBe('date');
    expect(inferType({ kind: 'system', name: 'currentDateTime' })).toBe('datetime');
    expect(inferType({ kind: 'literal', type: 'boolean', value: 'true' })).toBe('boolean');
    expect(inferType(path('a'))).toBe('unknown');
    expect(inferType(undefined)).toBe('unknown');
  });

  it('lists the paths an expression reads', () => {
    const tree = { kind: 'arithmetic', op: 'add', left: { kind: 'call', function: 'sum', args: [path('itens', '[]', 'valor')] }, right: path('frete') };

    expect(pathsIn(tree)).toEqual([['itens', '[]', 'valor'], ['frete']]);
  });

  it('names the computed fields an expression reads that come later in the form, which it would read before they are computed', () => {
    const designer = fromDocument(
      {
        schemaVersion: 1,
        components: [
          { type: 'computed', key: 'total', label: 'Total', expression: { kind: 'arithmetic', op: 'add', left: path('subtotal'), right: path('frete') } },
          { type: 'number', key: 'frete', label: 'Frete' },
          { type: 'computed', key: 'subtotal', label: 'Subtotal', expression: path('frete') },
        ],
      },
      (() => {
        let n = 0;
        return () => `n${++n}`;
      })(),
    );

    expect(laterComputedReads(designer, 'n1')).toEqual(['Subtotal']);
    expect(laterComputedReads(designer, 'n3')).toEqual([]);
  });

  it("names the sensitive keys a computed field reads while it isn't sensitive itself (ADR-0016 §6 rule 2, WF209)", () => {
    const designer = fromDocument(
      {
        schemaVersion: 1,
        components: [
          { type: 'text', key: 'cpf', label: 'CPF', sensitive: true },
          { type: 'computed', key: 'prefixo', label: 'Prefixo', expression: { kind: 'call', function: 'string', args: [path('cpf')] } },
          { type: 'group', key: 'conta', label: 'Conta', sensitive: true, components: [{ type: 'computed', key: 'copia', label: 'Cópia', expression: path('cpf') }] },
          { type: 'computed', key: 'outro', label: 'Outro', expression: path('nome') },
        ],
      },
      (() => {
        let n = 0;
        return () => `n${++n}`;
      })(),
    );

    expect(unmarkedSensitiveReads(designer, 'n2')).toEqual(['cpf']);
    expect(unmarkedSensitiveReads(designer, 'n4')).toEqual([]); // its group is sensitive
    expect(unmarkedSensitiveReads(designer, 'n5')).toEqual([]);
  });
});
