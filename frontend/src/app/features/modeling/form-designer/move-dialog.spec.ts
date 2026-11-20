import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { fromDocument } from './form-edits';
import { MoveDialog } from './move-dialog';

const DOCUMENT = fromDocument(
  {
    schemaVersion: 1,
    components: [
      { type: 'text', key: 'nome', label: 'Nome' },
      {
        type: 'group',
        key: 'endereco',
        label: 'Endereço',
        components: [
          { type: 'text', key: 'cep', label: 'CEP' },
          { type: 'dynamicList', key: 'telefones', label: 'Telefones', components: [{ type: 'text', key: 'numero', label: 'Número' }] },
        ],
      },
    ],
  },
  (() => {
    let n = 0;
    return () => `n${++n}`;
  })(),
);
// n1 nome, n2 endereco, n3 cep, n4 telefones, n5 numero

describe('MoveDialog: Mover para… (form-designer.md §7.2)', () => {
  async function open(id: string) {
    const close = vi.fn();
    await render(MoveDialog, {
      providers: [
        { provide: DIALOG_DATA, useValue: { document: DOCUMENT, id } },
        { provide: DialogRef, useValue: { close, id: 'move' } },
      ],
    });
    return close;
  }

  it('offers the form and every group or list, and closes with the chosen place', async () => {
    const close = await open('n1');
    const user = userEvent.setup();

    const to = screen.getByRole('combobox', { name: 'Para' });
    expect(Array.from((to as HTMLSelectElement).options).map((option) => option.text)).toEqual(['Formulário', '— Endereço', '— — Telefones']);
    await user.selectOptions(to, '— Endereço');
    const position = screen.getByRole('combobox', { name: 'Posição' });
    expect(Array.from((position as HTMLSelectElement).options).map((option) => option.text)).toEqual(['1', '2', '3 (no fim)']);
    await user.selectOptions(position, '1');
    await user.click(screen.getByRole('button', { name: 'Mover' }));

    expect(close).toHaveBeenCalledWith({ parent: 'n2', index: 0 });
  });

  it('starts at the end of the current container, and never offers the moved group or what it holds', async () => {
    const close = await open('n2');
    const user = userEvent.setup();

    const to = screen.getByRole('combobox', { name: 'Para' }) as HTMLSelectElement;
    expect(Array.from(to.options).map((option) => option.text)).toEqual(['Formulário']);
    expect(Array.from((screen.getByRole('combobox', { name: 'Posição' }) as HTMLSelectElement).options).map((option) => option.text)).toEqual(['1', '2 (no fim)']);
    await user.click(screen.getByRole('button', { name: 'Mover' }));

    expect(close).toHaveBeenCalledWith({ parent: null, index: 1 });
  });
});
