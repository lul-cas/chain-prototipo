import { parseDateTime } from '../expression';
import { Num } from '../expression/decimal';
import { evaluateForm } from './evaluation';
import { FormComponent, FormDocument } from './model';
import { Clock } from './rules';
import { EditableObject, initialValues } from './values';

const CLOCK: Clock = { now: parseDateTime('2026-10-16T12:00:00Z')!, zone: -180 };

const path = (...segments: string[]) => ({ kind: 'path', path: segments });
const text = (value: string) => ({ kind: 'literal', type: 'text', value });
const number = (value: string) => ({ kind: 'literal', type: 'number', value });
const equals = (left: unknown, right: unknown) => ({ kind: 'compare', left, operator: 'equals', right });

function form(...components: FormComponent[]): FormDocument {
  return { schemaVersion: 1, components };
}

function evaluate(document: FormDocument, values: Partial<EditableObject>, base: Record<string, unknown> = {}) {
  return evaluateForm(document, { ...initialValues(document.components, {}), ...values } as EditableObject, base, CLOCK);
}

const TIPO: FormComponent = {
  type: 'radio',
  key: 'tipo',
  label: 'Tipo',
  validate: { required: true },
  options: [
    { value: 'pf', label: 'Pessoa física' },
    { value: 'pj', label: 'Pessoa jurídica' },
  ],
};
const CPF: FormComponent = {
  type: 'text',
  key: 'cpf',
  label: 'CPF',
  validate: { format: 'cpf' },
  visibleWhen: equals(path('tipo'), text('pf')),
  requiredWhen: equals(path('tipo'), text('pf')),
};

