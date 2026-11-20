import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { FormVersionsPanel } from './form-versions-panel';

const DOCUMENT = { schemaVersion: 1, components: [{ type: 'number', key: 'valor', label: 'Valor', validate: { required: true } }] };

describe('FormVersionsPanel: Versões (form-designer.md §9.7, N3g)', () => {
  let backend: HttpTestingController;
  let close: ReturnType<typeof vi.fn>;
  const settle = () => new Promise((resolve) => setTimeout(resolve));

  beforeEach(async () => {
    close = vi.fn();
    await render(FormVersionsPanel, {
      providers: [
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
        { provide: DIALOG_DATA, useValue: { formId: 'f-1' } },
        { provide: DialogRef, useValue: { close, id: 'versions' } },
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    backend.expectOne({ method: 'GET', url: '/api/forms/f-1/versions' }).flush([
      { versionNumber: 1, contentHash: 'a', publishedAt: '2026-10-01T12:00:00Z', publishedBy: 'u' },
      { versionNumber: 2, contentHash: 'b', publishedAt: '2026-10-02T12:00:00Z', publishedBy: 'u' },
    ]);
    await settle();
  });

  afterEach(() => backend.verify());

  it('lists the versions newest first, each with its three actions', () => {
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => within(item).getByRole('strong').textContent)).toEqual(['Versão 2', 'Versão 1']);
    expect(within(items[0]).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Visualizar a versão 2',
      'Testar a versão 2',
      'Restaurar a versão 2 no rascunho',
    ]);
  });

  it('closes with the version to restore', async () => {
    await userEvent.setup().click(screen.getByRole('button', { name: 'Restaurar a versão 1 no rascunho' }));

    expect(close).toHaveBeenCalledWith({ restore: 1 });
  });

  it('tests a version on the server: its errors on their fields, or the values it would store', async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Testar a versão 2' }));
    backend.expectOne({ method: 'GET', url: '/api/forms/f-1/versions/2' }).flush({ versionNumber: 2, contentHash: 'b', publishedAt: 'x', document: DOCUMENT });
    await settle();
    const dialog = within(screen.getByRole('dialog', { name: 'Testar a versão 2' }));

    await user.type(dialog.getByRole('textbox', { name: /Valor/ }), '5000');
    await user.click(dialog.getByRole('button', { name: 'Testar no servidor' }));
    const test = backend.expectOne({ method: 'POST', url: '/api/forms/f-1/versions/2/validate-submission' });
    expect(JSON.parse(test.request.body)).toEqual({ valor: 5000 });
    test.flush({ valid: false, errors: [{ key: 'valor', code: 'out_of_range' }], values: {} });
    await settle();
    expect(dialog.getByText('O servidor recusaria o envio.')).toBeTruthy();

    await user.clear(dialog.getByRole('textbox', { name: /Valor/ }));
    await user.type(dialog.getByRole('textbox', { name: /Valor/ }), '10');
    await user.click(dialog.getByRole('button', { name: 'Testar no servidor' }));
    backend.expectOne('/api/forms/f-1/versions/2/validate-submission').flush({ valid: true, errors: [], values: { valor: 10 } });
    await settle();
    expect(dialog.getByText('O servidor guardaria:')).toBeTruthy();
    expect(dialog.getByLabelText('Valores que o servidor guardaria').textContent).toContain('"valor": 10');
  });

  it('shows a version read-only', async () => {
    await userEvent.setup().click(screen.getByRole('button', { name: 'Visualizar a versão 1' }));
    backend.expectOne({ method: 'GET', url: '/api/forms/f-1/versions/1' }).flush({ versionNumber: 1, contentHash: 'a', publishedAt: 'x', document: DOCUMENT });
    await settle();

    const dialog = within(screen.getByRole('dialog', { name: 'Versão 1' }));
    expect(dialog.getByRole('textbox', { name: /Valor/ }).closest('fieldset')!.disabled).toBe(true); // the renderer disables its fieldset
  });
});
