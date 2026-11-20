import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { FormDocument } from '../../../forms/model';
import { FillPreviewDialog } from './fill-preview-dialog';

const DOCUMENT: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'text', key: 'nome', label: 'Nome' },
    {
      type: 'text',
      key: 'cnpj',
      label: 'CNPJ',
      visibleWhen: { kind: 'compare', left: { kind: 'path', path: ['cliente', 'tipo'] }, operator: 'equals', right: { kind: 'literal', type: 'text', value: 'pj' } },
    },
  ],
};

describe('FillPreviewDialog: Dados do pedido (form-designer.md §9.5, N3e)', () => {
  beforeEach(async () => {
    await render(FillPreviewDialog, {
      providers: [
        { provide: DIALOG_DATA, useValue: { name: 'Proposta', document: DOCUMENT, problems: [] } },
        { provide: DialogRef, useValue: { close: vi.fn(), id: 'preview' } },
      ],
    });
  });

  it("lets conditions read the request's data given as a JSON object", async () => {
    const user = userEvent.setup();
    expect(screen.queryByRole('textbox', { name: 'CNPJ' })).toBeNull();

    await user.click(screen.getByText('Dados do pedido'));
    const data = screen.getByRole('textbox', { name: 'Dados do pedido (JSON)' });
    await user.type(data, '{{"cliente": {{"tipo": "pj"}}');
    await user.tab();

    expect(screen.getByRole('textbox', { name: 'CNPJ' })).toBeTruthy();
  });

  it('says what is wrong with data that are not a JSON object, and keeps the form as it was', async () => {
    const user = userEvent.setup();
    await user.click(screen.getByText('Dados do pedido'));

    await user.type(screen.getByRole('textbox', { name: 'Dados do pedido (JSON)' }), '[[1, 2]'); // [[ types one [
    await user.tab();

    expect(screen.getByText('Use um objeto JSON, como {"cliente": {"tipo": "pj"}}.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Nome' })).toBeTruthy();
  });
});
