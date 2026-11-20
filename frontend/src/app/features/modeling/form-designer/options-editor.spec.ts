import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { FieldOption } from '../../../forms/model';
import { OptionsChange, OptionsEditor } from './options-editor';

describe('OptionsEditor: Opções (form-designer.md §8.1, N3d)', () => {
  async function open(options: readonly FieldOption[], follows?: readonly boolean[]) {
    const changes: OptionsChange[] = [];
    const view = await render(OptionsEditor, {
      inputs: { options, follows },
      on: { changed: (change: OptionsChange) => changes.push(change) },
    });
    const apply = async (change: OptionsChange) => {
      view.fixture.componentRef.setInput('options', change.options);
      view.fixture.componentRef.setInput('follows', change.follows);
      view.fixture.detectChanges();
    };
    return { changes, apply, last: () => changes[changes.length - 1] };
  }
  const row = (n: number) => within(screen.getByRole('group', { name: `Opção ${n}` }));

  it("gives a new option's value from its label until the value is edited", async () => {
    const { last, apply } = await open(
      [
        { value: 'opcao_1', label: 'Opção 1' },
        { value: 'opcao_2', label: 'Opção 2' },
      ],
      [true, true],
    );
    const user = userEvent.setup();

    await user.clear(row(1).getByRole('textbox', { name: 'Rótulo' }));
    await user.type(row(1).getByRole('textbox', { name: 'Rótulo' }), 'Pessoa física');
    await user.tab();
    expect(last().options[0]).toEqual({ value: 'pessoa_fisica', label: 'Pessoa física' });
    await apply(last());

    await user.clear(row(2).getByRole('textbox', { name: 'Valor' }));
    await user.type(row(2).getByRole('textbox', { name: 'Valor' }), 'PJ');
    await user.tab();
    expect(last()).toEqual({ options: [{ value: 'pessoa_fisica', label: 'Pessoa física' }, { value: 'PJ', label: 'Opção 2' }], follows: [true, false] });
    await apply(last());

    await user.clear(row(2).getByRole('textbox', { name: 'Rótulo' }));
    await user.type(row(2).getByRole('textbox', { name: 'Rótulo' }), 'Pessoa jurídica');
    await user.tab();
    expect(last().options[1]).toEqual({ value: 'PJ', label: 'Pessoa jurídica' }); // an edited value stays
  });

  it('keeps the values of options that were loaded', async () => {
    const { last } = await open([{ value: 'pf', label: 'PF' }]);
    const user = userEvent.setup();

    await user.type(row(1).getByRole('textbox', { name: 'Rótulo' }), ' ou física');
    await user.tab();

    expect(last().options[0]).toEqual({ value: 'pf', label: 'PF ou física' });
  });

  it('adds, moves and removes options, and never removes the last one', async () => {
    const { last, apply } = await open([{ value: 'a', label: 'A' }]);
    const user = userEvent.setup();
    expect(row(1).getByRole('button', { name: 'Remover a opção A' }).hasAttribute('disabled')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Adicionar opção' }));
    expect(last()).toEqual({ options: [{ value: 'a', label: 'A' }, { value: 'opcao_2', label: 'Opção 2' }], follows: [false, true] });
    await apply(last());

    await user.click(row(2).getByRole('button', { name: 'Mover a opção Opção 2 para cima' }));
    expect(last().options.map((option) => option.value)).toEqual(['opcao_2', 'a']);
    expect(last().follows).toEqual([true, false]);
    await apply(last());

    await user.click(row(1).getByRole('button', { name: 'Remover a opção Opção 2' }));
    expect(last()).toEqual({ options: [{ value: 'a', label: 'A' }], follows: [false] });
  });

  it('shows FM003 when values repeat', async () => {
    await open([
      { value: 'a', label: 'A' },
      { value: 'a', label: 'B' },
    ]);

    expect(screen.getByText('Dê de 1 a 200 opções, sem valores repetidos.')).toBeTruthy();
  });
});
