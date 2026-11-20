import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { RequestsPage } from './requests-page';

@Component({ template: '<h1>Solicitação</h1>' })
class Request {}

const ANA = { id: 'u-ana', username: 'ana', displayName: 'Ana Souza' };

const summary = (id: string, status: string, definitionName = 'Concessão de Crédito') => ({
  id,
  definitionId: 'd-1',
  definitionName,
  versionNumber: 1,
  status,
  requester: ANA,
  startedAt: '2026-10-16T12:00:00Z',
  endedAt: null,
});

describe('RequestsPage (requests-ui.md §5)', () => {
  let backend: HttpTestingController;

  const listCall = (scope: string, status: string | null) =>
    backend.expectOne((r) => r.url === '/api/instances' && r.params.get('scope') === scope && r.params.get('status') === status);

  async function open(): Promise<void> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'solicitacoes', component: RequestsPage },
          { path: 'solicitacoes/:id', component: Request },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/solicitacoes');
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve));

  afterEach(() => backend.verify());

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it("lists the user's requests with their status, and passes axe", async () => {
      await open();
      listCall('mine', null).flush([summary('r-1', 'running'), summary('r-2', 'completed', 'Reembolso')]);
      await settle();

      expect(screen.getByRole('heading', { level: 1, name: 'Solicitações' })).toBeTruthy();
      const links = screen.getAllByRole('link');
      expect(links.map((link) => link.getAttribute('href'))).toEqual(['/solicitacoes/r-1', '/solicitacoes/r-2']);
      expect(within(links[0]).getByText('Em andamento')).toBeTruthy();
      expect(within(links[1]).getByText('Concluída')).toBeTruthy();
      expect(within(links[1]).getByText('Reembolso')).toBeTruthy();
      await expectNoAxeViolations();
    });
  });

  it('filters by scope and status', async () => {
    await open();
    listCall('mine', null).flush([]);
    await settle();
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: 'Todas que posso ver' }));
    listCall('visible', null).flush([summary('r-3', 'running')]);
    await settle();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Situação' }), 'completed');
    listCall('visible', 'completed').flush([]);
    await settle();

    expect(screen.getByText('Nenhuma solicitação.')).toBeTruthy();
  });

  it('shows only the latest answer when the filters change quickly', async () => {
    await open();
    listCall('mine', null).flush([]);
    await settle();
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: 'Todas que posso ver' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Situação' }), 'running');
    const latest = listCall('visible', 'running');
    const stale = listCall('visible', null);
    latest.flush([summary('r-new', 'running', 'Pedido novo')]);
    await settle();
    stale.flush([summary('r-old', 'completed', 'Pedido antigo')]);
    await settle();

    expect(screen.getByText('Pedido novo')).toBeTruthy();
    expect(screen.queryByText('Pedido antigo')).toBeNull();
  });

  it('offers a retry when the list fails to load', async () => {
    await open();
    listCall('mine', null).error(new ProgressEvent('error'));
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar de novo' }));
    listCall('mine', null).flush([summary('r-1', 'cancelled')]);
    await settle();

    expect(within(screen.getByRole('link')).getByText('Cancelada')).toBeTruthy();
  });
});
