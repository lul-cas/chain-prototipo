import { FormDocument } from '../../../forms/model';
import { checkForm } from './form-checks';
import {
  DesignerDocument,
  changed,
  created,
  fromDocument,
  insert,
  limitRefusal,
  locate,
  move,
  pathOf,
  placeToAdd,
  remove,
  stepDown,
  stepUp,
  toDocument,
} from './form-edits';

const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};

const SAVED: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'heading', text: 'Dados' },
    { type: 'text', key: 'nome', label: 'Nome', validate: { required: true } },
    {
      type: 'group',
      key: 'endereco',
      label: 'Endereço',
      components: [
        { type: 'text', key: 'cep', label: 'CEP' },
        { type: 'text', key: 'rua', label: 'Rua' },
      ],
    },
    { type: 'number', key: 'valor', label: 'Valor' },
  ],
};

/** Each component as `key` (or its type), with its children, to read a tree at a glance. */
const shape = (document: DesignerDocument | FormDocument): unknown[] =>
  document.components.map((component) =>
    component.components ? { [component.key ?? component.type]: shape({ schemaVersion: 1, components: component.components }) } : (component.key ?? component.type),
  );
const idOf = (document: DesignerDocument, key: string): string => {
  const walk = (components: DesignerDocument['components']): string | undefined =>
    components.map((component) => (component.key === key ? component.id : walk(component.components ?? []))).find(Boolean);
  return walk(document.components)!;
};

describe('the designer document (form-designer.md §4.4)', () => {
  it('gives every component an id in memory only: the saved JSON is the draft as it was', () => {
    const designer = fromDocument(SAVED, counter());

    expect(designer.components.map((component) => component.id)).toEqual(['n1', 'n2', 'n3', 'n6']);
    expect(designer.components[2].components!.map((component) => component.id)).toEqual(['n4', 'n5']);
    expect(toDocument(designer)).toEqual(SAVED);
    expect(JSON.stringify(toDocument(designer))).not.toContain('n1');
  });

  it('gives the path the server gives a component (forms.md F1)', () => {
    const designer = fromDocument(SAVED, counter());

    expect(pathOf(designer, idOf(designer, 'rua'))).toBe('endereco.rua');
    expect(pathOf(designer, designer.components[0].id)).toBe('components[0]');
    expect(pathOf(designer, 'nada')).toBeNull();
  });

  it('finds a component, its container and its place', () => {
    const designer = fromDocument(SAVED, counter());

    expect(locate(designer, idOf(designer, 'rua'))).toMatchObject({ parent: idOf(designer, 'endereco'), index: 1, depth: 1 });
    expect(locate(designer, idOf(designer, 'valor'))).toMatchObject({ parent: null, index: 3, depth: 0 });
    expect(locate(designer, 'nada')).toBeNull();
  });
});