describe('form evaluation (forms.md F2 and F3)', () => {
  it('hides a field whose condition is false: not validated and not sent', () => {
    const result = evaluate(form(TIPO, CPF), { tipo: 'pj', cpf: 'lixo' });

    expect(result.fields.get('cpf')?.visible).toBe(false);
    expect(result.data).toEqual({ tipo: 'pj' });
    expect(result.valid).toBe(true);
  });

  it('shows, requires and validates it when the condition holds', () => {
    expect(evaluate(form(TIPO, CPF), { tipo: 'pf' }).fields.get('cpf')).toMatchObject({ visible: true, required: true, errors: ['required'] });
    expect(evaluate(form(TIPO, CPF), { tipo: 'pf', cpf: '529.982.247-24' }).fields.get('cpf')?.errors).toEqual(['invalid_format']);
    const valid = evaluate(form(TIPO, CPF), { tipo: 'pf', cpf: '529.982.247-25' });
    expect(valid.data).toEqual({ tipo: 'pf', cpf: '529.982.247-25' });
    expect(valid.valid).toBe(true);
  });

  it('reads the request data around the form, with the form values on top', () => {
    const limite: FormComponent = {
      type: 'text',
      key: 'justificativa',
      label: 'Justificativa',
      visibleWhen: { kind: 'compare', left: path('valorAprovado'), operator: 'greaterThan', right: number('1000') },
    };

    expect(evaluate(form(limite), {}, { valorAprovado: 5000 }).fields.get('justificativa')?.visible).toBe(true);
    expect(evaluate(form(limite), {}, { valorAprovado: 10 }).fields.get('justificativa')?.visible).toBe(false);
    expect(evaluate(form(TIPO, CPF), { tipo: 'pf' }, { tipo: 'pj' }).fields.get('cpf')?.visible).toBe(true);
  });

  it('treats a condition that fails as true, with expression_error, as the server does', () => {
    const broken: FormComponent = {
      type: 'text',
      key: 'obs',
      label: 'Observação',
      visibleWhen: { kind: 'compare', left: path('tipo'), operator: 'greaterThan', right: number('1') },
    };

    const result = evaluate(form(TIPO, broken), { tipo: 'pf', obs: 'ok' });

    expect(result.fields.get('obs')).toMatchObject({ visible: true, errors: ['expression_error'] });
    expect(result.valid).toBe(false);
  });

  it('evaluates conditions over what will be sent, so a hidden value does not count', () => {
    const b: FormComponent = { type: 'text', key: 'b', label: 'B', visibleWhen: equals(path('a'), text('sim')) };
    const c: FormComponent = { type: 'text', key: 'c', label: 'C', visibleWhen: equals(path('b'), text('x')) };
    const a: FormComponent = { type: 'text', key: 'a', label: 'A' };

    const result = evaluate(form(a, b, c), { a: 'não', b: 'x', c: 'texto' });

    expect(result.fields.get('b')?.visible).toBe(false);
    expect(result.fields.get('c')?.visible).toBe(false);
    expect(result.data).toEqual({ a: 'não' });
  });

  it('computes fields in document order from the valid values, without sending them', () => {
    const doc = form(
      { type: 'number', key: 'quantidade', label: 'Quantidade' },
      { type: 'number', key: 'preco', label: 'Preço' },
      { type: 'computed', key: 'total', label: 'Total', expression: { kind: 'arithmetic', op: 'multiply', left: path('quantidade'), right: path('preco') } },
      { type: 'computed', key: 'comTaxa', label: 'Com taxa', expression: { kind: 'arithmetic', op: 'add', left: path('total'), right: number('0.1') } },
    );

    const result = evaluate(doc, { quantidade: '3', preco: '0,1' });

    const total = result.fields.get('total')?.computed;
    expect(total?.kind === 'number' ? total.value.toFixed() : null).toBe('0.3');
    const comTaxa = result.fields.get('comTaxa')?.computed;
    expect(comTaxa?.kind === 'number' ? comTaxa.value.toFixed() : null).toBe('0.4');
    expect(Object.keys(result.data)).toEqual(['quantidade', 'preco']);
    expect((result.data['preco'] as Num).toFixed()).toBe('0.1');
  });

  it('computes from valid values only, as the server stores them', () => {
    const doc = form(
      { type: 'number', key: 'quantidade', label: 'Quantidade', validate: { min: 1 } },
      { type: 'time', key: 'hora', label: 'Hora' },
      { type: 'computed', key: 'dobro', label: 'Dobro', expression: { kind: 'arithmetic', op: 'multiply', left: path('quantidade'), right: number('2') } },
      { type: 'computed', key: 'horaGuardada', label: 'Hora guardada', expression: path('hora') },
    );

    const result = evaluate(doc, { quantidade: '0', hora: '09:00' });

    expect(result.fields.get('quantidade')?.errors).toEqual(['too_small']);
    expect(result.fields.get('dobro')?.computed).toBeUndefined(); // the invalid 0 is not stored, so it is missing
    expect(result.fields.get('horaGuardada')?.computed).toEqual({ kind: 'text', value: '09:00:00' }); // canonical, as stored
  });

    it('leaves read-only fields as prefilled: not validated, not sent', () => {
    const doc = form({ type: 'text', key: 'protocolo', label: 'Protocolo', readOnly: true, validate: { required: true, minLength: 50 } });

    const result = evaluateForm(doc, initialValues(doc.components, { protocolo: 'P-1' }), { protocolo: 'P-1' }, CLOCK);

    expect(result.fields.get('protocolo')).toMatchObject({ visible: true, readOnly: true, errors: [] });
    expect(result.data).toEqual({});
  });

  // Card #86 (owner decision B): an empty field is sent as null, so the server clears the value an earlier step stored.

  it('sends an unchecked box that was prefilled checked as null', () => {
    const doc = form({ type: 'checkbox', key: 'aceite', label: 'Aceite' });

    const result = evaluate(doc, { aceite: false }, { aceite: true });

    expect(result.data).toEqual({ aceite: null });
    expect(result.valid).toBe(true);
  });

  it('sends every empty field as null, and keeps groups and lists in shape', () => {
    const doc = form(
      { type: 'text', key: 'apelido', label: 'Apelido' },
      { type: 'number', key: 'valor', label: 'Valor' },
      { type: 'checkbox', key: 'aceite', label: 'Aceite' },
      { type: 'select', key: 'modalidade', label: 'Modalidade', options: [{ value: 'pf', label: 'PF' }] },
      { type: 'checklist', key: 'docs', label: 'Documentos', options: [{ value: 'rg', label: 'RG' }] },
      { type: 'date', key: 'inicio', label: 'Início' },
      { type: 'group', key: 'endereco', label: 'Endereço', components: [{ type: 'text', key: 'cep', label: 'CEP' }, { type: 'text', key: 'rua', label: 'Rua' }] },
      { type: 'dynamicList', key: 'socios', label: 'Sócios', components: [{ type: 'text', key: 'nome', label: 'Nome' }] },
    );

    const result = evaluate(doc, { endereco: { cep: '01310-100', rua: '' }, socios: [{ nome: '' }, { nome: 'Bruno' }] });

    expect(result.data).toEqual({
      apelido: null,
      valor: null,
      aceite: null,
      modalidade: null,
      docs: null,
      inicio: null,
      endereco: { cep: '01310-100', rua: null },
      socios: [{ nome: null }, { nome: 'Bruno' }],
    });
  });

  it('still leaves hidden, read-only and computed fields out, and sends an empty file field as null', () => {
    const doc = form(
      TIPO,
      CPF,
      { type: 'text', key: 'protocolo', label: 'Protocolo', readOnly: true },
      { type: 'computed', key: 'total', label: 'Total', expression: path('nada') },
      { type: 'file', key: 'anexo', label: 'Anexo' },
    );

    const result = evaluate(doc, { tipo: 'pj' }, { protocolo: '' });

    expect(result.data).toEqual({ tipo: 'pj', anexo: null });
  });

  it('reads an emptied field as missing, not as its prefill, as the server will', () => {
    const doc = form(
      { type: 'text', key: 'obs', label: 'Observação' },
      { type: 'text', key: 'motivo', label: 'Motivo', visibleWhen: { kind: 'compare', left: path('obs'), operator: 'isNotEmpty' } },
      { type: 'number', key: 'quantidade', label: 'Quantidade' },
      { type: 'computed', key: 'dobro', label: 'Dobro', expression: { kind: 'arithmetic', op: 'multiply', left: path('quantidade'), right: number('2') } },
    );

    const result = evaluate(doc, { obs: '', motivo: '', quantidade: '' }, { obs: 'Primeira', quantidade: 3 });

    expect(result.fields.get('motivo')?.visible).toBe(false);
    expect(result.fields.get('dobro')?.computed).toBeUndefined();
  });

  it('checks rows with their own paths, and the row count', () => {
    const doc = form({
      type: 'dynamicList',
      key: 'socios',
      label: 'Sócios',
      validate: { minRows: 1, maxRows: 2 },
      components: [{ type: 'text', key: 'nome', label: 'Nome', validate: { required: true } }],
    });

    expect(evaluate(doc, { socios: [] }).fields.get('socios')?.errors).toEqual(['too_few']);
    expect(evaluate(doc, { socios: [{ nome: '' }, { nome: '' }, { nome: '' }] }).fields.get('socios')?.errors).toEqual(['too_many']);
    const rows = evaluate(doc, { socios: [{ nome: 'Ana' }, { nome: '' }] });
    expect(rows.fields.get('socios[1].nome')?.errors).toEqual(['required']);
    expect(rows.fields.get('socios[0].nome')?.errors).toEqual([]);
  });

  it('hides the children of a hidden group', () => {
    const doc = form(TIPO, {
      type: 'group',
      key: 'empresa',
      label: 'Empresa',
      visibleWhen: equals(path('tipo'), text('pj')),
      components: [{ type: 'text', key: 'razao', label: 'Razão social', validate: { required: true } }],
    });

    const result = evaluate(doc, { tipo: 'pf' });

    expect(result.fields.get('empresa')?.visible).toBe(false);
    expect(result.fields.get('empresa.razao')?.visible ?? false).toBe(false);
    expect(result.valid).toBe(true);
  });

  it('sends a file field as its file ids, null when empty, and checks it is required and how many files it holds (F3, "File fields")', () => {
    const doc = form(
      { type: 'file', key: 'contrato', label: 'Contrato', validate: { required: true, maxFiles: 1 } },
      { type: 'file', key: 'anexo', label: 'Anexo' },
      { type: 'file', key: 'oculto', label: 'Oculto', visibleWhen: { kind: 'compare', left: path('nada'), operator: 'isNotEmpty' } },
    );
    const file = (id: string) => ({ fileId: id, name: `${id}.pdf`, size: '1024', contentType: 'application/pdf' });

    const empty = evaluate(doc, {});
    expect(empty.fields.get('contrato')?.errors).toEqual(['required']);
    expect(empty.data).toEqual({ contrato: null, anexo: null });
    expect(empty.valid).toBe(false);

    const two = evaluate(doc, { contrato: [file('f-1'), file('f-2')], anexo: [file('f-3')], oculto: [file('f-4')] });
    expect(two.fields.get('contrato')?.errors).toEqual(['too_many']);
    expect(two.data).toEqual({ contrato: [{ fileId: 'f-1' }, { fileId: 'f-2' }], anexo: [{ fileId: 'f-3' }] }); // hidden: not sent

    expect(evaluate(doc, { contrato: [file('f-1')] }).valid).toBe(true);
  });

  it('holds the form back while a file uploads, counting it in maxFiles but not sending it', () => {
    const doc = form({ type: 'file', key: 'contrato', label: 'Contrato', validate: { required: true, maxFiles: 1 } });
    const pending = (id: string) => ({ uploadId: id, name: `${id}.pdf` });

    const uploading = evaluate(doc, { contrato: [pending('u-1')] });
    expect(uploading.fields.get('contrato')).toEqual({ visible: true, required: true, readOnly: false, errors: [], uploading: true });
    expect(uploading.data).toEqual({ contrato: null });
    expect(uploading.valid).toBe(false);

    const both = evaluate(doc, { contrato: [{ fileId: 'f-1', name: 'a.pdf', size: '1', contentType: 'application/pdf' }, pending('u-2')] });
    expect(both.fields.get('contrato')?.errors).toEqual(['too_many']);
    expect(both.data).toEqual({ contrato: [{ fileId: 'f-1' }] });
  });

  it('evaluates display components for visibility only', () => {
    const doc = form(TIPO, { type: 'paragraph', text: 'Só para PJ', visibleWhen: equals(path('tipo'), text('pj')) });

    // Display components have no key: they are identified by their parent's path and position.
    expect(evaluate(doc, { tipo: 'pf' }).display.get('#1')).toBe(false);
    expect(evaluate(doc, { tipo: 'pj' }).display.get('#1')).toBe(true);
  });
});
