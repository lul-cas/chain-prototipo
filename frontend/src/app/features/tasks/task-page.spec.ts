import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { SessionService } from '../../core/session/session.service';
import { FormDocument } from '../../forms/model';
import { ToastService } from '../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../testing/axe';
import { ANA } from '../../../testing/session';
import { THEMES, applyTheme } from '../../../testing/themes';
import { TaskPage } from './task-page';

@Component({ template: '<h1>Início</h1>' })
class Home {}

const FORM: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'text', key: 'cliente', label: 'Cliente', validate: { required: true, maxLength: 60 } },
    { type: 'number', key: 'valor', label: 'Valor solicitado', validate: { min: 1000 } },
  ],
};

const BRUNO = { id: 'u-bruno', username: 'bruno', displayName: 'Bruno Lima' };
const ME = { id: ANA.id, username: ANA.username, displayName: ANA.displayName };

function taskView(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    instanceId: 'r-1',
    nodeId: 'fill',
    label: 'Preencher proposta',
    kind: 'task',
    question: null,
    group: { id: 'g-1', name: 'Comercial' },
    assignee: null,
    createdAt: '2026-10-16T12:00:00Z',
    ...overrides,
  };
}

const INSTANCE = {
  id: 'r-1',
  definitionId: 'd-1',
  definitionName: 'Concessão de Crédito',
  versionNumber: 1,
  status: 'running',
  currentNodeId: 'fill',
  requester: ME,
  startedAt: '2026-10-16T12:00:00Z',
  endedAt: null,
  openTasks: [],
  participants: [],
  timeline: [],
  data: { cliente: 'ACME', limite: 5000 },
  incidents: [],
  parent: null,
  children: [],
  version: 7,
};