describe('new components (§6)', () => {
  it.each([
    ['text', { type: 'text', label: 'Campo de texto', key: 'campo_de_texto' }],
    ['textarea', { type: 'textarea', label: 'Área de texto', key: 'area_de_texto' }],
    ['number', { type: 'number', label: 'Número', key: 'numero' }],
    ['date', { type: 'date', label: 'Data', key: 'data' }],
    ['computed', { type: 'computed', label: 'Campo calculado', key: 'campo_calculado' }],
    ['file', { type: 'file', label: 'Seletor de arquivo', key: 'seletor_de_arquivo' }],
    ['checkbox', { type: 'checkbox', label: 'Caixa de seleção', key: 'caixa_de_selecao' }],
    ['heading', { type: 'heading', text: 'Título' }],
    ['paragraph', { type: 'paragraph', text: 'Novo parágrafo' }],
    ['separator', { type: 'separator' }],
    ['group', { type: 'group', label: 'Grupo', key: 'grupo', components: [] }],
    ['dynamicList', { type: 'dynamicList', label: 'Lista dinâmica', key: 'lista_dinamica', components: [] }],
  ] as const)('%s starts as the palette says', (type, expected) => {
    const component = created(type, [], 'n1');

    expect(toDocument({ schemaVersion: 1, components: [component] }).components[0]).toEqual(expected);
  });

  it.each(['select', 'radio', 'checklist'] as const)('%s starts with two options, so it passes FM003', (type) => {
    const component = created(type, [], 'n1');

    expect(component.options).toEqual([
      { value: 'opcao_1', label: 'Opção 1' },
      { value: 'opcao_2', label: 'Opção 2' },
    ]);
    expect(checkForm(toDocument({ schemaVersion: 1, components: [component] }))).toEqual([]);
  });

  it("starts a choice field's option values following their labels, in memory only (§8.1)", () => {
    const component = created('radio', [], 'n1');

    expect(component.optionValuesFollow).toEqual([true, true]);
    expect(toDocument({ schemaVersion: 1, components: [component] }).components[0]).not.toHaveProperty('optionValuesFollow');
    expect(changed({ schemaVersion: 1, components: [component] }, 'n1', { optionValuesFollow: [false, true] }).components[0].optionValuesFollow).toEqual([false, true]);
  });

  it('takes a key not used at its level, and its key follows its label until the key is edited (§8.2)', () => {
    const first = created('text', [], 'n1');
    const second = created('text', [first], 'n2');

    expect(second.key).toBe('campo_de_texto_2');
    expect(second.keyFollowsLabel).toBe(true);
    expect(created('heading', [], 'n3').keyFollowsLabel).toBeUndefined();
  });
});

describe('where an addition goes (§7.3)', () => {
  const designer = fromDocument(SAVED, counter());

  it('at the end of the form when nothing is selected', () => {
    expect(placeToAdd(designer, null)).toEqual({ parent: null, index: 4 });
  });

  it('right after the selected component, in its container', () => {
    expect(placeToAdd(designer, idOf(designer, 'nome'))).toEqual({ parent: null, index: 2 });
    expect(placeToAdd(designer, idOf(designer, 'cep'))).toEqual({ parent: idOf(designer, 'endereco'), index: 1 });
  });

  it('at the end of the selected group or list', () => {
    expect(placeToAdd(designer, idOf(designer, 'endereco'))).toEqual({ parent: idOf(designer, 'endereco'), index: 2 });
  });
});

describe('editing the tree', () => {
  it('inserts, removes with the children, and moves into and out of groups', () => {
    const designer = fromDocument(SAVED, counter());
    const group = idOf(designer, 'endereco');

    const added = insert(designer, created('number', [], 'x'), { parent: group, index: 0 });
    expect(shape(added)).toEqual(['heading', 'nome', { endereco: ['numero', 'cep', 'rua'] }, 'valor']);

    expect(shape(remove(designer, group))).toEqual(['heading', 'nome', 'valor']);

    const inside = move(designer, idOf(designer, 'valor'), { parent: group, index: 1 });
    expect(shape(inside)).toEqual(['heading', 'nome', { endereco: ['cep', 'valor', 'rua'] }]);

    const outside = move(designer, idOf(designer, 'rua'), { parent: null, index: 0 });
    expect(shape(outside)).toEqual(['rua', 'heading', 'nome', { endereco: ['cep'] }, 'valor']);
  });

  it('moves within a container to the index the component ends at', () => {
    const designer = fromDocument(SAVED, counter());

    expect(shape(move(designer, idOf(designer, 'nome'), { parent: null, index: 3 }))).toEqual(['heading', { endereco: ['cep', 'rua'] }, 'valor', 'nome']);
  });

  it('refuses to move a group into itself or into its children, and leaves the document as it was', () => {
    const designer = fromDocument(
      { schemaVersion: 1, components: [{ type: 'group', key: 'a', label: 'A', components: [{ type: 'group', key: 'b', label: 'B', components: [{ type: 'text', key: 'c', label: 'C' }] }] }] },
      counter(),
    );

    expect(move(designer, idOf(designer, 'a'), { parent: idOf(designer, 'a'), index: 0 })).toBe(designer);
    expect(move(designer, idOf(designer, 'a'), { parent: idOf(designer, 'b'), index: 0 })).toBe(designer);
  });

  it('leaves the document as it was for an unknown id', () => {
    const designer = fromDocument(SAVED, counter());

    expect(remove(designer, 'nada')).toBe(designer);
    expect(changed(designer, 'nada', { label: 'X' })).toBe(designer);
  });
});

