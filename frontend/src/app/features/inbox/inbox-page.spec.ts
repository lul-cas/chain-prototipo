import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { SessionService } from '../../core/session/session.service';
import { expectNoAxeViolations } from '../../../testing/axe';
import { ANA } from '../../../testing/session';
import { THEMES, applyTheme } from '../../../testing/themes';
import { InboxPage } from './inbox-page';

@Component({ template: '<h1>Tarefa</h1>' })
class Task {}

const ANA_REF = { id: ANA.id, username: 'ana', displayName: 'Ana Souza' };
const BRUNO = { id: 'u-bruno', username: 'bruno', displayName: 'Bruno Lima' };

function item(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    instanceId: `r-${id}`,
    nodeId: 'analyse',
    label: 'Analisar proposta',
    kind: 'task',
    question: null,
    group: { id: 'g-1', name: 'Analistas' },
    assignee: null,
    createdAt: '2026-10-16T12:00:00Z',
    definitionName: 'Concessão de Crédito',
    requester: ANA_REF,
    ...overrides,
  };
}

describe('InboxPage (requests-ui.md §3)', () => {
  let backend: HttpTestingController;

  async function open(inbox: object): Promise<void> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'tarefas', component: InboxPage },
          { path: 'tarefas/:id', component: Task },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(SessionService).load();
    backend.expectOne('/api/auth/me').flush(ANA);
    await loading;
    await RouterTestingHarness.create('/tarefas');
    backend.expectOne('/api/tasks').flush(inbox);
    await new Promise((resolve) => setTimeout(resolve));
  }

  afterEach(() => backend.verify());

  const INBOX = {
    assignedToMe: [],
    unassigned: [item('t-1'), item('t-2', { label: 'Docs ok?', kind: 'decision', group: null })],
    assignedToOthers: [item('t-3', { assignee: BRUNO })],
  };

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('shows the three tabs with counts, starting at the first with tasks, and passes axe', async () => {
      await open(INBOX);

      expect(screen.getByRole('heading', { level: 1, name: 'Tarefas' })).toBeTruthy();
      expect(screen.getByText('Olá, Ana Souza.')).toBeTruthy();
      const tabs = screen.getAllByRole('tab');
      expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Minhas (0)', 'Do grupo (2)', 'Com outros (1)']);
      expect(screen.getByRole('tab', { name: 'Do grupo (2)' }).getAttribute('aria-selected')).toBe('true');

      const panel = screen.getByRole('tabpanel');
      const links = within(panel).getAllByRole('link');
      expect(links.map((link) => link.getAttribute('href'))).toEqual(['/tarefas/t-1', '/tarefas/t-2']);
      expect(within(panel).getAllByText('Concessão de Crédito')).toHaveLength(2);
      expect(within(panel).getByText('Analistas')).toBeTruthy();
      expect(within(panel).getByText('quem solicitou')).toBeTruthy();
      await expectNoAxeViolations();
    });
  });

  it('moves between tabs with the mouse and the keyboard', async () => {
    await open(INBOX);
    const user = userEvent.setup();

    await user.click(screen.getByRole('tab', { name: 'Com outros (1)' }));
    expect(within(screen.getByRole('tabpanel')).getByText('Com Bruno Lima')).toBeTruthy();

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Minhas (0)' }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tabpanel')).getByText('Nenhuma tarefa com você.')).toBeTruthy();
  });

  it('starts at Minhas when there are no tasks at all', async () => {
    await open({ assignedToMe: [], unassigned: [], assignedToOthers: [] });

    expect(screen.getByRole('tab', { name: 'Minhas (0)' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Nenhuma tarefa com você.')).toBeTruthy();
  });

  it('offers a retry when the inbox fails to load', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'tarefas', component: InboxPage }]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/tarefas');
    backend.expectOne('/api/tasks').error(new ProgressEvent('error'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar de novo' }));
    backend.expectOne('/api/tasks').flush({ assignedToMe: [item('t-9')], unassigned: [], assignedToOthers: [] });
    await new Promise((resolve) => setTimeout(resolve));

    expect(screen.getByRole('link', { name: /Analisar proposta/ }).getAttribute('href')).toBe('/tarefas/t-9');
  });
});
