import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { GroupPage } from './group-page';

const GROUP = {
  id: 'g-1',
  name: 'Crédito',
  description: 'Análise de crédito',
  isArchived: false,
  isModeler: false,
  memberCount: 2,
  version: 5,
  members: [
    { id: 'u-ana', username: 'ana.souza', displayName: 'Ana Souza', isActive: true },
    { id: 'b-erp', username: 'erp-sync', displayName: 'Sincronizador do ERP', isActive: false },
  ],
};
const BOT = { mcpEnabled: false, mcpCallsPerMinute: null, ownerId: null, createdAt: '2026-10-01T12:00:00Z', version: 1, tokens: [], groups: [] };
const BOTS = [
  { ...BOT, id: 'b-crm', name: 'crm-sync', displayName: 'Sincronizador do CRM', isActive: true },
  { ...BOT, id: 'b-erp', name: 'erp-sync', displayName: 'Sincronizador do ERP', isActive: false },
  { ...BOT, id: 'b-ocr', name: 'ocr-leitor', displayName: 'Leitor de documentos', isActive: true },
];
const SINESIO = {
  id: 'u-sin',
  username: 'sinesio',
  displayName: 'Sinésio Prado',
  isAdmin: false,
  isActive: true,
  isLocked: false,
  mustChangePassword: false,
  createdAt: '2026-10-01T12:00:00Z',
  version: 1,
  groups: [],
};
const NO_CONTENT = { status: 204, statusText: 'No Content' };
const problem = (status: number, code: string) => [{ type: 'about:blank', title: code, status, code }, { status, statusText: code }] as const;

@Component({ template: '' })
class Elsewhere {}