describe('Alt+↑ and Alt+↓ (§7.2)', () => {
  const designer = fromDocument(SAVED, counter());

  it('move past the neighbour in the container, passing a group as a whole', () => {
    expect(shape(move(designer, idOf(designer, 'nome'), stepDown(designer, idOf(designer, 'nome'))!))).toEqual([
      'heading',
      { endereco: ['cep', 'rua'] },
      'nome',
      'valor',
    ]);
    expect(shape(move(designer, idOf(designer, 'valor'), stepUp(designer, idOf(designer, 'valor'))!))).toEqual([
      'heading',
      'nome',
      'valor',
      { endereco: ['cep', 'rua'] },
    ]);
  });

  it('at the edge of a group, move out just before or after it', () => {
    expect(stepUp(designer, idOf(designer, 'cep'))).toEqual({ parent: null, index: 2 });
    expect(shape(move(designer, idOf(designer, 'cep'), stepUp(designer, idOf(designer, 'cep'))!))).toEqual(['heading', 'nome', 'cep', { endereco: ['rua'] }, 'valor']);
    expect(shape(move(designer, idOf(designer, 'rua'), stepDown(designer, idOf(designer, 'rua'))!))).toEqual(['heading', 'nome', { endereco: ['cep'] }, 'rua', 'valor']);
  });

  it('do nothing at the edges of the form', () => {
    expect(stepUp(designer, designer.components[0].id)).toBeNull();
    expect(stepDown(designer, idOf(designer, 'valor'))).toBeNull();
  });
});

describe('labels and keys (§8.2)', () => {
  it("renames a new field's key with its label, unique at its level", () => {
    let designer = fromDocument({ schemaVersion: 1, components: [{ type: 'number', key: 'valor_solicitado', label: 'Valor solicitado' }] }, counter());
    designer = insert(designer, created('text', designer.components, 'x'), { parent: null, index: 1 });

    designer = changed(designer, 'x', { label: 'Valor solicitado' });

    expect(designer.components[1]).toMatchObject({ label: 'Valor solicitado', key: 'valor_solicitado_2' });
  });

  it('keeps an edited key when the label changes, and never renames a key that was loaded', () => {
    let designer = insert(fromDocument(SAVED, counter()), created('text', [], 'x'), { parent: null, index: 0 });
    designer = changed(designer, 'x', { key: 'cpf' });
    designer = changed(designer, 'x', { label: 'CPF do tomador' });
    expect(designer.components[0]).toMatchObject({ key: 'cpf', label: 'CPF do tomador' });
    expect(designer.components[0].keyFollowsLabel).toBe(false);

    const loaded = changed(designer, idOf(designer, 'nome'), { label: 'Nome completo' });
    expect(locate(loaded, idOf(designer, 'nome'))!.component).toMatchObject({ key: 'nome', label: 'Nome completo' });
  });

  it("carries a key rename into the form's conditions and expressions, nested keys and list rows included (N3e)", () => {
    const path = (...segments: string[]) => ({ kind: 'path', path: segments });
    let designer = fromDocument(
      {
        schemaVersion: 1,
        components: [
          { type: 'group', key: 'endereco', label: 'Endereço', components: [{ type: 'text', key: 'cep', label: 'CEP' }] },
          { type: 'dynamicList', key: 'socios', label: 'Sócios', components: [{ type: 'text', key: 'nome', label: 'Nome' }] },
          { type: 'text', key: 'obs', label: 'Obs', visibleWhen: { kind: 'compare', left: path('endereco', 'cep'), operator: 'isNotEmpty' } },
          { type: 'computed', key: 'copia', label: 'Cópia', expression: path('socios', '[]', 'nome') },
        ],
      },
      counter(),
    );

    designer = changed(designer, idOf(designer, 'cep'), { key: 'codigo_postal' });
    designer = changed(designer, idOf(designer, 'nome'), { key: 'nome_completo' });

    expect(toDocument(designer).components[2].visibleWhen).toEqual({ kind: 'compare', left: path('endereco', 'codigo_postal'), operator: 'isNotEmpty' });
    expect(toDocument(designer).components[3].expression).toEqual(path('socios', '[]', 'nome_completo'));

    designer = changed(designer, idOf(designer, 'endereco'), { key: 'residencia' });
    expect(toDocument(designer).components[2].visibleWhen).toEqual({ kind: 'compare', left: path('residencia', 'codigo_postal'), operator: 'isNotEmpty' });
  });

  it('removes a property set to undefined', () => {
    const designer = fromDocument(SAVED, counter());

    const plain = changed(designer, idOf(designer, 'nome'), { validate: undefined });

    expect(toDocument(plain).components[1]).toEqual({ type: 'text', key: 'nome', label: 'Nome' });
  });
});

