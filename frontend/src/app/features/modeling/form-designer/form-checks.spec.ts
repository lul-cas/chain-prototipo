import { FormComponent, FormDocument } from '../../../forms/model';
import { checkForm } from './form-checks';

const form = (...components: FormComponent[]): FormDocument => ({ schemaVersion: 1, components });
const text = (key: string, extra: Partial<FormComponent> = {}): FormComponent => ({ type: 'text', key, label: key, ...extra });
const codes = (document: FormDocument) => checkForm(document).map((problem) => [problem.code, problem.path].filter((part) => part !== null).join(' '));
const path = (key: string) => ({ kind: 'path', path: [key] });

describe('the designer\'s local checks (form-designer.md §9.2), as the server\'s FormValidator', () => {
  it('passes a valid form with every kind of component', () => {
    const document = form(
      { type: 'heading', text: 'Dados' },
      text('nome', { validate: { required: true, maxLength: 80, format: 'cpf', pattern: '[0-9]{3}' } }),
      { type: 'number', key: 'valor', label: 'Valor', validate: { min: 1, max: 10, decimalDigits: 2, step: 0.5 } },
      { type: 'select', key: 'tipo', label: 'Tipo', options: [{ value: 'pf', label: 'PF' }, { value: 'pj', label: 'PJ' }] },
      { type: 'checklist', key: 'docs', label: 'Docs', options: [{ value: 'rg', label: 'RG' }], validate: { minSelected: 1, maxSelected: 1 } },
      { type: 'group', key: 'conta', label: 'Conta', sensitive: true, components: [text('numero')] },
      { type: 'dynamicList', key: 'socios', label: 'Sócios', validate: { minRows: 0, maxRows: 5 }, components: [text('nome')] },
      { type: 'computed', key: 'copia', label: 'Cópia', expression: path('nome') },
      { type: 'file', key: 'rg', label: 'RG', validate: { maxFiles: 2 } },
      text('obs', { visibleWhen: { kind: 'compare', left: path('tipo'), operator: 'equals', right: { kind: 'literal', type: 'text', value: 'pf' } } }),
    );

    expect(checkForm(document)).toEqual([]);
  });

  it('FM001: a field needs a valid key, at the root and nested', () => {
    expect(codes(form({ type: 'text', label: 'Sem chave' }, text('1abc'), { type: 'group', key: 'g', label: 'G', components: [text('com espaço')] }))).toEqual([
      'FM001 components[0]',
      'FM001 1abc',
      'FM001 g.com espaço',
    ]);
  });

  it('FM011: every value-producing component has a label besides whitespace (form-designer.md FD16)', () => {
    expect(
      codes(
        form(
          { type: 'text', key: 'sem' },
          text('vazio', { label: '' }),
          text('espacos', { label: '   ' }),
          text('nel', { label: '\u0085' }), // whitespace in .NET, which JavaScript's trim keeps (#124)
          text('bom', { label: '\uFEFF' }), // not whitespace in .NET, which JavaScript's trim drops
          { type: 'group', key: 'g', label: '', components: [text('certo')] },
          { type: 'heading', text: 'Título' },
        ),
      ),
    ).toEqual(['FM011 sem', 'FM011 vazio', 'FM011 espacos', 'FM011 nel', 'FM011 g']);
  });

  it('FM002: keys are unique within their level only', () => {
    expect(codes(form(text('a'), text('a'), { type: 'group', key: 'g', label: 'G', components: [text('a'), text('b'), text('b')] }))).toEqual([
      'FM002 a',
      'FM002 g.b',
    ]);
  });

  it('FM003: choice fields need 1–200 options with unique values', () => {
    const option = (value: string) => ({ value, label: value });
    expect(
      codes(
        form(
          { type: 'select', key: 'vazio', label: 'V', options: [] },
          { type: 'radio', key: 'repetido', label: 'R', options: [option('a'), option('a')] },
          { type: 'checklist', key: 'muitos', label: 'M', options: Array.from({ length: 201 }, (_, i) => option(`o${i}`)) },
          { type: 'select', key: 'certo', label: 'C', options: [option('a')] },
        ),
      ),
    ).toEqual(['FM003 vazio', 'FM003 repetido', 'FM003 muitos']);
  });

  it('FM004: options, rules and children must fit the component', () => {
    expect(
      codes(
        form(
          text('opcoes', { options: [{ value: 'a', label: 'a' }] }),
          { type: 'checkbox', key: 'tamanho', label: 'T', validate: { maxLength: 3 } },
          text('decimais', { validate: { decimalDigits: 2 } }),
          { type: 'number', key: 'faixa', label: 'F', validate: { min: 10, max: 1 } },
          { type: 'number', key: 'casas', label: 'C', validate: { decimalDigits: 11 } },
          { type: 'number', key: 'passo', label: 'P', validate: { step: 0 } },
          text('formato', { validate: { format: 'rg' } }),
          text('comprimento', { validate: { minLength: 5, maxLength: 2 } }),
          { type: 'heading', text: 'Título', validate: { required: true } },
          { type: 'file', key: 'arquivos', label: 'A', validate: { maxFiles: 11 } },
          text('arquivos2', { validate: { maxFiles: 2 } }),
          { type: 'group', key: 'vazio', label: 'V', components: [] },
          text('filhos', { components: [text('x')] }),
        ),
      ),
    ).toEqual([
      'FM004 opcoes',
      'FM004 tamanho',
      'FM004 decimais',
      'FM004 faixa',
      'FM004 casas',
      'FM004 passo',
      'FM004 formato',
      'FM004 comprimento',
      'FM004 components[8]',
      'FM004 arquivos',
      'FM004 arquivos2',
      'FM004 vazio',
      'FM004 filhos',
    ]);
  });

  it('FM004: date bounds are ISO values of the field type, or relative bounds for dates and datetimes', () => {
    expect(
      codes(
        form(
          { type: 'date', key: 'certo1', label: 'A', validate: { min: '2026-01-31', max: { system: 'currentDate', offset: { amount: -30, unit: 'days' } } } },
          { type: 'datetime', key: 'certo2', label: 'A', validate: { min: '2026-01-31T10:00:00-03:00', max: { system: 'currentDateTime', offset: { amount: 2, unit: 'hours' } } } },
          { type: 'time', key: 'certo3', label: 'A', validate: { min: '08:00', max: '18:00:30' } },
          { type: 'date', key: 'dia', label: 'A', validate: { min: '2026-02-30' } },
          { type: 'date', key: 'horas', label: 'A', validate: { max: { system: 'currentDate', offset: { amount: 1, unit: 'hours' } } } },
          { type: 'time', key: 'relativo', label: 'A', validate: { min: { system: 'currentDateTime' } } },
          { type: 'datetime', key: 'sistema', label: 'A', validate: { min: { system: 'currentDate' } } },
          { type: 'datetime', key: 'longe', label: 'A', validate: { min: { system: 'currentDateTime', offset: { amount: 10_001, unit: 'days' } } } },
          { type: 'datetime', key: 'semzona', label: 'A', validate: { min: '2026-01-31T10:00' } },
          { type: 'date', key: 'numero', label: 'A', validate: { min: 5 } },
        ),
      ),
    ).toEqual(['FM004 dia', 'FM004 horas', 'FM004 relativo', 'FM004 sistema', 'FM004 longe', 'FM004 semzona', 'FM004 numero']);
  });

  it('FM004: accept lists distinct types from the allowlist of ADR-0014 §5, for file fields', () => {
    expect(
      codes(
        form(
          { type: 'file', key: 'certo', label: 'C', validate: { accept: ['application/pdf', 'image/png'] } },
          { type: 'file', key: 'vazio', label: 'V', validate: { accept: [] } },
          { type: 'file', key: 'repetido', label: 'R', validate: { accept: ['image/png', 'image/png'] } },
          { type: 'file', key: 'estranho', label: 'E', validate: { accept: ['application/zip'] } },
        ),
      ),
    ).toEqual(['FM004 vazio', 'FM004 repetido', 'FM004 estranho']);
  });

  it('reports a rule once per component, even when it fails in several ways', () => {
    expect(codes(form({ type: 'number', key: 'faixa', label: 'F', validate: { min: '1', max: '2', decimalDigits: 20, minLength: 1 } }))).toEqual(['FM004 faixa']);
  });

  it('FM005: a pattern compiles, has at most 500 characters and uses only the allowlist (card #149)', () => {
    expect(
      codes(
        form(
          text('aberto', { validate: { pattern: '([0-9]' } }),
          text('longo', { validate: { pattern: 'a'.repeat(501) } }),
          text('digitos', { validate: { pattern: '\\d{3}' } }),
          text('ok', { validate: { pattern: '[a-z]+(?=x)' } }),
        ),
      ),
    ).toEqual(['FM005 aberto', 'FM005 longo', 'FM005 digitos']);
  });

  it('FM012: a field may have a description of up to 500 characters; display components have none (card #234)', () => {
    expect(
      codes(
        form(
          text('ok', { description: 'd'.repeat(500) }),
          text('longa', { description: 'd'.repeat(501) }),
          { type: 'paragraph', text: 'Leia.', description: 'x' } as FormComponent,
        ),
      ),
    ).toEqual(['FM012 longa', 'FM012 components[2]']);
  });

  it('FM006: at most 200 components and 3 levels of groups and lists', () => {
    const many = form(...Array.from({ length: 201 }, (_, i) => text(`c${i}`)));
    expect(codes(many)).toEqual(['FM006']); // the whole form: no path, as on the server
    const deep = form({
      type: 'group', key: 'a', label: 'A',
      components: [{ type: 'group', key: 'b', label: 'B', components: [{ type: 'group', key: 'c', label: 'C', components: [{ type: 'group', key: 'd', label: 'D', components: [text('e')] }] }] }],
    });
    expect(codes(deep)).toEqual(['FM006']);
  });

  it('FM007 and FM008: a computed field needs a valid expression, and conditions must be valid trees', () => {
    expect(
      codes(
        form(
          { type: 'computed', key: 'sem', label: 'S' },
          { type: 'computed', key: 'ruim', label: 'R', expression: { kind: 'nada' } },
          text('cond', { visibleWhen: { kind: 'compare', left: path('x'), operator: 'nope' } }),
          { type: 'group', key: 'g', label: 'G', components: [text('req', { requiredWhen: { kind: 'group' } })] },
        ),
      ),
    ).toEqual(['FM007 sem', 'FM007 ruim', 'FM008 cond', 'FM008 g.req']);
  });

  it('FM009 and FM010: only top-level fields can be sensitive, and never a file field (sensitive-data.md §1)', () => {
    expect(
      codes(
        form(
          { type: 'heading', text: 'Título', sensitive: true },
          { type: 'group', key: 'g', label: 'G', components: [text('dentro', { sensitive: true })] },
          { type: 'file', key: 'rg', label: 'RG', sensitive: true },
          text('cpf', { sensitive: true }),
        ),
      ),
    ).toEqual(['FM009 components[0]', 'FM009 g.dentro', 'FM010 rg']);
  });

  it('gives the full path of a field nested two levels deep (card #237)', () => {
    const document = form({ type: 'group', key: 'a', label: 'A', components: [{ type: 'group', key: 'b', label: 'B', components: [text('c', { options: [] })] }] });

    expect(codes(document)).toEqual(['FM004 a.b.c']);
  });
});
