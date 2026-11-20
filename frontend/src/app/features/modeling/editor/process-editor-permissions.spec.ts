import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { ProcessEditorPage } from './process-editor-page';

@Component({ template: '<h1>Processos</h1>' })
class ProcessList {}

const DRAFT = {
  schemaVersion: 1,
  lanes: [{ id: 'lane_an', title: 'Análise', group: { kind: 'requesters' } }],
  nodes: [
    { id: 'start', type: 'start', label: 'Início', laneId: 'lane_an' },
    { id: 'analyse', type: 'task', taskKind: 'human', label: 'Analisar proposta', laneId: 'lane_an' },
    { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_an' },
  ],
  flows: [
    { id: 'f1', source: 'start', target: 'analyse' },
    { id: 'f2', source: 'analyse', target: 'end' },
  ],
};
const DEFINITION = {
  id: 'w-1',
  name: 'Concessão de Crédito',
  description: null,
  isActive: true,
  latestVersion: 2,
  draftUpdatedAt: '2026-10-17T12:00:00Z',
  version: 7,
  draft: DRAFT,
};

describe('ProcessEditorPage, Permissões (admin-ui.md §7, §11.3)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);

  async function open() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'processos', component: ProcessList },
          { path: 'processos/:id', component: ProcessEditorPage },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/processos/w-1');
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1' }).flush(DEFINITION, { headers: { ETag: '"7"' } });
    await settle();
    return userEvent.setup();
  }

  async function applyGrant(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Permissões' }));
    const panel = within(await screen.findByRole('dialog', { name: 'Permissões' }));
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/grants' }).flush([]);
    backend.expectOne({ method: 'GET', url: '/api/workflows/groups' }).flush([{ id: 'g-cred', name: 'Crédito' }]);
    await settle();
    await user.selectOptions(panel.getByRole('combobox', { name: 'Grupo a adicionar' }), 'Crédito');
    await user.click(panel.getByRole('button', { name: 'Adicionar grupo' }));
    await user.click(panel.getByRole('checkbox', { name: 'Iniciar — Crédito' }));
    await user.click(panel.getByRole('button', { name: 'Aplicar' }));
    return backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/grants' });
  }

  afterEach(() => backend.verify());

  it("takes the process's new ETag from the grants, so the unsaved draft is saved next without reloading (criterion 2)", async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Etapa: Analisar proposta' }));
    await user.keyboard('{ArrowDown}'); // an unsaved change

    const grants = await applyGrant(user);
    expect(grants.request.headers.get('If-Match')).toBe('"7"');
    expect(grants.request.body).toEqual([{ groupId: 'g-cred', capabilities: ['start'] }]);
    grants.flush([{ groupId: 'g-cred', groupName: 'Crédito', capabilities: ['start'] }], { headers: { ETag: '"8"' } });
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toasts()).toContain('Permissões aplicadas.');
    expect(screen.getByText('Alterações não salvas')).toBeTruthy(); // the draft is untouched

    await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    const save = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/draft' });
    expect(save.request.headers.get('If-Match')).toBe('"8"');
    save.flush({ ...DEFINITION, version: 9 }, { headers: { ETag: '"9"' } });
    await settle();
  });

  it('says so when it could not confirm the grants, and keeps the ETag it had', async () => {
    const user = await open();
    const grants = await applyGrant(user);
    grants.error(new ProgressEvent('error'));
    await settle();
    await user.click(within(screen.getByRole('dialog', { name: 'Permissões' })).getByRole('button', { name: 'Tentar de novo' }));
    backend
      .expectOne({ method: 'PUT', url: '/api/workflows/w-1/grants' })
      .flush({ type: 'about:blank', title: 'x', status: 412, code: 'version_mismatch' }, { status: 412, statusText: 'Precondition Failed' });
    await settle();

    expect(screen.getByText('Não foi possível confirmar se as permissões foram aplicadas. Abra Permissões de novo para conferir.')).toBeTruthy();
  });
});
