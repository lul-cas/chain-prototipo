import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { CatalogEntry } from '../editor/conditions';
import { ExpressionDialog } from './expression-dialog';

const CATALOG: CatalogEntry[] = [
  { path: ['quantidade'], type: 'number', presence: 'optional', sources: ['Este formulário'] },
  { path: ['parcela'], type: 'number', presence: 'optional', sources: ['Este formulário'] },
];

describe('ExpressionDialog (form-designer.md §12.6)', () => {
  async function open(expression: unknown) {
    const close = vi.fn();
    await render(ExpressionDialog, {
      providers: [
        { provide: DIALOG_DATA, useValue: { title: 'Expressão de Total', expression, catalog: CATALOG } },
        { provide: DialogRef, useValue: { close, id: 'expression' } },
      ],
    });
    return { close, user: userEvent.setup() };
  }

  it('shows the text form and the type, and applies a tree the parser accepts (FM007)', async () => {
    const { close, user } = await open({ kind: 'arithmetic', op: 'multiply', left: { kind: 'path', path: ['quantidade'] }, right: null });

    expect(screen.getByText('Produz: número')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText('Complete a expressão.')).toBeTruthy();

    const second = within(screen.getByRole('group', { name: 'Segundo termo' }));
    await user.selectOptions(second.getByRole('combobox', { name: 'Segundo termo: forma' }), 'Dado');
    await user.selectOptions(second.getByRole('combobox', { name: 'Dado' }), 'parcela (número)');
    expect(screen.getByTestId('expression-text').textContent?.trim()).toBe('(data.quantidade × data.parcela)');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    expect(close).toHaveBeenCalledWith({
      json: { kind: 'arithmetic', op: 'multiply', left: { kind: 'path', path: ['quantidade'] }, right: { kind: 'path', path: ['parcela'] } },
    });
  });
});
