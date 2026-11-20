import { Num } from '../expression/decimal';
import { FormComponent } from './model';
import { fromLocalInput, initialValues, serializeJson, toLocalInput } from './values';

const COMPONENTS: FormComponent[] = [
  { type: 'heading', text: 'Dados' },
  { type: 'text', key: 'nome', label: 'Nome' },
  { type: 'number', key: 'valor', label: 'Valor' },
  { type: 'checkbox', key: 'aceite', label: 'Aceite' },
  { type: 'select', key: 'modalidade', label: 'Modalidade', options: [{ value: 'pf', label: 'PF' }] },
  { type: 'checklist', key: 'docs', label: 'Documentos', options: [{ value: 'rg', label: 'RG' }] },
  { type: 'date', key: 'inicio', label: 'Início' },
  { type: 'time', key: 'hora', label: 'Hora' },
  { type: 'datetime', key: 'quando', label: 'Quando' },
  { type: 'computed', key: 'total', label: 'Total', expression: { kind: 'literal', value: 1 } },
  { type: 'group', key: 'endereco', label: 'Endereço', components: [{ type: 'text', key: 'cep', label: 'CEP' }] },
  { type: 'dynamicList', key: 'socios', label: 'Sócios', components: [{ type: 'text', key: 'nome', label: 'Nome' }] },
];

describe('editable values', () => {
  it('starts every field empty without prefill', () => {
    expect(initialValues(COMPONENTS, {})).toEqual({
      nome: '',
      valor: '',
      aceite: false,
      modalidade: '',
      docs: [],
      inicio: '',
      hora: '',
      quando: '',
      endereco: { cep: '' },
      socios: [],
    });
  });

  it("keeps a file field's prefilled files, with their sizes as text, and drops anything else (forms.md F3)", () => {
    const fields: FormComponent[] = [
      { type: 'file', key: 'contrato', label: 'Contrato' },
      { type: 'file', key: 'outro', label: 'Outro' },
    ];
    const stored = { fileId: 'f-1', name: 'contrato.pdf', size: 1024, contentType: 'application/pdf' };

    expect(initialValues(fields, { contrato: [stored, { nada: 1 }], outro: 'x' })).toEqual({
      contrato: [{ fileId: 'f-1', name: 'contrato.pdf', size: '1024', contentType: 'application/pdf' }],
      outro: [],
    });
  });

  it('takes the prefill, with numbers written in pt-BR', () => {
    const values = initialValues(COMPONENTS, {
      nome: 'Ana',
      valor: 1234.5,
      aceite: true,
      modalidade: 'pf',
      docs: ['rg'],
      inicio: '2026-10-16',
      hora: '09:00:00',
      quando: '2026-10-16T17:30:00Z',
      total: 99,
      endereco: { cep: '01310-100' },
      socios: [{ nome: 'Bruno' }, { nome: 'Carla' }],
      outro: 'fora do formulário',
    });

    expect(values).toEqual({
      nome: 'Ana',
      valor: '1234,5',
      aceite: true,
      modalidade: 'pf',
      docs: ['rg'],
      inicio: '2026-10-16',
      hora: '09:00:00',
      quando: '2026-10-16T17:30:00Z',
      endereco: { cep: '01310-100' },
      socios: [{ nome: 'Bruno' }, { nome: 'Carla' }],
    });
  });

  it('ignores prefill of the wrong shape instead of failing', () => {
    expect(initialValues(COMPONENTS, { nome: 5, valor: 'muito', docs: 'rg', endereco: 'x', socios: [1, null] })).toMatchObject({
      nome: '',
      valor: '',
      docs: [],
      endereco: { cep: '' },
      socios: [{ nome: '' }, { nome: '' }],
    });
  });

  it('writes JSON with exact decimals', () => {
    expect(serializeJson({ valor: new Num('1234567890123456789.0123456789'), nome: 'Ana "A"', ok: true, rows: [{ n: new Num('-0.5') }], nada: null })).toBe(
      '{"valor":1234567890123456789.0123456789,"nome":"Ana \\"A\\"","ok":true,"rows":[{"n":-0.5}],"nada":null}',
    );
  });

  describe('a datetime field, in UTC−03:00 whatever the browser zone (forms.md F3; card #157)', () => {
    beforeEach(() => vi.stubEnv('TZ', 'Asia/Tokyo')); // a browser twelve hours ahead of UTC−03:00, whatever this machine's zone is
    afterEach(() => vi.unstubAllEnvs());

    it('sends what the native input shows as that time in UTC−03:00', () => {
      expect(fromLocalInput('2026-10-16T14:30')).toBe('2026-10-16T14:30:00-03:00');
      expect(fromLocalInput('2026-10-16T14:30:15')).toBe('2026-10-16T14:30:15-03:00');
      expect(fromLocalInput('')).toBe('');
    });

    it('shows a stored value on the clock of UTC−03:00, to the minute', () => {
      expect(toLocalInput('2026-10-16T17:30:00Z')).toBe('2026-10-16T14:30');
      expect(toLocalInput('2026-10-16T14:30:00-03:00')).toBe('2026-10-16T14:30');
      expect(toLocalInput('2026-10-17T01:15:00+09:00')).toBe('2026-10-16T13:15');
      expect(toLocalInput(fromLocalInput('2026-10-16T23:59'))).toBe('2026-10-16T23:59');
      expect(toLocalInput('')).toBe('');
      expect(toLocalInput('não é data')).toBe('');
    });
  });
});
