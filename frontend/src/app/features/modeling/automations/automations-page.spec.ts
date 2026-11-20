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
import { AutomationsPage } from './automations-page';

@Component({ template: '<h1>Editor</h1>' })
class Designer {}

const FORMS = [
  { id: 'a-1', name: 'Consulta de crédito', description: 'No bureau', latestVersion: 2, draftUpdatedAt: '2026-10-17T12:00:00Z' },
  { id: 'a-2', name: 'Abertura no ERP', description: null, latestVersion: null, draftUpdatedAt: '2026-10-16T09:30:00Z' },
];

describe('AutomationsPage (automation-ui.md §6, AS3)', () => {
  let backend: HttpTestingController;

  async function open(forms: unknown[] = FORMS): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'automacoes', component: AutomationsPage },
          { path: 'automacoes/:id', component: Designer },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/automacoes');
    backend.expectOne({ method: 'GET', url: '/api/automations' }).flush(forms);
    await settle();
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve));

  afterEach(() => backend.verify());

  it('lists the automations by name, with their version and draft facts', async () => {
    await open();

    const links = screen.getAllByRole('link').map((link) => [link.textContent?.trim(), link.getAttribute('href')]);
    expect(links).toEqual([
      ['Abertura no ERP', '/automacoes/a-2'],
      ['Consulta de crédito', '/automacoes/a-1'],
    ]);
    expect(screen.getByText('Nunca publicada')).toBeTruthy();
    expect(screen.getByText('Versão 2')).toBeTruthy();
    expect(screen.getByText('No bureau')).toBeTruthy();
    expect(screen.getByText('Chamadas HTTP que as etapas automáticas dos processos fazem.')).toBeTruthy();
  });

  it('filters by name as you type', async () => {
    await open();
    const user = userEvent.setup();

    await user.type(screen.getByRole('searchbox', { name: 'Buscar automações' }), 'consul');

    expect(screen.getAllByRole('link').map((link) => link.textContent?.trim())).toEqual(['Consulta de crédito']);
    await user.clear(screen.getByRole('searchbox', { name: 'Buscar automações' }));
    await user.type(screen.getByRole('searchbox', { name: 'Buscar automações' }), 'nada');
    expect(screen.getByText('Nenhuma automação com esse nome.')).toBeTruthy();
  });

  it('says so when there are none yet', async () => {
    await open([]);

    expect(screen.getByText('Nenhuma automação ainda. Crie a primeira com “Nova automação”.')).toBeTruthy();
  });

  it('creates an automation and opens it, and says when the name is taken', async () => {
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Nova automação' }));
    await user.click(screen.getByRole('button', { name: 'Criar' }));
    expect(screen.getByText('Informe o nome.')).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: /Nome/ }), 'Consulta de crédito');
    await user.click(screen.getByRole('button', { name: 'Criar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/automations' })
      .flush({ type: 'about:blank', title: 'Taken', status: 409, code: 'automation_name_taken' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(screen.getByText('Já existe uma automação com este nome.')).toBeTruthy();

    await user.clear(screen.getByRole('textbox', { name: /Nome/ }));
    await user.type(screen.getByRole('textbox', { name: /Nome/ }), 'Cadastro no ERP');
    await user.click(screen.getByRole('button', { name: 'Criar' }));
    const request = backend.expectOne({ method: 'POST', url: '/api/automations' });
    expect(request.request.body).toEqual({ name: 'Cadastro no ERP', description: null });
    request.flush({ ...FORMS[0], id: 'a-9', name: 'Cadastro no ERP', version: 1, draft: {} }, { status: 201, statusText: 'Created' });
    await settle();

    expect(TestBed.inject(Router).url).toBe('/automacoes/a-9');
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      await open();
      await expectNoAxeViolations();
    });
  });
});
