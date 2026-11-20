import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { FormsPage } from './forms-page';

@Component({ template: '<h1>Designer</h1>' })
class Designer {}

const FORMS = [
  { id: 'f-1', name: 'Proposta de crédito', description: 'Dados do cliente', latestVersion: 2, draftUpdatedAt: '2026-10-17T12:00:00Z' },
  { id: 'f-2', name: 'Abertura de conta', description: null, latestVersion: null, draftUpdatedAt: '2026-10-16T09:30:00Z' },
];

describe('FormsPage (form-designer.md §12.1, N3a)', () => {
  let backend: HttpTestingController;

  async function open(forms: unknown[] = FORMS): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'formularios', component: FormsPage },
          { path: 'formularios/:id', component: Designer },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/formularios');
    backend.expectOne({ method: 'GET', url: '/api/forms' }).flush(forms);
    await settle();
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve));

  afterEach(() => backend.verify());

  it('lists the forms by name, with their version and draft facts', async () => {
    await open();

    const links = screen.getAllByRole('link').map((link) => [link.textContent?.trim(), link.getAttribute('href')]);
    expect(links).toEqual([
      ['Abertura de conta', '/formularios/f-2'],
      ['Proposta de crédito', '/formularios/f-1'],
    ]);
    expect(screen.getByText('Nunca publicado')).toBeTruthy();
    expect(screen.getByText('Versão 2')).toBeTruthy();
    expect(screen.getByText('Dados do cliente')).toBeTruthy();
  });

  it('filters by name as you type', async () => {
    await open();
    const user = userEvent.setup();

    await user.type(screen.getByRole('searchbox', { name: 'Buscar formulários' }), 'propos');

    expect(screen.getAllByRole('link').map((link) => link.textContent?.trim())).toEqual(['Proposta de crédito']);
    await user.clear(screen.getByRole('searchbox', { name: 'Buscar formulários' }));
    await user.type(screen.getByRole('searchbox', { name: 'Buscar formulários' }), 'nada');
    expect(screen.getByText('Nenhum formulário com esse nome.')).toBeTruthy();
  });

  it('says so when there are no forms yet', async () => {
    await open([]);

    expect(screen.getByText('Nenhum formulário ainda. Crie o primeiro com “Novo formulário”.')).toBeTruthy();
  });

  it('creates a form and opens it, and says when the name is taken', async () => {
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Novo formulário' }));
    await user.click(screen.getByRole('button', { name: 'Criar' }));
    expect(screen.getByText('Informe o nome.')).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: /Nome/ }), 'Proposta de crédito');
    await user.click(screen.getByRole('button', { name: 'Criar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/forms' })
      .flush({ type: 'about:blank', title: 'Taken', status: 409, code: 'form_name_taken' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(screen.getByText('Já existe um formulário com este nome.')).toBeTruthy();

    await user.clear(screen.getByRole('textbox', { name: /Nome/ }));
    await user.type(screen.getByRole('textbox', { name: /Nome/ }), 'Cadastro PJ');
    await user.click(screen.getByRole('button', { name: 'Criar' }));
    const request = backend.expectOne({ method: 'POST', url: '/api/forms' });
    expect(request.request.body).toEqual({ name: 'Cadastro PJ', description: null });
    request.flush({ ...FORMS[0], id: 'f-9', name: 'Cadastro PJ', version: 1, draft: { schemaVersion: 1, components: [] } }, { status: 201, statusText: 'Created' });
    await settle();

    expect(TestBed.inject(Router).url).toBe('/formularios/f-9');
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      await open();
      await expectNoAxeViolations();
    });
  });
});
