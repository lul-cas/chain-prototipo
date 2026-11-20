import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../testing/axe';
import { provideJsdomInteractivity } from '../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../testing/themes';
import { ProcessesPage } from './processes-page';

@Component({ template: '<h1>Editor</h1>' })
class Editor {}

const PROCESSES = [
  {
    id: 'w-1',
    name: 'Concessão de Crédito',
    description: 'Crédito para clientes',
    isActive: true,
    latestVersion: 2,
    draftUpdatedAt: '2026-10-17T12:00:00Z',
  },
  { id: 'w-2', name: 'Abertura de conta', description: null, isActive: false, latestVersion: null, draftUpdatedAt: '2026-10-16T09:30:00Z' },
];

describe('ProcessesPage (workflow-editor.md §10.1)', () => {
  let backend: HttpTestingController;

  async function open(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'processos', component: ProcessesPage },
          { path: 'processos/:id', component: Editor },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/processos');
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const list = async (processes: unknown[] = PROCESSES) => {
    backend.expectOne({ method: 'GET', url: '/api/workflows' }).flush(processes);
    await settle();
  };

  afterEach(() => backend.verify());

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('lists the processes with their state and latest version, each linking to its editor, and passes axe', async () => {
      await open();
      await list();

      expect(screen.getByRole('heading', { level: 1, name: 'Processos' })).toBeTruthy();
      const items = screen.getAllByRole('listitem');
      expect(within(items[0]).getByRole('link', { name: 'Concessão de Crédito' }).getAttribute('href')).toBe('/processos/w-1');
      expect(items[0].textContent).toContain('Crédito para clientes');
      expect(items[0].textContent).toContain('Ativo');
      expect(items[0].textContent).toContain('Versão 2');
      expect(items[1].textContent).toContain('Inativo');
      expect(items[1].textContent).toContain('Nunca publicado');
      await expectNoAxeViolations(document.body);
    });
  });

  it('says when there is no process yet', async () => {
    await open();
    await list([]);

    expect(screen.getByText('Nenhum processo ainda. Crie o primeiro com “Novo processo”.')).toBeTruthy();
  });

  it('creates a process and opens its editor; a taken name is said in the dialog', async () => {
    await open();
    await list();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Novo processo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo processo' });
    await user.click(within(dialog).getByRole('button', { name: 'Criar' }));
    expect(within(dialog).getByText('Informe o nome.')).toBeTruthy();

    await user.type(within(dialog).getByRole('textbox', { name: 'Nome' }), 'Concessão de Crédito');
    await user.click(within(dialog).getByRole('button', { name: 'Criar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/workflows' })
      .flush({ status: 409, code: 'workflow_name_taken', title: 'x' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(within(dialog).getByText('Já existe um processo com este nome.')).toBeTruthy();

    const name = within(dialog).getByRole('textbox', { name: 'Nome' });
    await user.clear(name);
    await user.type(name, 'Crédito Rural');
    await user.type(within(dialog).getByRole('textbox', { name: 'Descrição' }), 'Para produtores');
    await user.click(within(dialog).getByRole('button', { name: 'Criar' }));
    const created = backend.expectOne({ method: 'POST', url: '/api/workflows' });
    expect(created.request.body).toEqual({ name: 'Crédito Rural', description: 'Para produtores' });
    created.flush({ ...PROCESSES[0], id: 'w-9', name: 'Crédito Rural' }, { status: 201, statusText: 'Created' });
    await settle();

    expect(TestBed.inject(Router).url).toBe('/processos/w-9');
  });

  it('says at the description when the server cannot store it (card #155), until the user types in it (card #172)', async () => {
    await open();
    await list();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Novo processo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo processo' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nome' }), 'Crédito Rural');

    await user.click(within(dialog).getByRole('button', { name: 'Criar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/workflows' })
      .flush({ status: 400, code: 'validation_failed', title: 'x', errors: ['invalid_description'] }, { status: 400, statusText: 'Bad Request' });
    await settle();

    const description = within(dialog).getByRole('textbox', { name: 'Descrição' });
    expect(description.getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByText('A descrição tem caracteres que não podem ser guardados.')).toBeTruthy();

    await user.type(description, 'Para produtores');
    expect(description.getAttribute('aria-invalid')).toBeNull();
    expect(within(dialog).queryByText('A descrição tem caracteres que não podem ser guardados.')).toBeNull();
  });

  it('says what is wrong with a name the server cannot store (card #172)', async () => {
    await open();
    await list();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Novo processo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo processo' });
    const name = within(dialog).getByRole('textbox', { name: 'Nome' });
    await user.type(name, 'Crédito Rural');

    await user.click(within(dialog).getByRole('button', { name: 'Criar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/workflows' })
      .flush({ status: 400, code: 'validation_failed', title: 'x', errors: ['invalid_name'] }, { status: 400, statusText: 'Bad Request' });
    await settle();

    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByText('O nome tem caracteres que não podem ser guardados.')).toBeTruthy();
  });

  it('offers to try again when the list cannot be loaded', async () => {
    await open();
    backend.expectOne({ method: 'GET', url: '/api/workflows' }).error(new ProgressEvent('error'));
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await list();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