describe('TaskPage (requests-ui.md §1)', () => {
  let backend: HttpTestingController;
  let router: Router;

  async function open(task = taskView(), form: FormDocument | null = FORM): Promise<void> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'tarefas/:id', component: TaskPage }, { path: 'tarefas', component: Home }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    const loading = TestBed.inject(SessionService).load();
    backend.expectOne('/api/auth/me').flush(ANA);
    await loading;
    await RouterTestingHarness.create('/tarefas/t-1');
    await answer(backend.expectOne('/api/tasks/t-1'), {
      task,
      form: form ? { formId: 'f-1', version: 1, document: form } : null,
      prefill: { cliente: 'ACME' },
    });
    await answer(backend.expectOne('/api/instances/r-1'), INSTANCE);
  }

  afterEach(() => backend.verify());

  async function answer(request: TestRequest, body: object | null, status = 200): Promise<void> {
    if (status === 0) {
      request.error(new ProgressEvent('error'));
    } else if (status >= 400) {
      request.flush(body, { status, statusText: 'Erro' });
    } else {
      request.flush(body);
    }
    await new Promise((resolve) => setTimeout(resolve));
  }

  function command(path: string): TestRequest {
    return backend.expectOne((request) => request.method === 'POST' && request.url === path);
  }

  const problem = (code: string, errors: unknown[] = []) => ({ status: 409, title: 'Erro', code, errors });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('shows the task, its request and the form with the prefill, and passes axe', async () => {
      await open();

      expect(screen.getByRole('heading', { level: 1, name: 'Preencher proposta' })).toBeTruthy();
      expect(screen.getByText('Concessão de Crédito')).toBeTruthy();
      expect(screen.getByText('Solicitada por Ana Souza')).toBeTruthy();
      expect(screen.getByText('Disponível para Comercial')).toBeTruthy();
      expect((screen.getByRole('textbox', { name: 'Cliente' }) as HTMLInputElement).value).toBe('ACME');
      expect(screen.getByRole('button', { name: 'Concluir' })).toBeTruthy();
      await expectNoAxeViolations();
    });

    it('asks a decision with "Sim" and "Não", and passes axe', async () => {
      await open(taskView({ kind: 'decision', label: 'Docs ok?', question: 'Documentação correta?' }), null);

      expect(screen.getByText('Documentação correta?')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sim' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Não' })).toBeTruthy();
      await expectNoAxeViolations();
    });
  });

  it('completes the task with the form data and a comment, then goes to the start page with a toast', async () => {
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Valor solicitado' }), '2000,50');
    await user.type(screen.getByRole('textbox', { name: 'Comentário (opcional)' }), 'Tudo certo');

    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    const request = command('/api/tasks/t-1/complete');
    expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.request.headers.get('Content-Type')).toBe('application/json');
    expect(request.request.body).toBe('{"comment":"Tudo certo","data":{"cliente":"ACME","valor":2000.5}}');
    await answer(request, INSTANCE);
    expect(router.url).toBe('/tarefas');
    expect(TestBed.inject(ToastService).toasts().map((toast) => toast.message)).toEqual(['Tarefa concluída.']);
  });

  it("uploads a file in the task's form and completes with its id (forms.md F3, \"File fields\")", async () => {
    const form: FormDocument = { schemaVersion: 1, components: [{ type: 'file', key: 'contrato', label: 'Contrato', validate: { required: true } }] };
    await open(taskView(), form);
    const user = userEvent.setup();

    await user.upload(screen.getByLabelText('Contrato'), new File(['%PDF-1.4'], 'contrato.pdf', { type: 'application/pdf' }));
    backend.expectOne({ method: 'GET', url: '/api/files/limits' }).flush({ maxBytes: 25 * 1024 * 1024 }); // read once, before the first upload
    const upload = backend.expectOne({ method: 'POST', url: '/api/files' });
    expect(upload.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    await answer(upload, { id: 'f-1', name: 'contrato.pdf', size: 8, contentType: 'application/pdf' });
    expect(screen.getByRole('link', { name: 'contrato.pdf' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const request = command('/api/tasks/t-1/complete');
    expect(JSON.parse(request.request.body as string).data).toEqual({ contrato: [{ fileId: 'f-1' }] });
    await answer(request, INSTANCE);
    expect(router.url).toBe('/tarefas');
  });

  it('completes a task without a form with the comment only', async () => {
    await open(taskView(), null);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    const request = command('/api/tasks/t-1/complete');
    expect(request.request.body).toBe('{"comment":null,"data":null}');
    await answer(request, INSTANCE);
    expect(router.url).toBe('/tarefas');
  });

  it('answers a decision with its justification', async () => {
    await open(taskView({ kind: 'decision', label: 'Docs ok?', question: 'Documentação correta?' }), null);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Justificativa (opcional)' }), 'Conferido');

    await user.click(screen.getByRole('button', { name: 'Não' }));

    const request = command('/api/tasks/t-1/decide');
    expect(request.request.body).toEqual({ outcome: false, justification: 'Conferido' });
    await answer(request, INSTANCE);
    expect(TestBed.inject(ToastService).toasts().map((toast) => toast.message)).toEqual(['Decisão registrada.']);
  });

  it('starts working on an unassigned task', async () => {
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Começar' }));

    const request = command('/api/tasks/t-1/start');
    expect(request.request.headers.get('Idempotency-Key')).toBeTruthy();
    await answer(request, taskView({ assignee: ME }));
    expect(screen.getByText('Com você')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Começar' })).toBeNull();
  });

  it("keeps someone else's task read-only until the user takes it over", async () => {
    await open(taskView({ assignee: BRUNO }));
    const user = userEvent.setup();
    expect(screen.getByText('Com Bruno Lima')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Concluir' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Cliente' }).closest('fieldset')?.disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Assumir' }));
    await user.click(await screen.findByRole('button', { name: 'Assumir a tarefa' }));

    await answer(command('/api/tasks/t-1/take-over'), taskView({ assignee: ME }));
    expect(screen.getByText('Com você')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Cliente' }).closest('fieldset')?.disabled).toBe(false);
  });

  it("puts the server's validation errors on their fields", async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    await answer(command('/api/tasks/t-1/complete'), { ...problem('submission_invalid', [{ key: 'cliente', code: 'too_long' }]), status: 422 }, 422);

    expect(screen.getByRole('textbox', { name: 'Cliente' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use no máximo 60 caracteres.')).toBeTruthy();
    expect(router.url).toBe('/tarefas/t-1');
  });

  it('words a refused command by its validation code', async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    await answer(command('/api/tasks/t-1/complete'), { status: 400, title: 'Erro', code: 'validation_failed', errors: ['comment_too_long'] }, 400);

    expect(screen.getByRole('alert').textContent).toContain('O comentário pode ter no máximo 1.000 caracteres.');
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeTruthy();
  });

  it.each([
    ['Concluir', 'complete', 'invalid_comment', 'O comentário tem caracteres que não podem ser guardados.'],
    ['Sim', 'decide', 'invalid_justification', 'A justificativa tem caracteres que não podem ser guardados.'],
  ])('says what to fix when "%s" sends text the server cannot store (card #155)', async (button, path, code, message) => {
    await (button === 'Sim' ? open(taskView({ kind: 'decision', label: 'Docs ok?', question: 'Documentação correta?' }), null) : open());
    await userEvent.setup().click(screen.getByRole('button', { name: button }));

    await answer(command(`/api/tasks/t-1/${path}`), { status: 400, title: 'Erro', code: 'validation_failed', errors: [code] }, 400);

    expect(screen.getByRole('alert').textContent).toContain(message);
  });

    it('says when the task is no longer open, and stops editing', async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    await answer(command('/api/tasks/t-1/complete'), problem('task_not_open'), 409);

    expect(screen.getByRole('alert').textContent).toContain('Esta tarefa já foi concluída ou cancelada.');
    expect(screen.queryByRole('button', { name: 'Concluir' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Ir para o início' })).toBeTruthy();
  });

  it('loads the task again when someone else took it first', async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    await answer(command('/api/tasks/t-1/complete'), problem('task_assigned'), 409);
    await answer(backend.expectOne('/api/tasks/t-1'), { task: taskView({ assignee: BRUNO }), form: { formId: 'f-1', version: 1, document: FORM }, prefill: {} });
    await answer(backend.expectOne('/api/instances/r-1'), INSTANCE);

    expect(screen.getByRole('alert').textContent).toContain('Outra pessoa assumiu esta tarefa.');
    expect(screen.getByText('Com Bruno Lima')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Assumir' })).toBeTruthy();
  });

  it('keeps the key after a network failure, and takes a new one after an answer', async () => {
    await open();
    const user = userEvent.setup();
    const concluir = () => user.click(screen.getByRole('button', { name: 'Concluir' }));

    await concluir();
    const first = command('/api/tasks/t-1/complete');
    const key = first.request.headers.get('Idempotency-Key');
    await answer(first, null, 0);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');

    await concluir();
    const retry = command('/api/tasks/t-1/complete');
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    await answer(retry, problem('instance_not_running'), 409);
    expect(screen.getByRole('alert').textContent).toContain('A solicitação não está mais em andamento.');
  });

  it.each([502, 503, 504])('keeps the key after a %i, which can hide a command the server applied', async (status) => {
    await open();
    const user = userEvent.setup();
    const concluir = () => user.click(screen.getByRole('button', { name: 'Concluir' }));

    await concluir();
    const first = command('/api/tasks/t-1/complete');
    const key = first.request.headers.get('Idempotency-Key');
    await answer(first, null, status);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');

    await concluir();
    const retry = command('/api/tasks/t-1/complete');
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    await answer(retry, INSTANCE);
  });

  it.each([0, 502, 503, 504])('offers "Tentar novamente" after %i, which sends the same request with the same key (card #156)', async (status) => {
    await open();
    const user = userEvent.setup();
    const comment = screen.getByRole('textbox', { name: 'Comentário (opcional)' });
    await user.type(comment, 'Tudo certo');
    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const first = command('/api/tasks/t-1/complete');
    await answer(first, null, status);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');
    await expectNoAxeViolations();

    await user.type(comment, ', revisado');
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    const retry = command('/api/tasks/t-1/complete');
    expect(retry.request.headers.get('Idempotency-Key')).toBe(first.request.headers.get('Idempotency-Key'));
    expect(retry.request.body).toBe(first.request.body);
    await answer(retry, INSTANCE);
    expect(router.url).toBe('/tarefas');
  });

  it('gives each command its own key, which its retry reuses (card #156)', async () => {
    await open();
    const user = userEvent.setup();
    const key = (request: TestRequest) => request.request.headers.get('Idempotency-Key');

    await user.click(screen.getByRole('button', { name: 'Começar' }));
    const start = command('/api/tasks/t-1/start');
    await answer(start, null, 0);
    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const complete = command('/api/tasks/t-1/complete');
    expect(key(complete)).not.toBe(key(start));
    await answer(complete, null, 0);

    await user.click(screen.getByRole('button', { name: 'Começar' }));
    const startAgain = command('/api/tasks/t-1/start');
    expect(key(startAgain)).toBe(key(start));
    await answer(startAgain, taskView({ assignee: ME }));
    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const completeAgain = command('/api/tasks/t-1/complete');
    expect(key(completeAgain)).toBe(key(complete));
    await answer(completeAgain, INSTANCE);
  });

  it('gives "Sim" and "Não" their own keys, and drops the offer when another command is sent (card #156)', async () => {
    await open(taskView({ kind: 'decision', label: 'Docs ok?', question: 'Documentação correta?' }), null);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sim' }));
    const yes = command('/api/tasks/t-1/decide');
    await answer(yes, null, 0);

    await user.click(screen.getByRole('button', { name: 'Não' }));
    const no = command('/api/tasks/t-1/decide');
    expect(no.request.body).toEqual({ outcome: false, justification: null });
    expect(no.request.headers.get('Idempotency-Key')).not.toBe(yes.request.headers.get('Idempotency-Key'));
    await answer(no, problem('task_not_open'), 409);

    expect(screen.getByRole('alert').textContent).toContain('Esta tarefa já foi concluída ou cancelada.');
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
  });

  it('takes a new key for a new attempt after the server answered', async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const first = command('/api/tasks/t-1/complete');
    await answer(first, { ...problem('submission_invalid', [{ key: 'cliente', code: 'too_long' }]), status: 422 }, 422);

    await user.clear(screen.getByRole('textbox', { name: 'Cliente' }));
    await user.type(screen.getByRole('textbox', { name: 'Cliente' }), 'ACME S.A.');
    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    const second = command('/api/tasks/t-1/complete');
    expect(second.request.headers.get('Idempotency-Key')).not.toBe(first.request.headers.get('Idempotency-Key'));
    await answer(second, INSTANCE);
  });

  it('takes new keys when the router keeps the page for another task (card #173)', async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const first = command('/api/tasks/t-1/complete');
    await answer(first, null, 0); // the answer is lost, so this task's "Concluir" keeps its key

    await router.navigateByUrl('/tarefas/t-2');
    await new Promise((resolve) => setTimeout(resolve));
    await answer(backend.expectOne('/api/tasks/t-2'), {
      task: taskView({ id: 't-2', label: 'Revisar proposta' }),
      form: { formId: 'f-1', version: 1, document: FORM },
      prefill: { cliente: 'ACME' },
    });
    await answer(backend.expectOne('/api/instances/r-1'), INSTANCE);
    expect(screen.getByRole('heading', { level: 1, name: 'Revisar proposta' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const second = command('/api/tasks/t-2/complete');
    expect(second.request.headers.get('Idempotency-Key')).not.toBe(first.request.headers.get('Idempotency-Key'));
    await answer(second, INSTANCE);
  });

  it('says when the task does not exist', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'tarefas/:id', component: TaskPage }, { path: 'tarefas', component: Home }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/tarefas/t-404');

    await answer(backend.expectOne('/api/tasks/t-404'), { status: 404, title: 'Not found', code: 'not_found' }, 404);

    expect(screen.getByRole('heading', { level: 1, name: 'Tarefa não encontrada' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ir para o início' })).toBeTruthy();
  });

  it('says that the lost attempt may have been applied when a changed form meets the kept key (card #187)', async () => {
    await open();
    const user = userEvent.setup();
    const comment = screen.getByRole('textbox', { name: 'Comentário (opcional)' });
    await user.type(comment, 'Tudo certo');
    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const first = command('/api/tasks/t-1/complete');
    await answer(first, null, 0);

    await user.type(comment, ', revisado');
    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const changed = command('/api/tasks/t-1/complete');
    expect(changed.request.headers.get('Idempotency-Key')).toBe(first.request.headers.get('Idempotency-Key'));
    expect(changed.request.body).not.toBe(first.request.body);
    await answer(changed, { status: 422, title: 'Erro', code: 'idempotency_key_reused' }, 422);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('A tentativa anterior pode já ter sido registrada, com os dados de antes. Tente de novo para conferir.');
    expect(within(alert).queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    const again = command('/api/tasks/t-1/complete');
    expect(again.request.headers.get('Idempotency-Key')).not.toBe(first.request.headers.get('Idempotency-Key'));
    await answer(again, problem('task_not_open'), 409);
    expect(screen.getByRole('alert').textContent).toContain('Esta tarefa já foi concluída ou cancelada.');
  });

  describe('when the router keeps the page for another task (requests-ui.md §1.1, card #187)', () => {
    /** Goes to another task's page, which the router opens in this same page. */
    async function goTo(id: string): Promise<void> {
      await router.navigateByUrl(`/tarefas/${id}`);
      await new Promise((resolve) => setTimeout(resolve));
    }

    async function loadTask(task: ReturnType<typeof taskView>, form: FormDocument | null = FORM): Promise<void> {
      await answer(backend.expectOne(`/api/tasks/${task.id}`), {
        task,
        form: form ? { formId: 'f-1', version: 1, document: form } : null,
        prefill: { cliente: 'ACME' },
      });
      await answer(backend.expectOne('/api/instances/r-1'), INSTANCE);
    }

    const T2 = taskView({ id: 't-2', label: 'Revisar proposta' });

    it("starts afresh: the old task's form, comment, message, retry and keys are gone", async () => {
      await open();
      const user = userEvent.setup();
      await user.type(screen.getByRole('textbox', { name: 'Comentário (opcional)' }), 'Tudo certo');
      await user.click(screen.getByRole('button', { name: 'Concluir' }));
      const first = command('/api/tasks/t-1/complete');
      await answer(first, null, 0); // the answer is lost: "Concluir" keeps its key, and "Tentar novamente" is offered
      expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();

      await goTo('t-2');

      expect(screen.getByRole('status').textContent).toContain('Carregando tarefa…');
      expect(screen.queryByRole('button', { name: 'Concluir' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      await loadTask(T2);
      expect(screen.getByRole('heading', { level: 1, name: 'Revisar proposta' })).toBeTruthy();
      expect((screen.getByRole('textbox', { name: 'Comentário (opcional)' }) as HTMLTextAreaElement).value).toBe('');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Concluir' }));
      const second = command('/api/tasks/t-2/complete');
      expect(second.request.headers.get('Idempotency-Key')).not.toBe(first.request.headers.get('Idempotency-Key'));
      expect(JSON.parse(second.request.body as string).comment).toBeNull();
      await answer(second, INSTANCE);
    });

    it("starts a decision afresh: the old justification and the old answer's key are gone", async () => {
      await open(taskView({ kind: 'decision', label: 'Docs ok?', question: 'Documentação correta?' }), null);
      const user = userEvent.setup();
      await user.type(screen.getByRole('textbox', { name: 'Justificativa (opcional)' }), 'Conferido');
      await user.click(screen.getByRole('button', { name: 'Sim' }));
      const yes = command('/api/tasks/t-1/decide');
      await answer(yes, null, 0);

      await goTo('t-2');
      await loadTask(taskView({ id: 't-2', kind: 'decision', label: 'Contrato ok?', question: 'Contrato assinado?' }), null);

      expect((screen.getByRole('textbox', { name: 'Justificativa (opcional)' }) as HTMLTextAreaElement).value).toBe('');
      expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Sim' }));
      const yesAgain = command('/api/tasks/t-2/decide');
      expect(yesAgain.request.body).toEqual({ outcome: true, justification: null });
      expect(yesAgain.request.headers.get('Idempotency-Key')).not.toBe(yes.request.headers.get('Idempotency-Key'));
      await answer(yesAgain, INSTANCE);
    });

    it('enables the form again after a refused command closed the old task', async () => {
      await open();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Concluir' }));
      await answer(command('/api/tasks/t-1/complete'), problem('task_not_open'), 409);
      expect(screen.queryByRole('button', { name: 'Concluir' })).toBeNull();

      await goTo('t-2');
      await loadTask(T2);

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Concluir' })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: 'Cliente' }).closest('fieldset')?.disabled).toBe(false);
    });

    it("cancels the old task's command still running, so its answer can't reach the new task", async () => {
      await open();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Concluir' }));
      const running = command('/api/tasks/t-1/complete');

      await goTo('t-2');

      expect(running.cancelled).toBe(true);
      await loadTask(T2);
      expect(screen.getByRole('button', { name: 'Concluir' }).getAttribute('aria-busy')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it("cancels the old task's load still running, so the new task's page shows the new task", async () => {
      await open();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Concluir' }));
      await answer(command('/api/tasks/t-1/complete'), problem('task_assigned'), 409);
      const reload = backend.expectOne('/api/tasks/t-1'); // after task_assigned, the page loads the task again

      await goTo('t-2');

      expect(reload.cancelled).toBe(true);
      await loadTask(T2);
      expect(screen.getByRole('heading', { level: 1, name: 'Revisar proposta' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