describe('the limits (§7.5)', () => {
  it('refuses more than 200 components', () => {
    const many = fromDocument({ schemaVersion: 1, components: Array.from({ length: 200 }, (_, i) => ({ type: 'text' as const, key: `c${i}`, label: 'C' })) }, counter());

    expect(limitRefusal(many)).toBeNull();
    expect(limitRefusal(insert(many, created('text', [], 'x'), { parent: null, index: 0 }))).toBe('O formulário já tem 200 componentes.');
  });

  it('refuses more than 3 levels of groups and lists', () => {
    const level = (key: string, children: FormDocument['components']) => ({ type: 'group' as const, key, label: key, components: children });
    const three = fromDocument({ schemaVersion: 1, components: [level('a', [level('b', [level('c', [{ type: 'text', key: 'x', label: 'X' }])])])] }, counter());

    expect(limitRefusal(three)).toBeNull();
    expect(limitRefusal(insert(three, created('group', [], 'g'), { parent: idOf(three, 'c'), index: 0 }))).toBe('Grupos e listas aninham até 3 níveis.');
  });
});

describe('a form that uses every property (§12.4, acceptance 3)', () => {
  it('passes the local checks, which follow the server', () => {
    let designer = fromDocument({ schemaVersion: 1, components: [] }, counter());
    const add = (type: Parameters<typeof created>[0], change: Parameters<typeof changed>[2]) => {
      const component = created(type, designer.components, `x${designer.components.length}`);
      designer = changed(insert(designer, component, { parent: null, index: designer.components.length }), component.id, change);
    };
    add('text', { label: 'CPF', placeholder: '000.000.000-00', validate: { required: true, minLength: 11, maxLength: 14, format: 'cpf' } });
    add('text', { label: 'Código', validate: { pattern: '[A-Z]{3}-[0-9]{3}' } });
    add('textarea', { label: 'Observações', readOnly: true, validate: { maxLength: 500 } });
    add('number', { label: 'Valor', validate: { min: 1.5, max: 1000, decimalDigits: 2, step: 0.5 } });
    add('date', { label: 'Início', validate: { min: { system: 'currentDate', offset: { amount: 2, unit: 'days' } }, max: '2026-12-31' } });
    add('date', { type: 'datetime', label: 'Reunião', validate: { max: '2026-01-31T10:00-03:00', min: { system: 'currentDateTime', offset: { amount: -3, unit: 'hours' } } } });
    add('date', { type: 'time', label: 'Hora', validate: { min: '08:00', max: '18:00' } });
    add('checklist', { label: 'Documentos', validate: { minSelected: 1, maxSelected: 2 } });
    add('radio', { label: 'Tipo', options: [{ value: 'pf', label: 'PF' }, { value: 'pj', label: 'PJ' }], validate: { required: true } });
    add('select', { label: 'Modalidade' });
    add('file', { label: 'Contrato', validate: { maxFiles: 2, accept: ['application/pdf', 'image/png'] } });
    add('checkbox', { label: 'Aceito', validate: { required: true } });
    const list = created('dynamicList', designer.components, 'list');
    designer = changed(insert(designer, list, { parent: null, index: designer.components.length }), 'list', { validate: { minRows: 1, maxRows: 5 } });
    designer = insert(designer, created('text', [], 'row'), { parent: 'list', index: 0 });

    expect(checkForm(toDocument(designer))).toEqual([]);
  });
});
