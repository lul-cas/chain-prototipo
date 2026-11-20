import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { FormDocument } from '../../forms/model';
import { ToastService } from '../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { StartListPage } from './start-list-page';
import { StartRequestPage } from './start-request-page';

@Component({ template: '<h1>Solicitação</h1>' })
class Request {}

const STARTABLE = [
  { id: 'd-1', name: 'Concessão de Crédito', description: 'Crédito para clientes PJ.', latestVersion: 3 },
  { id: 'd-2', name: 'Reembolso de despesas', description: null, latestVersion: 1 },
];

const FORM: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'text', key: 'cliente', label: 'Cliente', validate: { required: true } },
    { type: 'number', key: 'valor', label: 'Valor solicitado', validate: { required: true, min: 1000 } },
  ],
};

describe('starting a request (requests-ui.md §4)', () => {
  let backend: HttpTestingController;
  let router: Router;

  async function open(url: string): Promise<void> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'solicitar', component: StartListPage },
            { path: 'solicitar/:workflowId', component: StartRequestPage },
            { path: 'solicitacoes/:id', component: Request },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    await RouterTestingHarness.create(url);
  }

  async function answer(request: TestRequest, body: object | null, status = 200): Promise<void> {
    if (status === 0) {
      request.error(new ProgressEvent('error'));
    } else if (status >= 400) {
      request.flush(body, { status, statusText: 'Erro' });
    } else {
      request.flush(body, { status, statusText: 'OK' });
    }
    await new Promise((resolve) => setTimeout(resolve));
  }

  async function openStart(form: FormDocument | null = FORM): Promise<void> {
    await open('/solicitar/d-1');
    await answer(backend.expectOne('/api/startable-workflows'), STARTABLE);
    await answer(backend.expectOne('/api/startable-workflows/d-1/start-form'), {
      workflowId: 'd-1',
      versionNumber: 3,
      form: form ? { formId: 'f-1', version: 2, document: form } : null,
    });
  }

  const startCall = () => backend.expectOne((r) => r.method === 'POST' && r.url === '/api/instances');

  afterEach(() => backend.verify());

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('lists the workflows the user can start, and passes axe', async () => {
      await open('/solicitar');
      await answer(backend.expectOne('/api/startable-workflows'), STARTABLE);

      expect(screen.getByRole('heading', { level: 1, name: 'Solicitar' })).toBeTruthy();
      expect(screen.getByText('Crédito para clientes PJ.')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Solicitar Concessão de Crédito' }).getAttribute('href')).toBe('/solicitar/d-1');
      expect(screen.getByRole('link', { name: 'Solicitar Reembolso de despesas' }).getAttribute('href')).toBe('/solicitar/d-2');
      await expectNoAxeViolations();
    });

    it('shows the start form, and passes axe', async () => {
      await openStart();

      expect(screen.getByRole('heading', { level: 1, name: 'Concessão de Crédito' })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: 'Cliente' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Iniciar solicitação' })).toBeTruthy();
      await expectNoAxeViolations();
    });
  });

  it('says when there is nothing to start', async () => {
    await open('/solicitar');
    await answer(backend.expectOne('/api/startable-workflows'), []);

    expect(screen.getByText('Você ainda não pode iniciar nenhum fluxo.')).toBeTruthy();
  });

  it('starts a request with the start form, then opens it', async () => {
    await openStart();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Cliente' }), 'ACME');
    await user.type(screen.getByRole('textbox', { name: 'Valor solicitado' }), '5000,50');

    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));

    const request = startCall();
    expect(request.request.body).toBe('{"definitionId":"d-1","data":{"cliente":"ACME","valor":5000.5}}');
    expect(request.request.headers.get('Idempotency-Key')).toBeTruthy();
    expect(request.request.headers.get('Content-Type')).toBe('application/json');
    await answer(request, { id: 'r-9', status: 'running' }, 201);
    expect(router.url).toBe('/solicitacoes/r-9');
    expect(TestBed.inject(ToastService).toasts().map((toast) => toast.message)).toEqual(['Solicitação iniciada.']);
  });

  it('starts a request without a start form', async () => {
    await openStart(null);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));

    const request = startCall();
    expect(request.request.body).toBe('{"definitionId":"d-1","data":null}');
    await answer(request, { id: 'r-10', status: 'running' }, 201);
    expect(router.url).toBe('/solicitacoes/r-10');
  });

  it('checks the form before sending it', async () => {
    await openStart();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));

    backend.expectNone((r) => r.method === 'POST');
    expect(screen.getByRole('textbox', { name: 'Cliente' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByText('Preencha este campo.')).toHaveLength(2);
  });

  it('keeps the key after a network failure, and takes a new one after an answer', async () => {
    await openStart(null);
    const user = userEvent.setup();
    const iniciar = () => user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));

    await iniciar();
    const first = startCall();
    const key = first.request.headers.get('Idempotency-Key');
    await answer(first, null, 0);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');

    await iniciar();
    const retry = startCall();
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    await answer(retry, { status: 422, title: 'Erro', code: 'idempotency_key_reused' }, 422);
    expect(screen.getByRole('alert').textContent).toContain('A tentativa anterior pode já ter iniciado a solicitação.');

    await iniciar();
    const again = startCall();
    expect(again.request.headers.get('Idempotency-Key')).not.toBe(key);
    await answer(again, { id: 'r-11', status: 'running' }, 201);
  });

  it.each([0, 502, 503, 504])('offers "Tentar novamente" after %i, which sends the same request with the same key (card #156)', async (status) => {
    await openStart();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Cliente' }), 'ACME');
    await user.type(screen.getByRole('textbox', { name: 'Valor solicitado' }), '5000');
    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));
    const first = startCall();
    await answer(first, null, status);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');

    await user.type(screen.getByRole('textbox', { name: 'Cliente' }), ' S.A.');
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    const retry = startCall();
    expect(retry.request.headers.get('Idempotency-Key')).toBe(first.request.headers.get('Idempotency-Key'));
    expect(retry.request.body).toBe(first.request.body);
    await answer(retry, { id: 'r-12', status: 'running' }, 201);
    expect(router.url).toBe('/solicitacoes/r-12');
  });

  it('says that a request may already exist when a changed form meets the kept key, and links to the requests (card #173)', async () => {
    await openStart();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Cliente' }), 'ACME');
    await user.type(screen.getByRole('textbox', { name: 'Valor solicitado' }), '5000');
    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));
    const first = startCall();
    await answer(first, null, 0);

    await user.type(screen.getByRole('textbox', { name: 'Cliente' }), ' S.A.');
    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));
    const changed = startCall();
    expect(changed.request.headers.get('Idempotency-Key')).toBe(first.request.headers.get('Idempotency-Key'));
    expect(changed.request.body).not.toBe(first.request.body);
    await answer(changed, { status: 422, title: 'Erro', code: 'idempotency_key_reused' }, 422);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('A tentativa anterior pode já ter iniciado a solicitação. Confira antes de iniciar outra.');
    expect(within(alert).getByRole('link', { name: 'Ver as solicitações' }).getAttribute('href')).toBe('/solicitacoes');
    expect(within(alert).queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    await expectNoAxeViolations();
  });

  it("puts the server's errors on the fields", async () => {
    await openStart();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Cliente' }), 'ACME');
    await user.type(screen.getByRole('textbox', { name: 'Valor solicitado' }), '5000');
    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));

    await answer(startCall(), { status: 422, title: 'Erro', code: 'submission_invalid', errors: [{ key: 'cliente', code: 'invalid_format' }] }, 422);

    expect(screen.getByRole('textbox', { name: 'Cliente' }).getAttribute('aria-invalid')).toBe('true');
    expect(router.url).toBe('/solicitar/d-1');
  });

  it('says when the workflow can no longer be started', async () => {
    await openStart(null);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));

    await answer(startCall(), { status: 409, title: 'Erro', code: 'workflow_not_startable' }, 409);

    expect(screen.getByRole('alert').textContent).toContain('Este fluxo não pode ser iniciado agora.');
    expect(screen.getByRole('link', { name: 'Ver os fluxos' }).getAttribute('href')).toBe('/solicitar');
  });

  it('says when the user may not start the workflow', async () => {
    await openStart(null);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));

    await answer(startCall(), { status: 403, title: 'Proibido', code: 'forbidden' }, 403);

    expect(screen.getByRole('alert').textContent).toContain('Você não pode iniciar este fluxo.');
    expect(screen.queryByRole('button', { name: 'Iniciar solicitação' })).toBeNull();
  });

  it('says when the workflow is not one the user can start', async () => {
    await open('/solicitar/d-9');
    await answer(backend.expectOne('/api/startable-workflows'), STARTABLE);
    await answer(backend.expectOne('/api/startable-workflows/d-9/start-form'), { status: 404, title: 'Not found', code: 'not_found' }, 404);

    expect(screen.getByRole('heading', { level: 1, name: 'Este fluxo não pode ser iniciado' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver os fluxos' }).getAttribute('href')).toBe('/solicitar');
  });

  it('treats a workflow missing from the startable list as not startable', async () => {
    await open('/solicitar/d-3');
    await answer(backend.expectOne('/api/startable-workflows'), STARTABLE);
    await answer(backend.expectOne('/api/startable-workflows/d-3/start-form'), { workflowId: 'd-3', versionNumber: 1, form: null });

    expect(screen.getByRole('heading', { level: 1, name: 'Este fluxo não pode ser iniciado' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Iniciar solicitação' })).toBeNull();
  });

  describe('when the router keeps the page for another workflow (requests-ui.md §4, card #187)', () => {
    /** Goes to another workflow's start page, which the router opens in this same page. */
    async function goTo(id: string): Promise<void> {
      await router.navigateByUrl(`/solicitar/${id}`);
      await new Promise((resolve) => setTimeout(resolve));
    }

    async function loadWorkflow(id: string, form: FormDocument | null): Promise<void> {
      await answer(backend.expectOne('/api/startable-workflows'), STARTABLE);
      await answer(backend.expectOne(`/api/startable-workflows/${id}/start-form`), {
        workflowId: id,
        versionNumber: 1,
        form: form ? { formId: 'f-2', version: 1, document: form } : null,
      });
    }

    it("starts afresh: the old workflow's form, message, retry and key are gone", async () => {
      await openStart();
      const user = userEvent.setup();
      await user.type(screen.getByRole('textbox', { name: 'Cliente' }), 'ACME');
      await user.type(screen.getByRole('textbox', { name: 'Valor solicitado' }), '5000');
      await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));
      const first = startCall();
      await answer(first, null, 0); // the answer is lost: the page keeps the key, and offers "Tentar novamente"
      expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();

      await goTo('d-2');

      expect(screen.getByRole('status').textContent).toContain('Carregando…');
      expect(screen.queryByRole('textbox', { name: 'Cliente' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      await loadWorkflow('d-2', null);
      expect(screen.getByRole('heading', { level: 1, name: 'Reembolso de despesas' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));
      const second = startCall();
      expect(second.request.body).toBe('{"definitionId":"d-2","data":null}');
      expect(second.request.headers.get('Idempotency-Key')).not.toBe(first.request.headers.get('Idempotency-Key'));
      await answer(second, { id: 'r-20', status: 'running' }, 201);
      expect(router.url).toBe('/solicitacoes/r-20');
    });

    it("shows the new workflow's form without the old one's server errors", async () => {
      await openStart();
      const user = userEvent.setup();
      await user.type(screen.getByRole('textbox', { name: 'Cliente' }), 'ACME');
      await user.type(screen.getByRole('textbox', { name: 'Valor solicitado' }), '5000');
      await user.click(screen.getByRole('button', { name: 'Iniciar solicitação' }));
      await answer(startCall(), { status: 422, title: 'Erro', code: 'submission_invalid', errors: [{ key: 'cliente', code: 'invalid_format' }] }, 422);
      expect(screen.getByRole('textbox', { name: 'Cliente' }).getAttribute('aria-invalid')).toBe('true');

      await goTo('d-2');
      await loadWorkflow('d-2', FORM);

      expect(screen.getByRole('heading', { level: 1, name: 'Reembolso de despesas' })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: 'Cliente' }).getAttribute('aria-invalid')).not.toBe('true');
    });

    it('offers the start again after a refused start closed the old workflow', async () => {
      await openStart(null);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Iniciar solicitação' }));
      await answer(startCall(), { status: 409, title: 'Erro', code: 'workflow_not_startable' }, 409);
      expect(screen.queryByRole('button', { name: 'Iniciar solicitação' })).toBeNull();

      await goTo('d-2');
      await loadWorkflow('d-2', null);

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Iniciar solicitação' })).toBeTruthy();
    });

    it("cancels the old workflow's start still running, so its answer can't reach the new workflow", async () => {
      await openStart(null);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Iniciar solicitação' }));
      const running = startCall();

      await goTo('d-2');

      expect(running.cancelled).toBe(true);
      await loadWorkflow('d-2', null);
      expect(screen.getByRole('button', { name: 'Iniciar solicitação' }).getAttribute('aria-busy')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it("cancels the old workflow's load still running, so the page shows the new workflow", async () => {
      await open('/solicitar/d-1');
      const startable = backend.expectOne('/api/startable-workflows');
      const startForm = backend.expectOne('/api/startable-workflows/d-1/start-form');

      await goTo('d-2');

      expect(startable.cancelled).toBe(true);
      expect(startForm.cancelled).toBe(true);
      await loadWorkflow('d-2', null);
      expect(screen.getByRole('heading', { level: 1, name: 'Reembolso de despesas' })).toBeTruthy();
    });
  });
});
