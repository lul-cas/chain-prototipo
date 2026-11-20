import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { CatalogEntry } from '../editor/conditions';
import { ConditionDialog } from './condition-dialog';

const CATALOG: CatalogEntry[] = [{ path: ['tipo'], type: 'text', presence: 'optional', sources: ['Este formulário'] }];

describe('ConditionDialog (form-designer.md §12.5)', () => {
  async function open(condition: unknown) {
    const close = vi.fn();
    await render(ConditionDialog, {
      providers: [
        { provide: DIALOG_DATA, useValue: { title: 'Mostrar quando', condition, catalog: CATALOG } },
        { provide: DialogRef, useValue: { close, id: 'condition' } },
      ],
    });
    return { close, user: userEvent.setup() };
  }

  it('builds a condition on the form data and applies it as an ADR-0003 tree', async () => {
    const { close, user } = await open(undefined);

    await user.click(screen.getByRole('button', { name: '+ condição' }));
    const row = within(screen.getByRole('group', { name: 'Condição 1' }));
    await user.selectOptions(row.getByRole('combobox', { name: 'Dado' }), 'tipo (texto)');
    await user.selectOptions(row.getByRole('combobox', { name: 'Operador' }), 'igual a');
    await user.type(row.getByRole('textbox', { name: 'Valor' }), 'pj');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    expect(close).toHaveBeenCalledWith({
      json: {
        kind: 'group',
        op: 'and',
        items: [{ kind: 'compare', left: { kind: 'path', path: ['tipo'] }, operator: 'equals', right: { kind: 'literal', type: 'text', value: 'pj' } }],
      },
    });
  });

  it('offers the request data, refuses an incomplete condition, and applies an empty one as no condition', async () => {
    const { close, user } = await open(undefined);
    await user.click(screen.getByRole('button', { name: '+ condição' }));

    expect(screen.getByRole('option', { name: 'Outro dado do pedido…' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText('Complete ou remova as condições incompletas.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remover condição' }));
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(close).toHaveBeenCalledWith({ json: undefined });
  });
});
