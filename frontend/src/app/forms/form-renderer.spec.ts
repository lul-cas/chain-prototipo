import { Component, signal } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { Num } from '../expression/decimal';
import { expectNoAxeViolations } from '../../testing/axe';
import { THEMES, applyTheme } from '../../testing/themes';
import { FORM_CLOCK } from './form-store';
import { FormRenderer, FormSubmission } from './form-renderer';
import { FieldErrorView, FormDocument } from './model';
import { FILE_UPLOADS, FieldFile, FileUploads } from './uploads';
import { Subject, of } from 'rxjs';

const path = (...segments: string[]) => ({ kind: 'path', path: segments });
const isPf = { kind: 'compare', left: path('tipo'), operator: 'equals', right: { kind: 'literal', type: 'text', value: 'pf' } };

const DOCUMENT: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'heading', text: 'Dados da proposta' },
    { type: 'paragraph', text: 'Preencha com atenção.' },
    {
      type: 'radio',
      key: 'tipo',
      label: 'Tipo de cliente',
      validate: { required: true },
      options: [
        { value: 'pf', label: 'Pessoa física' },
        { value: 'pj', label: 'Pessoa jurídica' },
      ],
    },
    { type: 'text', key: 'cpf', label: 'CPF', placeholder: '000.000.000-00', validate: { format: 'cpf' }, visibleWhen: isPf, requiredWhen: isPf },
    { type: 'number', key: 'quantidade', label: 'Quantidade', validate: { min: 1 } },
    { type: 'number', key: 'preco', label: 'Preço unitário', validate: { decimalDigits: 2 } },
    { type: 'computed', key: 'total', label: 'Total', expression: { kind: 'arithmetic', op: 'multiply', left: path('quantidade'), right: path('preco') } },
    { type: 'separator' },
    { type: 'checkbox', key: 'aceite', label: 'Li e aceito os termos', validate: { required: true } },
    {
      type: 'select',
      key: 'modalidade',
      label: 'Modalidade',
      options: [
        { value: 'giro', label: 'Capital de giro' },
        { value: 'invest', label: 'Investimento' },
      ],
    },
    {
      type: 'checklist',
      key: 'documentos',
      label: 'Documentos entregues',
      options: [
        { value: 'rg', label: 'RG' },
        { value: 'cnh', label: 'CNH' },
      ],
    },
    { type: 'textarea', key: 'observacoes', label: 'Observações' },
    { type: 'date', key: 'inicio', label: 'Início' },
    { type: 'time', key: 'horario', label: 'Horário' },
    { type: 'datetime', key: 'reuniao', label: 'Reunião' },
    { type: 'text', key: 'protocolo', label: 'Protocolo', readOnly: true },
    { type: 'file', key: 'contrato', label: 'Contrato' },
    {
      type: 'group',
      key: 'endereco',
      label: 'Endereço',
      components: [{ type: 'text', key: 'cep', label: 'CEP', validate: { required: true, format: 'cep' } }],
    },
    {
      type: 'dynamicList',
      key: 'socios',
      label: 'Sócios',
      validate: { maxRows: 2 },
      components: [{ type: 'text', key: 'nome', label: 'Nome', validate: { required: true } }],
    },
  ],
};

@Component({
  imports: [FormRenderer],
  template: `
    <chain-form-renderer
      [document]="document"
      [prefill]="prefill"
      [context]="context"
      [serverErrors]="errors()"
      [disabled]="disabled()"
      (submitted)="sent.push($event)"
    >
      <button type="submit">Concluir</button>
    </chain-form-renderer>
  `,
})
class Host {
  document: FormDocument = DOCUMENT;
  prefill: Record<string, unknown> = {};
  context: Record<string, unknown> = {};
  readonly errors = signal<readonly FieldErrorView[]>([]);
  readonly disabled = signal(false);
  readonly sent: FormSubmission[] = [];
}

/** 2026-10-16 12:00 UTC. */
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

