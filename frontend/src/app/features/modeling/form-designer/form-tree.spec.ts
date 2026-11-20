import { Component, inject, viewChild } from '@angular/core';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { FormDocument } from '../../../forms/model';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { FormDraftEditor } from './form-draft-editor';
import { FormTree } from './form-tree';

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

@Component({
  imports: [FormTree],
  providers: [FormDraftEditor],
  template: `<chain-form-tree [problems]="problems" (properties)="opened = $event" />`,
})
class Host {
  readonly editor = inject(FormDraftEditor);
  readonly tree = viewChild.required(FormTree);
  problems: ReadonlySet<string> = new Set(['endereco.rua']);
  opened: string | null = null;
}

describe('FormTree: the form column (form-designer.md §7.1, §7.2)', () => {
  async function open(document: FormDocument = SAVED) {
    const view = await render(Host);
    const host = view.fixture.componentInstance;
    host.editor.load(document);
    view.fixture.detectChanges();
    return { view, host, editor: host.editor };
  }
  const item = (name: RegExp | string) => screen.getByRole('treeitem', { name });
  const focused = () => document.activeElement?.getAttribute('aria-label');
  const keys = (editor: FormDraftEditor) => editor.saveable().components.map((component) => component.key ?? component.type);

  it('is a tree of the components, with their levels, places, names and problems', async () => {
    await open();

    const tree = screen.getByRole('tree', { name: 'Formulário' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((element) => element.getAttribute('aria-label'))).toEqual([
      'Dados, título',
      'Nome, campo de texto, chave nome, obrigatório',
      'Endereço, grupo, chave endereco',
      'CEP, campo de texto, chave cep',
      'Rua, campo de texto, chave rua, com problema',
      'Valor, número, chave valor',
    ]);
    expect(item(/^Endereço/).getAttribute('aria-expanded')).toBe('true');
    expect(item(/^CEP/).getAttribute('aria-level')).toBe('2');
    expect(item(/^Valor/).getAttribute('aria-level')).toBe('1');
    expect([item(/^Valor/).getAttribute('aria-posinset'), item(/^Valor/).getAttribute('aria-setsize')]).toEqual(['4', '4']);
    expect(item(/^Rua/).getAttribute('data-path')).toBe('endereco.rua');
    expect(items.filter((element) => element.tabIndex === 0)).toEqual([items[0]]); // one tab stop
  });

  it('selects a component by click, and the selection follows the focus', async () => {
    const { editor } = await open();
    const user = userEvent.setup();

    await user.click(within(item(/^CEP/)).getByText('CEP'));

    expect(editor.selection()).toBe(editor.document().components[2].components![0].id);
    expect(item(/^CEP/).getAttribute('aria-selected')).toBe('true');
    expect(focused()).toMatch(/^CEP/);
    expect(item(/^CEP/).tabIndex).toBe(0);
  });

  it('moves the focus with the arrows, Home and End, entering and leaving groups (§7.2)', async () => {
    await open();
    const user = userEvent.setup();
    await user.click(within(item(/^Nome/)).getByText('Nome'));

    await user.keyboard('{ArrowDown}');
    expect(focused()).toMatch(/^Endereço/);
    await user.keyboard('{ArrowDown}');
    expect(focused()).toMatch(/^CEP/); // document order goes through the group
    await user.keyboard('{ArrowLeft}');
    expect(focused()).toMatch(/^Endereço/);
    await user.keyboard('{ArrowRight}');
    expect(focused()).toMatch(/^CEP/);
    await user.keyboard('{End}');
    expect(focused()).toMatch(/^Valor/);
    await user.keyboard('{Home}');
    expect(focused()).toMatch(/^Dados/);
    await user.keyboard('{ArrowUp}');
    expect(focused()).toMatch(/^Dados/); // no wrap
    expect(item(/^Dados/).getAttribute('aria-selected')).toBe('true');
  });

  it('moves the selection with Alt and the arrows, and the focus stays on it', async () => {
    const { editor } = await open();
    const user = userEvent.setup();
    await user.click(within(item(/^Nome/)).getByText('Nome'));

    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(keys(editor)).toEqual(['heading', 'endereco', 'nome', 'valor']);
    expect(focused()).toMatch(/^Nome/);
  });

  it('deletes with Delete or Backspace, focusing the next component, and undoes and redoes with the keyboard', async () => {
    const { editor } = await open();
    const user = userEvent.setup();
    await user.click(within(item(/^Endereço/)).getAllByText('Endereço')[0]);

    await user.keyboard('{Delete}');
    expect(keys(editor)).toEqual(['heading', 'nome', 'valor']);
    expect(focused()).toMatch(/^Valor/);

    await user.keyboard('{Control>}z{/Control}');
    expect(keys(editor)).toEqual(['heading', 'nome', 'endereco', 'valor']);
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(keys(editor)).toEqual(['heading', 'nome', 'valor']);
    await user.keyboard('{Control>}z{/Control}{Control>}y{/Control}');
    expect(keys(editor)).toEqual(['heading', 'nome', 'valor']);

    await user.keyboard('{Backspace}');
    expect(keys(editor)).toEqual(['heading', 'nome']);
  });

  it('clears the selection with Esc, and asks for the properties with Enter or a double click', async () => {
    const { editor, host, view } = await open();
    const user = userEvent.setup();
    await user.click(within(item(/^Valor/)).getByText('Valor'));
    const valor = editor.selection();

    await user.keyboard('{Enter}');
    expect(host.opened).toBe(valor);

    await user.keyboard('{Escape}');
    expect(editor.selection()).toBeNull();
    view.fixture.detectChanges();
    expect(item(/^Valor/).getAttribute('aria-selected')).toBe('false');

    host.opened = null;
    await user.dblClick(within(item(/^CEP/)).getByText('CEP'));
    expect(host.opened).toBe(editor.document().components[2].components![0].id);
  });

  it('focuses a component on request, as after an addition or when a problem is chosen', async () => {
    const { host } = await open();

    host.tree().focus(host.editor.document().components[3].id);
    await new Promise((resolve) => setTimeout(resolve));

    expect(focused()).toMatch(/^Valor/);
  });

  it('says how to start when the form is empty', async () => {
    await open({ schemaVersion: 1, components: [] });

    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByText('O formulário está vazio. Adicione um componente pela paleta.')).toBeTruthy();
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe, with a selection', async () => {
      const { editor, view } = await open();
      editor.select(editor.document().components[1].id);
      view.fixture.detectChanges();
      await expectNoAxeViolations();
    });
  });
});
