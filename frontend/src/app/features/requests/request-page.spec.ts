import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { ToastService } from '../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { RequestPage } from './request-page';

@Component({ template: '<h1>Outra página</h1>' })
class Elsewhere {}

const ANA = { id: 'u-ana', username: 'ana', displayName: 'Ana Souza' };
const BRUNO = { id: 'u-bruno', username: 'bruno', displayName: 'Bruno Lima' };
const ANALISTAS = { id: 'g-1', name: 'Analistas' };

const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, '0')}:00Z`;
const ev = (type: string, minute: number, extra: Record<string, unknown> = {}) => ({
  type,
  occurredAt: at(minute),
  actor: null,
  actedAsGroup: null,
  taskId: null,
  details: {},
  ...extra,
});

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    definitionId: 'd-1',
    definitionName: 'Concessão de Crédito',
    versionNumber: 1,
    status: 'running',
    currentNodeId: 'analyse',
    requester: ANA,
    startedAt: at(0),
    endedAt: null,
    openTasks: [
      { id: 't-1', instanceId: 'r-1', nodeId: 'analyse', label: 'Analisar proposta', kind: 'task', question: null, group: ANALISTAS, assignee: BRUNO, createdAt: at(2) },
    ],
    participants: [ANA, BRUNO],
    timeline: [
      ev('instance.started', 0, { actor: ANA }),
      ev('task.created', 0, { taskId: 't-0', details: { label: 'Preencher proposta', kind: 'task' } }),
      ev('task.completed', 1, { actor: ANA, taskId: 't-0', details: { comment: 'Proposta enviada' } }),
      ev('task.created', 1, { taskId: 't-1', details: { label: 'Analisar proposta', kind: 'task' } }),
      ev('task.assigned', 2, { actor: BRUNO, actedAsGroup: ANALISTAS, taskId: 't-1' }),
    ],
    data: { cliente: 'ACME', valor: 2500.75, aprovado: true, endereco: { cep: '01310-100' } },
    incidents: [],
    parent: null,
    children: [],
    version: 3,
    ...overrides,
  };
}

describe('RequestPage (requests-ui.md §6)', () => {
  let backend: HttpTestingController;

  async function open(body: object, status = 200): Promise<void> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'solicitacoes/:id', component: RequestPage },
            { path: '**', component: Elsewhere },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/solicitacoes/r-1');
    await answer(backend.expectOne('/api/instances/r-1'), body, status);
  }

  async function answer(request: TestRequest, body: object | null, status = 200): Promise<void> {
    if (status >= 400) {
      request.flush(body, { status, statusText: 'Erro' });
    } else {
      request.flush(body);
    }
    await new Promise((resolve) => setTimeout(resolve));
  }

  afterEach(() => backend.verify());

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('shows the status, people, open tasks, data and timeline, and passes axe', async () => {
      await open(view());

      expect(screen.getByRole('heading', { level: 1, name: 'Concessão de Crédito' })).toBeTruthy();
      expect(screen.getByText('Em andamento')).toBeTruthy();
      expect(screen.getByText('Solicitada por Ana Souza')).toBeTruthy();

      const tasks = screen.getByRole('region', { name: 'Tarefas abertas' });
      expect(within(tasks).getByRole('link', { name: 'Analisar proposta' }).getAttribute('href')).toBe('/tarefas/t-1');
      expect(within(tasks).getByText('Com Bruno Lima')).toBeTruthy();

      const data = screen.getByRole('region', { name: 'Dados' });
      expect(within(data).getByText('2500,75')).toBeTruthy();
      expect(within(data).getByText('Sim')).toBeTruthy();
      expect(within(data).getByText('01310-100')).toBeTruthy();

      const items = within(screen.getByRole('region', { name: 'Linha do tempo' })).getAllByRole('listitem');
      expect(items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        expect.stringContaining('Ana Souza iniciou a solicitação'),
        expect.stringContaining('Sistema: Nova tarefa: Preencher proposta'), // the engine's event (§6, Linha do tempo)
        expect.stringMatching(/Ana Souza concluiu Preencher proposta.*Proposta enviada/),
        expect.stringContaining('Sistema: Nova tarefa: Analisar proposta'),
        expect.stringMatching(/Bruno Lima.*como Analistas.*começou a trabalhar em Analisar proposta/),
      ]);
      expect(screen.getByRole('button', { name: 'Encerrar solicitação' })).toBeTruthy();
      await expectNoAxeViolations();
    });

    it('marks the actions taken through the API or MCP, and no others (card #83, N9b-1)', async () => {
      const channels = ['mcp', null, 'api', null, 'ui'];
      await open(view({ timeline: view().timeline.map((event, index) => ({ ...event, channel: channels[index] })) }));

      const items = within(screen.getByRole('region', { name: 'Linha do tempo' })).getAllByRole('listitem');
      const texts = items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      expect(texts[0]).toContain('Ana Souza iniciou a solicitação · via MCP');
      expect(texts[2]).toContain('Ana Souza concluiu Preencher proposta · via API');
      expect(texts.filter((text) => text.includes('· via'))).toHaveLength(2);
      await expectNoAxeViolations();
    });
  });

  describe('the flow (workflow-editor.md §10.11)', () => {
    const DIAGRAM = {
      definitionId: 'w-1',
      versionNumber: 2,
      currentNodeId: 'analyse',
      document: {
        schemaVersion: 1,
        lanes: [{ id: 'lane_an', title: 'Análise' }],
        nodes: [
          { id: 'start', type: 'start', label: 'Início', laneId: 'lane_an' },
          { id: 'analyse', type: 'task', taskKind: 'human', label: 'Analisar proposta', laneId: 'lane_an' },
          { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_an' },
        ],
        flows: [
          { id: 'f1', source: 'start', target: 'analyse' },
          { id: 'f2', source: 'analyse', target: 'end' },
        ],
      },
    };

    describe.each(THEMES)('in the %s theme', (theme) => {
      beforeEach(() => applyTheme(theme));

      it('shows the request on its diagram when asked, with the step it is at marked, and passes axe', async () => {
        await open(view());
        const user = userEvent.setup();
        const toggle = screen.getByRole('button', { name: 'Mostrar o fluxo' });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        await user.click(toggle);
        expect(screen.getByText('Carregando o fluxo…')).toBeTruthy();
        await answer(backend.expectOne('/api/instances/r-1/diagram'), DIAGRAM);
        expect(screen.getByRole('img', { name: 'Etapa: Analisar proposta, etapa atual' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Ocultar o fluxo' }).getAttribute('aria-expanded')).toBe('true');
        await expectNoAxeViolations(document.body);

        await user.click(screen.getByRole('button', { name: 'Ocultar o fluxo' }));
        await user.click(screen.getByRole('button', { name: 'Mostrar o fluxo' }));
        expect(screen.getByRole('img', { name: 'Etapa: Analisar proposta, etapa atual' })).toBeTruthy(); // read once
      });
    });

    it('says when the flow cannot be read, and leaves the rest of the page as it is', async () => {
      await open(view());
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Mostrar o fluxo' }));
      await answer(backend.expectOne('/api/instances/r-1/diagram'), { status: 500, title: 'Erro', code: 'internal' }, 500);

      expect(screen.getByText('Não foi possível carregar o fluxo.')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1, name: 'Concessão de Crédito' })).toBeTruthy();
    });
  });

  describe.each(THEMES)('a faulted request, in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('shows its open incidents in pt-BR, then the code and the recorded message, its parent and its children, and passes axe', async () => {
      await open(
        view({
          status: 'faulted',
          openTasks: [],
          incidents: [
            { id: 'i-0', nodeId: 'risk', code: 'type_mismatch', message: 'Já resolvido.', createdAt: at(3), resolvedAt: at(4), resolution: 'retried' },
            {
              id: 'i-1',
              nodeId: 'risk',
              code: 'subprocess_faulted',
              message: 'The sub-workflow request r-2 (Análise de risco) is faulted; fix it first.',
              createdAt: at(5),
              resolvedAt: null,
              resolution: null,
            },
            { id: 'i-2', nodeId: 'risk', code: 'a_new_incident', message: 'Something new went wrong.', createdAt: at(6), resolvedAt: null, resolution: null },
          ],
          parent: { id: 'r-0', nodeId: 'call' },
          children: [{ id: 'r-2', nodeId: 'risk', definitionName: 'Análise de risco', status: 'completed' }],
        }),
      );

      expect(screen.getByText('Com falha')).toBeTruthy();
      const incidents = within(screen.getByRole('region', { name: 'Incidentes' })).getAllByRole('listitem');
      const parts = incidents.map((item) => [...item.children].map((part) => part.textContent?.replace(/\s+/g, ' ').trim()));
      expect(parts).toEqual([
        ['Uma subsolicitação parou com uma falha.', 'subprocess_faulted The sub-workflow request r-2 (Análise de risco) is faulted; fix it first.'],
        ['Something new went wrong.', 'a_new_incident'], // a code without a text shows the recorded message first
      ]);
      expect(incidents.every((item) => item.children[1].classList.contains('chain-request__muted'))).toBe(true);
      expect(screen.getByRole('link', { name: 'Parte de outra solicitação' }).getAttribute('href')).toBe('/solicitacoes/r-0');
      const children = screen.getByRole('region', { name: 'Subsolicitações' });
      expect(within(children).getByRole('link', { name: 'Análise de risco' }).getAttribute('href')).toBe('/solicitacoes/r-2');
      expect(within(children).getByText('Concluída')).toBeTruthy();
      await expectNoAxeViolations();
    });
  });

  it('closes the request with a justification', async () => {
    await open(view());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Encerrar solicitação' }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar solicitação?' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    expect(within(dialog).getByText('Escreva uma justificativa.')).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox', { name: 'Justificativa' }), 'Cliente desistiu');
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));

    const request = backend.expectOne((r) => r.method === 'POST' && r.url === '/api/instances/r-1/close');
    expect(request.request.body).toEqual({ justification: 'Cliente desistiu' });
    expect(request.request.headers.get('Idempotency-Key')).toBeTruthy();
    const closed = [
      ev('task.cancelled', 9, { actor: ANA, taskId: 't-1' }),
      ev('instance.cancelled', 9, { actor: ANA, details: { justification: 'Cliente desistiu' } }),
    ];
    await answer(request, view({ status: 'cancelled', openTasks: [], endedAt: at(9), timeline: [...view().timeline, ...closed] }));

    expect(screen.getByText('Cancelada')).toBeTruthy();
    const items = within(screen.getByRole('region', { name: 'Linha do tempo' })).getAllByRole('listitem');
    expect(items.slice(-2).map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringMatching(/Ana Souza cancelou a tarefa Analisar proposta$/),
      expect.stringMatching(/Ana Souza encerrou a solicitação Cliente desistiu$/),
    ]);
    expect(screen.queryByRole('button', { name: 'Encerrar solicitação' })).toBeNull();
    expect(TestBed.inject(ToastService).toasts().map((toast) => toast.message)).toEqual(['Solicitação encerrada.']);
  });

  it('offers "Tentar novamente" after a 502, which closes with the same justification and key (card #156)', async () => {
    await open(view());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Encerrar solicitação' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Justificativa' }), 'Cliente desistiu');
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    const close = () => backend.expectOne((r) => r.method === 'POST' && r.url === '/api/instances/r-1/close');
    const first = close();
    await answer(first, null, 502);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');

    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    const retry = close();
    expect(retry.request.headers.get('Idempotency-Key')).toBe(first.request.headers.get('Idempotency-Key'));
    expect(retry.request.body).toEqual({ justification: 'Cliente desistiu' });
    await answer(retry, view({ status: 'cancelled', openTasks: [], endedAt: at(9) }));
    expect(screen.getByText('Cancelada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
  });

  it('says when the user may not close the request', async () => {
    await open(view());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Encerrar solicitação' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Justificativa' }), 'Não quero mais');
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));

    await answer(backend.expectOne((r) => r.url === '/api/instances/r-1/close'), { status: 403, title: 'Proibido', code: 'forbidden' }, 403);

    expect(screen.getByRole('alert').textContent).toContain('Você não pode encerrar esta solicitação.');
    expect(screen.getByText('Em andamento')).toBeTruthy();
  });

  it('says when the request does not exist', async () => {
    await open({ status: 404, title: 'Not found', code: 'not_found' }, 404);

    expect(screen.getByRole('heading', { level: 1, name: 'Solicitação não encontrada' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver as solicitações' }).getAttribute('href')).toBe('/solicitacoes');
  });

  /** Closes the request on screen with a justification, through the dialog. */
  async function closeWith(justification: string): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Encerrar solicitação' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Justificativa' }), justification);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
  }

  const closeCall = (id: string) => backend.expectOne((r) => r.method === 'POST' && r.url === `/api/instances/${id}/close`);

  it('says that the lost attempt may have closed the request when another justification meets the kept key (card #200)', async () => {
    await open(view());
    await closeWith('Cliente desistiu');
    const first = closeCall('r-1');
    await answer(first, null, 502);

    await closeWith('Pedido duplicado');
    const changed = closeCall('r-1');
    expect(changed.request.headers.get('Idempotency-Key')).toBe(first.request.headers.get('Idempotency-Key'));
    expect(changed.request.body).toEqual({ justification: 'Pedido duplicado' });
    await answer(changed, { status: 422, title: 'Erro', code: 'idempotency_key_reused' }, 422);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'A tentativa anterior pode já ter encerrado a solicitação, com a justificativa de antes. Carregue a página de novo para conferir.',
    );
    expect(within(alert).queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    await expectNoAxeViolations();

    await closeWith('Pedido duplicado');
    const again = closeCall('r-1');
    expect(again.request.headers.get('Idempotency-Key')).not.toBe(first.request.headers.get('Idempotency-Key'));
    await answer(again, { status: 409, title: 'Erro', code: 'instance_not_running' }, 409);
    await answer(backend.expectOne('/api/instances/r-1'), view({ status: 'cancelled', openTasks: [], endedAt: at(9) }));
    expect(screen.getByText('Cancelada')).toBeTruthy();
  });

  describe('when the router keeps the page for another request (requests-ui.md §6, card #200)', () => {
    /** Goes to another request's page, which the router opens in this same page. */
    async function goTo(id: string): Promise<void> {
      await TestBed.inject(Router).navigateByUrl(`/solicitacoes/${id}`);
      await new Promise((resolve) => setTimeout(resolve));
    }

    const R2 = view({ id: 'r-2', definitionName: 'Análise de risco', openTasks: [], parent: { id: 'r-1', nodeId: 'call' } });
    const RISK_DIAGRAM = {
      definitionId: 'w-2',
      versionNumber: 1,
      currentNodeId: 'risk',
      document: {
        schemaVersion: 1,
        lanes: [{ id: 'lane_risk', title: 'Risco' }],
        nodes: [
          { id: 'start', type: 'start', label: 'Início', laneId: 'lane_risk' },
          { id: 'risk', type: 'task', taskKind: 'human', label: 'Avaliar risco', laneId: 'lane_risk' },
          { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_risk' },
        ],
        flows: [
          { id: 'f1', source: 'start', target: 'risk' },
          { id: 'f2', source: 'risk', target: 'end' },
        ],
      },
    };
    const CREDIT_DIAGRAM = {
      ...RISK_DIAGRAM,
      definitionId: 'w-1',
      currentNodeId: 'analyse',
      document: {
        ...RISK_DIAGRAM.document,
        nodes: [
          { id: 'start', type: 'start', label: 'Início', laneId: 'lane_risk' },
          { id: 'analyse', type: 'task', taskKind: 'human', label: 'Analisar proposta', laneId: 'lane_risk' },
          { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_risk' },
        ],
        flows: [
          { id: 'f1', source: 'start', target: 'analyse' },
          { id: 'f2', source: 'analyse', target: 'end' },
        ],
      },
    };

    it("starts afresh: the old request's message, retry and close key are gone", async () => {
      await open(view());
      await closeWith('Cliente desistiu');
      const first = closeCall('r-1');
      await answer(first, null, 502); // the answer is lost: the close keeps its key, and "Tentar novamente" is offered
      expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();

      await goTo('r-2');

      expect(screen.getByRole('status').textContent).toContain('Carregando solicitação…');
      expect(screen.queryByRole('button', { name: 'Encerrar solicitação' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      await answer(backend.expectOne('/api/instances/r-2'), R2);
      expect(screen.getByRole('heading', { level: 1, name: 'Análise de risco' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();

      await closeWith('Pedido duplicado');
      const second = closeCall('r-2');
      expect(second.request.body).toEqual({ justification: 'Pedido duplicado' });
      expect(second.request.headers.get('Idempotency-Key')).not.toBe(first.request.headers.get('Idempotency-Key'));
      await answer(second, view({ ...R2, status: 'cancelled', endedAt: at(9) }));
      expect(screen.getByText('Cancelada')).toBeTruthy();
    });

    it("hides the flow, without the old request's diagram", async () => {
      await open(view());
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Mostrar o fluxo' }));
      await answer(backend.expectOne('/api/instances/r-1/diagram'), CREDIT_DIAGRAM);
      expect(screen.getByRole('img', { name: 'Etapa: Analisar proposta, etapa atual' })).toBeTruthy();

      await goTo('r-2');
      await answer(backend.expectOne('/api/instances/r-2'), R2);

      expect(screen.getByRole('button', { name: 'Mostrar o fluxo' }).getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('img', { name: 'Etapa: Analisar proposta, etapa atual' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Mostrar o fluxo' }));
      await answer(backend.expectOne('/api/instances/r-2/diagram'), RISK_DIAGRAM);
      expect(screen.getByRole('img', { name: 'Etapa: Avaliar risco, etapa atual' })).toBeTruthy();
    });

    it("cancels the old request's close still running, so its answer can't reach the new request", async () => {
      await open(view());
      await closeWith('Cliente desistiu');
      const running = closeCall('r-1');

      await goTo('r-2');

      expect(running.cancelled).toBe(true);
      await answer(backend.expectOne('/api/instances/r-2'), R2);
      expect(screen.getByRole('button', { name: 'Encerrar solicitação' }).getAttribute('aria-busy')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it("cancels the old request's diagram read still running", async () => {
      await open(view());
      await userEvent.setup().click(screen.getByRole('button', { name: 'Mostrar o fluxo' }));
      const reading = backend.expectOne('/api/instances/r-1/diagram');

      await goTo('r-2');

      expect(reading.cancelled).toBe(true);
      await answer(backend.expectOne('/api/instances/r-2'), R2);
      expect(screen.getByRole('button', { name: 'Mostrar o fluxo' }).getAttribute('aria-expanded')).toBe('false');
    });

    it("cancels the old request's load still running, so the page shows the new request", async () => {
      await open(view());
      await closeWith('Cliente desistiu');
      await answer(closeCall('r-1'), { status: 409, title: 'Erro', code: 'instance_not_running' }, 409);
      const reload = backend.expectOne('/api/instances/r-1'); // after instance_not_running, the page loads the request again

      await goTo('r-2');

      expect(reload.cancelled).toBe(true);
      await answer(backend.expectOne('/api/instances/r-2'), R2);
      expect(screen.getByRole('heading', { level: 1, name: 'Análise de risco' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it("drops the old request's close dialog, so confirming it sends nothing", async () => {
      await open(view());
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Encerrar solicitação' }));
      const dialog = await screen.findByRole('dialog');

      await goTo('r-2'); // the router can change the page under the dialog, for example from code
      await answer(backend.expectOne('/api/instances/r-2'), R2);
      await user.type(within(dialog).getByRole('textbox', { name: 'Justificativa' }), 'Cliente desistiu');
      await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));

      backend.expectNone((r) => r.method === 'POST');
    });
  });
});
