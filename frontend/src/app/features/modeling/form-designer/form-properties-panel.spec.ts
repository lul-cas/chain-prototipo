import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { FormDocument } from '../../../forms/model';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { FormDraftEditor } from './form-draft-editor';
import { FormPropertiesPanel } from './form-properties-panel';

const SAVED: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'heading', text: 'Dados' },
    { type: 'text', key: 'nome', label: 'Nome', placeholder: 'Seu nome', validate: { required: true } },
    { type: 'date', key: 'inicio', label: 'Início', validate: { min: { system: 'currentDate' }, required: true } },
    { type: 'group', key: 'endereco', label: 'Endereço', components: [{ type: 'text', key: 'cep', label: 'CEP' }] },
  ],
};

describe('FormPropertiesPanel: Geral and Obrigatório (form-designer.md §8, N3b-4)', () => {
  async function open(index: number, published = false, document: FormDocument = SAVED) {
    const editor = new FormDraftEditor();
    editor.load(document);
    const id = editor.document().components[index].id;
    const view = await render(FormPropertiesPanel, {
      providers: [
        { provide: DIALOG_DATA, useValue: { editor, id, published } },
        { provide: DialogRef, useValue: { close: vi.fn(), id: 'props' } },
      ],
    });
    const saved = () => editor.saveable().components[index];
    return { editor, view, saved };
  }
  const field = (name: RegExp) => screen.getByRole('textbox', { name });

  it('edits the label, the key and the example text, each as one change when its field loses the focus', async () => {
    const { editor, saved } = await open(1);
    const user = userEvent.setup();

    expect(screen.getByRole('heading', { name: 'Campo de texto: Nome' })).toBeTruthy();
    await user.clear(field(/Rótulo do campo/));
    await user.type(field(/Rótulo do campo/), 'Nome completo');
    expect(saved().label).toBe('Nome'); // not yet
    await user.tab();
    expect(saved()).toMatchObject({ label: 'Nome completo', key: 'nome' }); // a loaded key stays

    await user.clear(field(/Texto de exemplo/));
    await user.type(field(/Texto de exemplo/), 'Como no documento');
    await user.tab();
    expect(saved().placeholder).toBe('Como no documento');

    await user.clear(field(/Chave/));
    await user.type(field(/Chave/), 'nome_completo');
    await user.tab();
    expect(saved().key).toBe('nome_completo');

    editor.undo();
    expect(saved().key).toBe('nome');
  });

  it('refuses to clear the label (FD16) and shows the key problems as they are typed (FM001, FM002)', async () => {
    const { saved } = await open(1);
    const user = userEvent.setup();

    await user.clear(field(/Rótulo do campo/));
    await user.tab();
    expect(saved().label).toBe('Nome');
    expect(screen.getByText('Dê um rótulo ao campo.')).toBeTruthy();
    expect((field(/Rótulo do campo/) as HTMLInputElement).value).toBe('Nome');

    await user.clear(field(/Chave/));
    await user.type(field(/Chave/), '1nome');
    expect(screen.getByText('Dê ao campo uma chave: uma letra seguida de até 63 letras, dígitos ou _.')).toBeTruthy();
    await user.clear(field(/Chave/));
    await user.type(field(/Chave/), 'inicio');
    expect(screen.getByText('Esta chave se repete no mesmo nível.')).toBeTruthy();
  });

  it('warns that renaming a key can break processes once the form is published (§8.2)', async () => {
    await open(1, true);

    expect(screen.getByText('Processos que usam esta chave podem deixar de encontrá-la.')).toBeTruthy();
  });

  it('switches the subtype of a date, clearing the limits that would not fit', async () => {
    const { saved } = await open(2);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Subtipo' }), 'Hora');

    expect(saved()).toEqual({ type: 'time', key: 'inicio', label: 'Início', validate: { required: true } });
  });

  it('toggles read-only and required at once', async () => {
    const { saved } = await open(1);
    const user = userEvent.setup();

    await user.click(screen.getByRole('checkbox', { name: 'Somente leitura' }));
    await user.click(screen.getByRole('checkbox', { name: 'Obrigatório' }));

    expect(saved()).toEqual({ type: 'text', key: 'nome', label: 'Nome', placeholder: 'Seu nome', readOnly: true });
  });

  it('gives a heading its text, and no label or key', async () => {
    const { saved } = await open(0);
    const user = userEvent.setup();
    expect(screen.queryByRole('textbox', { name: /Rótulo/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Chave/ })).toBeNull();

    await user.clear(field(/Texto/));
    await user.type(field(/Texto/), 'Dados pessoais');
    await user.tab();

    expect(saved().text).toBe('Dados pessoais');
  });

  it('edits the description, shown as the field\'s hint, and clears it when emptied (card #234)', async () => {
    const { saved } = await open(3); // a group has one too
    const user = userEvent.setup();

    await user.type(field(/Descrição do campo/), 'Onde a empresa funciona.');
    await user.tab();
    expect(saved().description).toBe('Onde a empresa funciona.');
    expect(screen.getByText('24/500 caracteres')).toBeTruthy();

    await user.clear(field(/Descrição do campo/));
    await user.tab();
    expect(saved()).not.toHaveProperty('description');
  });

  it('flags a description longer than 500 characters (FM012), and gives headings none', async () => {
    const long: FormDocument = { schemaVersion: 1, components: [{ type: 'text', key: 'nome', label: 'Nome', description: 'd'.repeat(501) }] };
    await open(0, false, long);
    expect(screen.getByText('A descrição do campo tem no máximo 500 caracteres; títulos e parágrafos não têm descrição.')).toBeTruthy();
  });

  it('gives a heading no description', async () => {
    await open(0);
    expect(screen.queryByRole('textbox', { name: /Descrição do campo/ })).toBeNull();
  });

  it('gives a group no example text, Somente leitura nor Obrigatório', async () => {
    await open(3);
    expect(screen.getByRole('textbox', { name: /Rótulo do campo/ })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Texto de exemplo/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Obrigatório' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Somente leitura' })).toBeNull();
  });

  it('edits the options of a choice field, whose new values follow their labels (N3d)', async () => {
    const editor = new FormDraftEditor();
    editor.load({ schemaVersion: 1, components: [] });
    const id = editor.add('radio')!;
    await render(FormPropertiesPanel, {
      providers: [
        { provide: DIALOG_DATA, useValue: { editor, id, published: false } },
        { provide: DialogRef, useValue: { close: vi.fn(), id: 'props' } },
      ],
    });
    const user = userEvent.setup();

    const first = within(screen.getByRole('group', { name: 'Opção 1' }));
    await user.clear(first.getByRole('textbox', { name: 'Rótulo' }));
    await user.type(first.getByRole('textbox', { name: 'Rótulo' }), 'Sim');
    await user.tab();
    expect(editor.saveable().components[0].options).toEqual([
      { value: 'sim', label: 'Sim' },
      { value: 'opcao_2', label: 'Opção 2' },
    ]);
    expect(editor.saveable().components[0]).not.toHaveProperty('optionValuesFollow');
  });

  it('edits the rules of Validação, and each change can be undone (N3d)', async () => {
    const { editor, saved } = await open(1);
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox', { name: 'Comprimento máximo' }), '80');
    await user.tab();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Formato' }), 'E-mail');

    expect(saved().validate).toEqual({ required: true, maxLength: 80, format: 'email' });
    editor.undo();
    expect(saved().validate).toEqual({ required: true, maxLength: 80 });
  });

  it('defines, shows and removes a condition with the builder in a dialog (N3e)', async () => {
    const { saved } = await open(2);
    const user = userEvent.setup();
    expect(screen.getByText('Sempre')).toBeTruthy();
    expect(screen.getByText('Sem condição')).toBeTruthy(); // Obrigatório quando, for a date

    await user.click(screen.getByRole('button', { name: 'Definir a condição de Mostrar quando' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Mostrar quando' }));
    await user.click(dialog.getByRole('button', { name: '+ condição' }));
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Dado' }), 'nome (texto)');
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Operador' }), 'não está vazio');
    await user.click(dialog.getByRole('button', { name: 'Aplicar' }));

    expect(saved().visibleWhen).toEqual({
      kind: 'group',
      op: 'and',
      items: [{ kind: 'compare', left: { kind: 'path', path: ['nome'] }, operator: 'isNotEmpty' }],
    });
    expect(screen.queryByText('Sempre')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Remover a condição de Mostrar quando' }));
    expect(saved()).not.toHaveProperty('visibleWhen');
  });

  it("builds a computed field's expression, shows its type, and warns when it reads a later computed field (N3f)", async () => {
    const editor = new FormDraftEditor();
    editor.load({
      schemaVersion: 1,
      components: [
        { type: 'number', key: 'quantidade', label: 'Parcelas' },
        { type: 'computed', key: 'total', label: 'Total', expression: { kind: 'path', path: ['subtotal'] } },
        { type: 'computed', key: 'subtotal', label: 'Subtotal', expression: { kind: 'path', path: ['quantidade'] } },
      ],
    });
    const id = editor.document().components[1].id;
    await render(FormPropertiesPanel, {
      providers: [
        { provide: DIALOG_DATA, useValue: { editor, id, published: false } },
        { provide: DialogRef, useValue: { close: vi.fn(), id: 'props' } },
      ],
    });
    const user = userEvent.setup();
    expect(screen.getByText('Lê «Subtotal», que é calculado depois deste campo. Mova este campo para depois dele.')).toBeTruthy();
    expect(screen.getByText('Produz: tipo desconhecido')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Editar a expressão…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Expressão de Total' }));
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Expressão: forma' }), 'Função');
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Função' }), 'abs: valor absoluto');
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Argumento 1: forma' }), 'Dado');
    await user.selectOptions(dialog.getByRole('combobox', { name: 'Dado' }), 'quantidade (número)');
    await user.click(dialog.getByRole('button', { name: 'Aplicar' }));

    expect(editor.saveable().components[1].expression).toEqual({ kind: 'call', function: 'abs', args: [{ kind: 'path', path: ['quantidade'] }] });
    expect(screen.getByText('Produz: número')).toBeTruthy();
    expect(screen.queryByText(/que é calculado depois/)).toBeNull();
  });

  describe('Sensível (sensitive-data.md §1, N3h)', () => {
    async function openIn(document: FormDocument, index: number, child?: number) {
      const editor = new FormDraftEditor();
      editor.load(document);
      const top = editor.document().components[index];
      const id = child === undefined ? top.id : top.components![child].id;
      await render(FormPropertiesPanel, {
        providers: [
          { provide: DIALOG_DATA, useValue: { editor, id, published: false } },
          { provide: DialogRef, useValue: { close: vi.fn(), id: 'props' } },
        ],
      });
      return editor;
    }
    const FORM: FormDocument = {
      schemaVersion: 1,
      components: [
        { type: 'text', key: 'cpf', label: 'CPF' },
        { type: 'group', key: 'endereco', label: 'Endereço', components: [{ type: 'text', key: 'cep', label: 'CEP' }] },
        { type: 'file', key: 'rg', label: 'RG' },
        { type: 'computed', key: 'prefixo', label: 'Prefixo', expression: { kind: 'path', path: ['cpf'] } },
      ],
    };

    it('marks a top-level field sensitive, and unmarks it', async () => {
      const editor = await openIn(FORM, 0);
      const user = userEvent.setup();

      await user.click(screen.getByRole('checkbox', { name: 'Sensível' }));
      expect(editor.saveable().components[0]).toMatchObject({ sensitive: true });
      await user.click(screen.getByRole('checkbox', { name: 'Sensível' }));
      expect(editor.saveable().components[0]).not.toHaveProperty('sensitive');
    });

    it('is not offered to a nested field', async () => {
      await openIn(FORM, 1, 0);

      expect(screen.queryByRole('checkbox', { name: 'Sensível' })).toBeNull();
    });

    it('is not offered to a file field', async () => {
      await openIn(FORM, 2);

      expect(screen.queryByRole('checkbox', { name: 'Sensível' })).toBeNull();
    });

    it('flags a computed field that reads a sensitive key until it is sensitive too (WF209)', async () => {
      const editor = await openIn({ ...FORM, components: [{ ...FORM.components[0], sensitive: true }, ...FORM.components.slice(1)] }, 3);
      const user = userEvent.setup();
      const warning = 'Este campo lê um dado sensível (cpf). Marque-o como sensível, ou o grupo ou a lista que o contém; senão, um processo que use o formulário não publica (WF209).';
      expect(screen.getByText(warning)).toBeTruthy();

      await user.click(screen.getByRole('checkbox', { name: 'Sensível' }));

      expect(editor.saveable().components[3]).toMatchObject({ sensitive: true });
      expect(screen.queryByText(warning)).toBeNull();
    });
  });

  it('offers no Obrigatório quando to a heading', async () => {
    await open(0);

    expect(screen.getByRole('button', { name: 'Definir a condição de Mostrar quando' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Obrigatório quando/ })).toBeNull();
  });

  it('says so when the component no longer exists, as after an undo', async () => {
    const editor = new FormDraftEditor();
    editor.load(SAVED);
    const id = editor.add('number')!;
    const view = await render(FormPropertiesPanel, {
      providers: [
        { provide: DIALOG_DATA, useValue: { editor, id, published: false } },
        { provide: DialogRef, useValue: { close: vi.fn(), id: 'props' } },
      ],
    });
    expect(screen.getByRole('heading', { name: 'Número: Número' })).toBeTruthy();

    editor.undo();
    view.fixture.detectChanges();

    expect(screen.getByText('Este componente não existe mais.')).toBeTruthy();
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      await open(1, true);
      await expectNoAxeViolations();
    });
  });
});