describe('GroupPage (admin-ui.md §5.2, A2)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const typingStops = () => new Promise((resolve) => setTimeout(resolve, 350));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);
  const dialog = (name: string) => within(screen.getByRole('dialog', { name }));
  const modeling = () => screen.getByRole('checkbox', { name: 'Os membros podem modelar processos e formulários' }) as HTMLInputElement;

  async function open(body: object = GROUP, status = 200) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'administracao/grupos/:id', component: GroupPage },
            { path: '**', component: Elsewhere },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/administracao/grupos/g-1');
    backend.expectOne({ method: 'GET', url: '/api/admin/bots' }).flush(BOTS);
    await read('g-1', body, status);
    return userEvent.setup();
  }
  async function read(id: string, body: object, status = 200) {
    const request = backend.expectOne({ method: 'GET', url: `/api/admin/groups/${id}` });
    if (status >= 400) {
      request.flush(body, { status, statusText: 'Erro' });
    } else {
      request.flush(body, { headers: { ETag: `"${(body as { version: number }).version}"` } });
    }
    await settle();
  }
  async function done(method: string, url: string) {
    backend.expectOne({ method, url }).flush(null, NO_CONTENT);
    await settle();
  }

  afterEach(() => backend.verify());

  it('shows the group: name, description, Modelagem, and each member with Bot and Inativo when they apply', async () => {
    await open();

    expect(screen.getByRole('heading', { level: 1, name: 'Crédito' })).toBeTruthy();
    expect(screen.getByText('Análise de crédito')).toBeTruthy();
    expect(modeling().checked).toBe(false);
    expect(modeling().disabled).toBe(false);
    const table = screen.getByRole('table', { name: 'Membros' });
    const [, ana, erp] = within(table).getAllByRole('row');
    expect(within(ana).getByRole('rowheader').textContent?.trim()).toBe('Ana Souza');
    expect(within(ana).getAllByRole('cell')[0].textContent?.trim()).toBe('ana.souza');
    expect(within(ana).queryAllByRole('listitem')).toEqual([]);
    expect(within(erp).getAllByRole('listitem').map((item) => item.textContent?.trim())).toEqual(['Bot', 'Inativo']);
    expect(within(erp).getByRole('button', { name: 'Remover Sincronizador do ERP do grupo' })).toBeTruthy();
    expect(screen.getByText('2 membros')).toBeTruthy();
  });

  it('edits the name and description with If-Match, and a 412 offers Recarregar', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Editar nome e descrição' }));
    const form = dialog('Editar Crédito');
    const description = form.getByRole('textbox', { name: /^Descrição/ });
    await user.clear(description);
    await user.click(form.getByRole('button', { name: 'Salvar' }));

    const first = backend.expectOne({ method: 'PATCH', url: '/api/admin/groups/g-1' });
    expect(first.request.headers.get('If-Match')).toBe('"5"');
    expect(first.request.body).toEqual({ name: 'Crédito', description: '' }); // empty clears it
    first.flush(...problem(412, 'version_mismatch'));
    await settle();
    expect(form.getByText('Este grupo mudou desde que você o abriu.')).toBeTruthy();

    await user.click(form.getByRole('button', { name: 'Recarregar' }));
    await read('g-1', { ...GROUP, name: 'Crédito PF', version: 6 });
    expect((form.getByRole('textbox', { name: /^Nome/ }) as HTMLInputElement).value).toBe('Crédito PF');
    await user.click(form.getByRole('button', { name: 'Salvar' }));
    const again = backend.expectOne({ method: 'PATCH', url: '/api/admin/groups/g-1' });
    expect(again.request.headers.get('If-Match')).toBe('"6"');
    again.flush({ ...GROUP, name: 'Crédito PF', version: 7 }, { headers: { ETag: '"7"' } });
    await settle();

    expect(screen.getByRole('heading', { level: 1, name: 'Crédito PF' })).toBeTruthy();
    expect(toasts()).toContain('Grupo salvo.');
  });

  it('grants and revokes Modeler at once, and says when members see it', async () => {
    const user = await open();
    expect(screen.getByText('Os membros veem Processos e Formulários a partir da próxima página que abrirem.')).toBeTruthy();

    await user.click(modeling());
    await done('PUT', '/api/admin/groups/g-1/modeler');
    await read('g-1', { ...GROUP, isModeler: true, version: 5 });
    expect(modeling().checked).toBe(true);
    expect(toasts()).toContain('Modelagem concedida.');

    await user.click(modeling());
    await done('DELETE', '/api/admin/groups/g-1/modeler');
    await read('g-1', GROUP);
    expect(modeling().checked).toBe(false);
    expect(toasts()).toContain('Modelagem retirada.');
  });

  it('puts the box back when the server refuses the change', async () => {
    const user = await open();

    await user.click(modeling());
    backend.expectOne({ method: 'PUT', url: '/api/admin/groups/g-1/modeler' }).flush(...problem(409, 'group_archived'));
    await settle();

    expect(modeling().checked).toBe(false);
    expect(screen.getByText('O grupo está arquivado.')).toBeTruthy();
  });

  it('removes a member after asking', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Remover Ana Souza do grupo' }));
    const asked = dialog('Remover Ana Souza do grupo?');
    expect(asked.getByText('Quem sai do grupo deixa de poder executar as tarefas dele na hora.')).toBeTruthy();
    await user.click(asked.getByRole('button', { name: 'Remover' }));

    await done('DELETE', '/api/admin/groups/g-1/members/u-ana');
    await read('g-1', { ...GROUP, memberCount: 1, members: [GROUP.members[1]] });

    expect(screen.queryByText('Ana Souza')).toBeNull();
    expect(screen.getByText('1 membro')).toBeTruthy();
    expect(toasts()).toContain('Membro removido.');
  });

  it('after a lost answer, Tentar de novo repeats the removal without asking', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Remover Ana Souza do grupo' }));
    await user.click(dialog('Remover Ana Souza do grupo?').getByRole('button', { name: 'Remover' }));
    backend.expectOne({ method: 'DELETE', url: '/api/admin/groups/g-1/members/u-ana' }).error(new ProgressEvent('error'));
    await settle();
    expect(screen.getByText('Não foi possível confirmar a remoção.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    await done('DELETE', '/api/admin/groups/g-1/members/u-ana');
    await read('g-1', { ...GROUP, memberCount: 1, members: [GROUP.members[1]] });
  });

  it('adds a user or a bot found by name, each labelled by kind; members already in it are marked', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Adicionar membro' }));
    const search = dialog('Adicionar membro a Crédito');

    await user.type(search.getByRole('searchbox', { name: 'Buscar por nome ou identificador' }), 'sin');
    await typingStops();
    backend.expectOne({ method: 'GET', url: '/api/admin/users?search=sin&limit=50&offset=0' }).flush({ items: [SINESIO], total: 1 });
    await settle();

    const results = within(search.getByRole('list', { name: 'Resultados' })).getAllByRole('listitem');
    expect(results).toHaveLength(3); // the users found, then the bots whose name holds the term
    const [sinesio, crm, erp] = results;
    expect(within(sinesio).getByText('Sinésio Prado')).toBeTruthy();
    expect(sinesio.textContent).toContain('sinesio · Usuário');
    expect(within(sinesio).getByRole('button', { name: 'Adicionar Sinésio Prado ao grupo' })).toBeTruthy();
    expect(crm.textContent).toContain('crm-sync · Bot');
    expect(erp.textContent).toContain('erp-sync · Bot · Inativo');
    expect(within(erp).getByText('Já é membro')).toBeTruthy();
    expect(within(erp).queryByRole('button')).toBeNull();

    await user.click(search.getByRole('button', { name: 'Adicionar Sincronizador do CRM ao grupo' }));
    await done('PUT', '/api/admin/groups/g-1/members/b-crm');
    await read('g-1', { ...GROUP, memberCount: 3, members: [...GROUP.members, { id: 'b-crm', username: 'crm-sync', displayName: 'Sincronizador do CRM', isActive: true }] });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toasts()).toContain('Membro adicionado.');
    expect(screen.getByText('3 membros')).toBeTruthy();
  });

  it('archives after asking, with what it suspends', async () => {
    const user = await open({ ...GROUP, isModeler: true });
    await user.click(screen.getByRole('button', { name: 'Arquivar' }));
    const asked = dialog('Arquivar Crédito?');
    expect(
      asked.getByText(
        'O grupo não recebe novos membros e não pode ser usado em novas versões. As tarefas já atribuídas a ele continuam. Se ele modela, os membros perdem a modelagem até o grupo ser desarquivado.',
      ),
    ).toBeTruthy();
    await user.click(asked.getByRole('button', { name: 'Arquivar' }));

    await done('POST', '/api/admin/groups/g-1/archive');
    await read('g-1', { ...GROUP, isModeler: true, isArchived: true, version: 6 });

    expect(toasts()).toContain('Grupo arquivado.');
    expect(screen.getByText('Arquivado')).toBeTruthy();
  });

  it('an archived group gains no members and holds its Modeler grant suspended, and Desarquivar restores both', async () => {
    const user = await open({ ...GROUP, isModeler: true, isArchived: true });

    const add = screen.getByRole('button', { name: 'Adicionar membro' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText('Um grupo arquivado não recebe membros.').id).toBe(add.getAttribute('aria-describedby'));
    expect([modeling().checked, modeling().disabled]).toEqual([true, true]);
    expect(screen.getByText('Suspensa enquanto o grupo estiver arquivado.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Desarquivar' }));
    expect(dialog('Desarquivar Crédito?').getByText('O grupo volta a receber membros e a poder ser usado em novas versões. Se ele modela, os membros recuperam a modelagem.')).toBeTruthy();
    await user.click(dialog('Desarquivar Crédito?').getByRole('button', { name: 'Desarquivar' }));
    await done('POST', '/api/admin/groups/g-1/unarchive');
    await read('g-1', { ...GROUP, isModeler: true, version: 7 });

    expect((screen.getByRole('button', { name: 'Adicionar membro' }) as HTMLButtonElement).disabled).toBe(false);
    expect(modeling().disabled).toBe(false);
    expect(toasts()).toContain('Grupo desarquivado.');
  });

  it('says when the group does not exist, with the way back', async () => {
    await open(problem(404, 'not_found')[0], 404);

    expect(screen.getByText('Este grupo não existe.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para Grupos' }).getAttribute('href')).toBe('/administracao/grupos');
  });

  it('starts afresh when the router keeps the page for another group', async () => {
    const user = await open();
    await user.click(modeling());
    backend.expectOne({ method: 'PUT', url: '/api/admin/groups/g-1/modeler' }).flush(...problem(409, 'group_archived'));
    await settle();

    await TestBed.inject(Router).navigateByUrl('/administracao/grupos/g-2');
    await settle();
    backend.expectOne({ method: 'GET', url: '/api/admin/bots' }).flush(BOTS);
    await read('g-2', { ...GROUP, id: 'g-2', name: 'Cadastro', members: [] });

    expect(screen.getByRole('heading', { level: 1, name: 'Cadastro' })).toBeTruthy();
    expect(screen.queryByText('O grupo está arquivado.')).toBeNull();
    expect(screen.getByText('Nenhum membro ainda.')).toBeTruthy();
  });

  it.each(THEMES)('passes axe in the %s theme, with the page and the add member dialog', async (theme) => {
    applyTheme(theme);
    const user = await open({ ...GROUP, isArchived: false });
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: 'Adicionar membro' }));
    await user.type(dialog('Adicionar membro a Crédito').getByRole('searchbox', { name: 'Buscar por nome ou identificador' }), 'sin');
    await typingStops();
    backend.expectOne({ method: 'GET', url: '/api/admin/users?search=sin&limit=50&offset=0' }).flush({ items: [SINESIO], total: 1 });
    await settle();
    await expectNoAxeViolations();
  });
});