async function renderForm(properties: Partial<Host> = {}, uploads?: FileUploads) {
  const view = await render(Host, {
    componentProperties: properties,
    providers: [{ provide: FORM_CLOCK, useValue: () => NOW }, ...(uploads ? [{ provide: FILE_UPLOADS, useValue: uploads }] : [])],
  });
  return { view, host: view.fixture.componentInstance, user: userEvent.setup() };
}

/** Lets an upload's answer reach the view. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('radio', { name: 'Pessoa física' }));
  await user.type(screen.getByRole('textbox', { name: 'CPF' }), '529.982.247-25');
  await user.click(screen.getByRole('checkbox', { name: 'Li e aceito os termos' }));
  await user.type(screen.getByRole('textbox', { name: 'CEP' }), '01310-100');
}

describe('FormRenderer (forms.md F3)', () => {
  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('renders every component type, with its prefill, and passes axe', async () => {
      await renderForm({
        prefill: { quantidade: 3, preco: 1.5, protocolo: 'P-2026-1', modalidade: 'invest', documentos: ['cnh'], socios: [{ nome: 'Bruno' }] },
      });

      expect(screen.getByRole('heading', { level: 3, name: 'Dados da proposta' })).toBeTruthy();
      expect(screen.getByText('Preencha com atenção.')).toBeTruthy();
      expect(screen.getByRole('separator')).toBeTruthy();
      expect(screen.getByRole('group', { name: /Tipo de cliente/ })).toBeTruthy();
      expect((screen.getByRole('textbox', { name: 'Quantidade' }) as HTMLInputElement).value).toBe('3');
      expect((screen.getByRole('textbox', { name: 'Preço unitário' }) as HTMLInputElement).value).toBe('1,5');
      expect((screen.getByRole('textbox', { name: 'Total' }) as HTMLInputElement).value).toBe('4,5');
      expect((screen.getByRole('combobox', { name: 'Modalidade' }) as HTMLSelectElement).value).toBe('invest');
      expect((screen.getByRole('checkbox', { name: 'CNH' }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole('textbox', { name: 'Protocolo' }) as HTMLInputElement).readOnly).toBe(true);
      expect(screen.getByLabelText('Início')).toBeTruthy();
      expect(screen.getByLabelText('Horário')).toBeTruthy();
      expect(screen.getByLabelText('Reunião')).toBeTruthy();
      expect(screen.getByText('O envio de arquivos não está disponível nesta tela.')).toBeTruthy(); // no uploads given
      expect(screen.getByRole('group', { name: 'Endereço' })).toBeTruthy();
      expect((screen.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement).value).toBe('Bruno');
      expect(screen.queryByRole('textbox', { name: 'CPF' })).toBeNull(); // hidden until "Pessoa física"

      await expectNoAxeViolations();
    });

    it('shows the errors of a failed submit in a summary that takes the focus, and passes axe', async () => {
      const { host, user } = await renderForm();

      await user.click(screen.getByRole('button', { name: 'Concluir' }));

      const summary = await screen.findByRole('alert');
      expect(summary.textContent).toContain('Corrija 3 campos');
      expect(document.activeElement).toBe(summary.closest('.chain-form__problems'));
      expect(screen.getByRole('link', { name: 'Tipo de cliente: Escolha uma opção.' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Li e aceito os termos: Marque esta opção.' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'CEP: Preencha este campo.' })).toBeTruthy();
      expect(host.sent).toEqual([]);
      await expectNoAxeViolations();
    });
  });

  it("shows each field's description as its hint, named by its control (forms.md F3; card #234)", async () => {
    const help: FormDocument = {
      schemaVersion: 1,
      components: [
        { type: 'text', key: 'nome', label: 'Nome', description: 'Como no documento.' },
        { type: 'number', key: 'valor', label: 'Valor', description: 'Em reais.', validate: { required: true } },
        { type: 'checkbox', key: 'aceite', label: 'Aceite', description: 'Leia antes.' },
        { type: 'radio', key: 'tipo', label: 'Tipo', description: 'Escolha um.', options: [{ value: 'a', label: 'A' }] },
        { type: 'checklist', key: 'docs', label: 'Documentos', description: 'Os que tiver.', options: [{ value: 'rg', label: 'RG' }] },
        { type: 'computed', key: 'total', label: 'Total', description: 'Calculado.', expression: path('valor') },
        { type: 'group', key: 'endereco', label: 'Endereço', description: 'Onde mora.', components: [{ type: 'text', key: 'cep', label: 'CEP' }] },
        { type: 'dynamicList', key: 'socios', label: 'Sócios', description: 'Um por linha.', components: [{ type: 'text', key: 's', label: 'Sócio' }] },
        { type: 'file', key: 'contrato', label: 'Contrato', description: 'Em PDF.' },
      ],
    };
    const { user } = await renderForm({ document: help });
    const hints = (element: Element) => (element.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent?.trim());

    expect(hints(screen.getByRole('textbox', { name: 'Nome' }))).toEqual(['Como no documento.']);
    expect(hints(screen.getByRole('checkbox', { name: 'Aceite' }))).toEqual(['Leia antes.']);
    expect(hints(screen.getByRole('group', { name: 'Tipo' }))).toEqual(['Escolha um.']);
    expect(hints(screen.getByRole('group', { name: 'Documentos' }))).toEqual(['Os que tiver.']);
    expect(hints(screen.getByRole('textbox', { name: 'Total' }))).toEqual(['Calculado.']);
    expect(hints(screen.getByRole('group', { name: 'Endereço' }))).toEqual(['Onde mora.']);
    expect(hints(screen.getByRole('group', { name: 'Sócios' }))).toEqual(['Um por linha.']);
    expect(screen.getByText('Em PDF.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    expect(hints(screen.getByRole('textbox', { name: 'Valor' }))).toEqual(['Em reais.', 'Preencha este campo.']); // the hint, then the error
    await expectNoAxeViolations();
  });

  it('reveals conditional fields and requires them as the server does', async () => {
    const { user } = await renderForm();

    await user.click(screen.getByRole('radio', { name: 'Pessoa física' }));
    const cpf = screen.getByRole('textbox', { name: 'CPF' });
    expect(cpf.getAttribute('aria-required')).toBe('true');
    expect(cpf.getAttribute('placeholder')).toBe('000.000.000-00');

    await user.type(cpf, '529.982.247-24');
    await user.tab();
    expect(screen.getByText('CPF inválido.')).toBeTruthy();
    expect(cpf.getAttribute('aria-invalid')).toBe('true');

    await user.click(screen.getByRole('radio', { name: 'Pessoa jurídica' }));
    expect(screen.queryByRole('textbox', { name: 'CPF' })).toBeNull();
  });

  it('recomputes computed fields as the user types', async () => {
    const { user } = await renderForm();

    await user.type(screen.getByRole('textbox', { name: 'Quantidade' }), '3');
    await user.type(screen.getByRole('textbox', { name: 'Preço unitário' }), '0,1');

    expect((screen.getByRole('textbox', { name: 'Total' }) as HTMLInputElement).value).toBe('0,3');
  });

  it('shows a client error only after the field is left', async () => {
    const { user } = await renderForm();

    await user.type(screen.getByRole('textbox', { name: 'Quantidade' }), '0');
    expect(screen.queryByText('O valor mínimo é 1.')).toBeNull();

    await user.tab();
    expect(screen.getByText('O valor mínimo é 1.')).toBeTruthy();
  });

  it('emits only what the server should get, with exact numbers and offsets', async () => {
    const { host, user } = await renderForm({ prefill: { protocolo: 'P-1' } });
    await fillValidForm(user);
    await user.type(screen.getByRole('textbox', { name: 'Quantidade' }), '1234567890123456789');
    await user.type(screen.getByRole('textbox', { name: 'Preço unitário' }), '0,01');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Modalidade' }), 'giro');
    await user.click(screen.getByRole('checkbox', { name: 'RG' }));
    fireEvent.input(screen.getByLabelText('Início'), { target: { value: '2026-10-20' } });
    fireEvent.input(screen.getByLabelText('Reunião'), { target: { value: '2026-10-20T14:30' } });
    await user.click(screen.getByRole('button', { name: 'Adicionar linha' }));
    await user.type(screen.getByRole('textbox', { name: 'Nome' }), 'Bruno');

    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    expect(host.sent).toHaveLength(1);
    const { data, json } = host.sent[0];
    expect(Object.keys(data)).toEqual([
      'tipo',
      'cpf',
      'quantidade',
      'preco',
      'aceite',
      'modalidade',
      'documentos',
      'observacoes',
      'inicio',
      'horario',
      'reuniao',
      'contrato',
      'endereco',
      'socios',
    ]);
    expect([data['observacoes'], data['horario'], data['contrato']]).toEqual([null, null, null]); // left empty: sent as null (card #86)
    expect((data['quantidade'] as Num).toFixed()).toBe('1234567890123456789');
    expect(json).toContain('"quantidade":1234567890123456789,"preco":0.01');
    expect(data['reuniao']).toMatch(/^2026-10-20T14:30:00[+-]\d{2}:\d{2}$/);
    expect(data['documentos']).toEqual(['rg']);
    expect(data['endereco']).toEqual({ cep: '01310-100' });
    expect(data['socios']).toEqual([{ nome: 'Bruno' }]);
    expect(JSON.parse(json)['aceite']).toBe(true);
  });

  it('sends an unchecked box, a cleared text and a cleared choice as null, so the server clears them (card #86)', async () => {
    const { host, user } = await renderForm({
      document: {
        schemaVersion: 1,
        components: [
          { type: 'checkbox', key: 'aceite', label: 'Aceite' },
          { type: 'textarea', key: 'observacoes', label: 'Observações' },
          { type: 'select', key: 'modalidade', label: 'Modalidade', options: [{ value: 'giro', label: 'Capital de giro' }] },
          { type: 'text', key: 'protocolo', label: 'Protocolo', readOnly: true },
        ],
      },
      prefill: { aceite: true, observacoes: 'Nada a declarar', modalidade: 'giro', protocolo: 'P-1' },
    });

    await user.click(screen.getByRole('checkbox', { name: 'Aceite' }));
    await user.clear(screen.getByRole('textbox', { name: 'Observações' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Modalidade' }), '');
    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    expect(host.sent).toHaveLength(1);
    expect(JSON.parse(host.sent[0].json)).toEqual({ aceite: null, observacoes: null, modalidade: null });
  });

  it('places server errors on their fields, the rest in an alert, and clears a field error when edited', async () => {
    const { host, user, view } = await renderForm({ prefill: { socios: [{ nome: 'Bruno' }, { nome: 'Carla' }] } });

    host.errors.set([
      { key: 'endereco.cep', code: 'invalid_format' },
      { key: 'socios[1].nome', code: 'too_long' },
      { key: '', code: 'payload_too_large' },
    ]);
    view.fixture.detectChanges();
    await view.fixture.whenStable();

    const cep = screen.getByRole('textbox', { name: 'CEP' });
    expect(cep.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('CEP inválido.')).toBeTruthy();
    const names = screen.getAllByRole('textbox', { name: 'Nome' });
    expect(names[1].getAttribute('aria-invalid')).toBe('true');
    expect(names[0].getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByRole('link', { name: 'CEP: CEP inválido.' })).toBeTruthy();
    expect(screen.getByText('Os dados passam de 256 KB.')).toBeTruthy();

    await user.type(cep, '01310-100');
    expect(cep.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('CEP inválido.')).toBeNull();
  });

  it('shows server errors it cannot place in an alert', async () => {
    const { host, view } = await renderForm();

    host.errors.set([{ key: '', code: 'unexpected_data' }]);
    view.fixture.detectChanges();
    await view.fixture.whenStable();

    expect(screen.getByText('Este passo não recebe dados.')).toBeTruthy();
  });

  it('says which text the server cannot store: at its field, or for the whole submission (card #155)', async () => {
    const { host, view } = await renderForm();

    host.errors.set([
      { key: 'observacoes', code: 'invalid_value' },
      { key: '', code: 'invalid_value' },
    ]);
    view.fixture.detectChanges();
    await view.fixture.whenStable();

    expect(screen.getByRole('textbox', { name: 'Observações' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Este campo tem caracteres que não podem ser guardados.')).toBeTruthy();
    expect(screen.getByText('Os dados têm caracteres que não podem ser guardados.')).toBeTruthy();
  });

  it('moves the focus with list rows and limits them', async () => {
    const { user } = await renderForm();
    const add = screen.getByRole('button', { name: 'Adicionar linha' });

    await user.click(add);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Nome' }));
    expect(screen.getByRole('group', { name: 'Sócios, linha 1' })).toBeTruthy();

    await user.click(add);
    expect((add as HTMLButtonElement).disabled).toBe(true); // maxRows 2

    await user.click(screen.getByRole('button', { name: 'Remover linha 1' }));
    expect(screen.queryByRole('group', { name: 'Sócios, linha 2' })).toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it('follows the summary links to the fields', async () => {
    const { user } = await renderForm();
    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    await user.click(await screen.findByRole('link', { name: 'CEP: Preencha este campo.' }));

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'CEP' }));
  });

  it('keeps values readable but not editable while disabled', async () => {
    const { host, view } = await renderForm({ prefill: { observacoes: 'Nada a declarar' } });

    host.disabled.set(true);
    view.fixture.detectChanges();
    await view.fixture.whenStable();

    const notes = screen.getByRole('textbox', { name: 'Observações' }) as HTMLTextAreaElement;
    expect(notes.value).toBe('Nada a declarar');
    expect(notes.closest('fieldset')?.disabled).toBe(true);
  });

  describe('file fields (F3, "File fields")', () => {
    const CONTRATO: FormDocument = { schemaVersion: 1, components: [{ type: 'file', key: 'contrato', label: 'Contrato', validate: { required: true } }] };
    const pdf = (name: string) => new File(['%PDF-1.4'], name, { type: 'application/pdf' });
    const stored = (id: string, name: string): FieldFile => ({ fileId: id, name, size: '8', contentType: 'application/pdf' });

    it('uploads each file chosen, lists it with its size and a link to it, sends its id, and removes it', async () => {
      let next = 0;
      const uploads: FileUploads = { upload: (file) => of({ fileId: `f-${++next}`, name: file.name, size: String(file.size), contentType: file.type }) };
      const { host, user } = await renderForm({ document: CONTRATO }, uploads);

      await user.upload(screen.getByLabelText('Contrato'), pdf('contrato.pdf'));
      expect(screen.getByRole('link', { name: 'contrato.pdf' }).getAttribute('href')).toBe('/api/files/f-1');
      expect(screen.getByText('8 bytes')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Concluir' }));
      expect(host.sent.map((submission) => submission.data)).toEqual([{ contrato: [{ fileId: 'f-1' }] }]);

      await user.click(screen.getByRole('button', { name: 'Remover contrato.pdf' }));
      expect(screen.queryByRole('link', { name: 'contrato.pdf' })).toBeNull();
      expect(document.activeElement).toBe(screen.getByLabelText('Contrato'));
      await user.click(screen.getByRole('button', { name: 'Concluir' }));
      expect(host.sent).toHaveLength(1); // required: nothing more sent
    });

    it('holds the submit back while a file uploads, and shows the refusal of another', async () => {
      const answers = new Map<string, Subject<FieldFile>>();
      const uploads: FileUploads = {
        upload: (file) => {
          answers.set(file.name, new Subject<FieldFile>());
          return answers.get(file.name)!;
        },
      };
      const { host, user } = await renderForm({ document: CONTRATO }, uploads);

      await user.upload(screen.getByLabelText('Contrato'), [pdf('contrato.pdf'), pdf('virus.exe')]);
      expect(screen.getByText('Enviando contrato.pdf…')).toBeTruthy();
      answers.get('virus.exe')!.error('Tipo de arquivo não permitido.');
      await settle();
      expect(screen.getByText('virus.exe: Tipo de arquivo não permitido.')).toBeTruthy();
      expect(screen.queryByText('Enviando virus.exe…')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Concluir' }));
      expect(host.sent).toEqual([]);
      expect(screen.getByRole('link', { name: 'Contrato: Aguarde o fim do envio dos arquivos.' })).toBeTruthy();

      answers.get('contrato.pdf')!.next(stored('f-1', 'contrato.pdf'));
      answers.get('contrato.pdf')!.complete();
      await settle();
      await user.click(screen.getByRole('button', { name: 'Concluir' }));
      expect(host.sent.map((submission) => submission.data)).toEqual([{ contrato: [{ fileId: 'f-1' }] }]);
    });

    it('stops an upload on Cancelar', async () => {
      const answer = new Subject<FieldFile>();
      const { user } = await renderForm({ document: CONTRATO }, { upload: () => answer });

      await user.upload(screen.getByLabelText('Contrato'), pdf('contrato.pdf'));
      expect(answer.observed).toBe(true);
      await user.click(screen.getByRole('button', { name: 'Cancelar o envio de contrato.pdf' }));

      expect(answer.observed).toBe(false);
      expect(screen.queryByText('Enviando contrato.pdf…')).toBeNull();
      expect(document.activeElement).toBe(screen.getByLabelText('Contrato'));
    });

    it('stops its uploads when the form goes away, as when a page switches tasks', async () => {
      const answer = new Subject<FieldFile>();
      const { view, user } = await renderForm({ document: CONTRATO }, { upload: () => answer });

      await user.upload(screen.getByLabelText('Contrato'), pdf('contrato.pdf'));
      view.fixture.destroy();

      expect(answer.observed).toBe(false);
    });

    it('puts a file in the row it was chosen in, even when a row above is removed while it uploads', async () => {
      const answer = new Subject<FieldFile>();
      const { host, user } = await renderForm(
        {
          document: {
            schemaVersion: 1,
            components: [
              {
                type: 'dynamicList',
                key: 'socios',
                label: 'Sócios',
                components: [
                  { type: 'text', key: 'nome', label: 'Nome' },
                  { type: 'file', key: 'documento', label: 'Documento' },
                ],
              },
            ],
          },
          prefill: { socios: [{ nome: 'Ana' }, { nome: 'Bruno' }] },
        },
        { upload: () => answer },
      );

      await user.upload(screen.getAllByLabelText('Documento')[1], pdf('bruno.pdf'));
      await user.click(screen.getByRole('button', { name: 'Remover linha 1' }));
      answer.next(stored('f-1', 'bruno.pdf'));
      answer.complete();
      await settle();
      await user.click(screen.getByRole('button', { name: 'Concluir' }));

      expect(host.sent.map((submission) => submission.data)).toEqual([{ socios: [{ nome: 'Bruno', documento: [{ fileId: 'f-1' }] }] }]);
    });

    it('lists the prefilled files and sends them back unchanged', async () => {
      const { host, user } = await renderForm(
        { document: CONTRATO, prefill: { contrato: [{ fileId: 'f-9', name: 'anterior.pdf', size: 1258291, contentType: 'application/pdf' }] } },
        { upload: () => of(stored('never', 'never.pdf')) },
      );
      expect(screen.getByRole('link', { name: 'anterior.pdf' })).toBeTruthy();
      expect(screen.getByText('1,2 MB')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Concluir' }));
      expect(host.sent.map((submission) => submission.data)).toEqual([{ contrato: [{ fileId: 'f-9' }] }]);
    });
  });
});
