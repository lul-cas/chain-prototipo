import { FormDocument } from '../../../forms/model';
import { catalogOf, renamePaths } from './form-catalog';

const FORM: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'heading', text: 'Dados' },
    { type: 'radio', key: 'tipo', label: 'Tipo', validate: { required: true }, options: [{ value: 'pf', label: 'PF' }] },
    { type: 'number', key: 'valor', label: 'Valor' },
    { type: 'checkbox', key: 'aceite', label: 'Aceite' },
    { type: 'datetime', key: 'reuniao', label: 'Reunião' },
    { type: 'checklist', key: 'docs', label: 'Docs', options: [{ value: 'rg', label: 'RG' }] },
    { type: 'file', key: 'contrato', label: 'Contrato' },
    { type: 'computed', key: 'total', label: 'Total', expression: { kind: 'arithmetic', op: 'multiply', left: { kind: 'path', path: ['valor'] }, right: { kind: 'literal', type: 'number', value: '2' } } },
    { type: 'group', key: 'endereco', label: 'Endereço', components: [{ type: 'text', key: 'cep', label: 'CEP' }] },
    { type: 'dynamicList', key: 'socios', label: 'Sócios', components: [{ type: 'text', key: 'nome', label: 'Nome' }] },
  ],
};

describe("the form's data catalog (form-designer.md §12.5, workflow-definition.md §6.1)", () => {
  it('types each field as the workflow catalog does, with groups and list rows', () => {
    expect(catalogOf(FORM).map((entry) => `${entry.path.join('.')}: ${entry.type} ${entry.presence}`)).toEqual([
      'tipo: text definite',
      'valor: number optional',
      'aceite: boolean optional',
      'reuniao: datetime optional',
      'docs: list<text> optional',
      'total: number optional', // the expression's type (§12.6)
      'endereco: object optional',
      'endereco.cep: text optional',
      'socios: list<object> optional',
      'socios.[].nome: text optional',
    ]);
    expect(catalogOf(FORM)[0].sources).toEqual(['Este formulário']);
  });
});

describe('renaming a key in conditions and expressions (§8.2, N3e)', () => {
  const path = (...segments: string[]) => ({ kind: 'path', path: segments });

  it('renames every path that starts with the old one, and leaves the others', () => {
    const condition = {
      kind: 'group',
      op: 'and',
      items: [
        { kind: 'compare', left: path('endereco', 'cep'), operator: 'isNotEmpty' },
        { kind: 'compare', left: path('enderecos'), operator: 'isEmpty' },
        { kind: 'compare', left: path('endereco'), operator: 'isNotEmpty' },
      ],
    };

    expect(renamePaths(condition, ['endereco'], ['residencia'])).toEqual({
      kind: 'group',
      op: 'and',
      items: [
        { kind: 'compare', left: path('residencia', 'cep'), operator: 'isNotEmpty' },
        { kind: 'compare', left: path('enderecos'), operator: 'isEmpty' },
        { kind: 'compare', left: path('residencia'), operator: 'isNotEmpty' },
      ],
    });
  });

  it('reaches into calls and arithmetic, and keeps an offset', () => {
    const expression = { kind: 'arithmetic', op: 'add', left: { kind: 'call', function: 'sum', args: [path('valor')] }, right: { ...path('valor'), offset: { amount: 1, unit: 'days' } } };

    expect(renamePaths(expression, ['valor'], ['preco'])).toEqual({
      kind: 'arithmetic',
      op: 'add',
      left: { kind: 'call', function: 'sum', args: [path('preco')] },
      right: { ...path('preco'), offset: { amount: 1, unit: 'days' } },
    });
  });

  it('gives back the same tree when nothing changes', () => {
    const condition = { kind: 'compare', left: path('tipo'), operator: 'isEmpty' };

    expect(renamePaths(condition, ['valor'], ['preco'])).toBe(condition);
  });
});
