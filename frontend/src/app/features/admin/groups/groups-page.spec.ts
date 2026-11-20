import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { GroupsPage } from './groups-page';

const CREDITO = { id: 'g-1', name: 'Crédito', description: 'Análise de crédito', isArchived: false, isModeler: true, memberCount: 2 };
const CADASTRO = { id: 'g-2', name: 'Cadastro', description: null, isArchived: false, isModeler: false, memberCount: 0 };
const ANTIGO = { id: 'g-3', name: 'Antigo', description: null, isArchived: true, isModeler: true, memberCount: 1 };
const NAME_TEXT = 'Use um nome de 1 a 100 caracteres.';
const problem = (status: number, code: string) => [{ type: 'about:blank', title: code, status, code }, { status, statusText: code }] as const;

describe('GroupsPage (admin-ui.md §5.1, A2)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);
  const dialog = (name: string) => within(screen.getByRole('dialog', { name }));

  async function open(groups: object[] = [CREDITO, CADASTRO]) {
    await render(GroupsPage, {
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideJsdomInteractivity()],
    });
    backend = TestBed.inject(HttpTestingController);
    await answer('/api/admin/groups', groups);
    return userEvent.setup();
  }
  async function answer(url: string, groups: object[]) {
    backend.expectOne({ method: 'GET', url }).flush(groups);
    await settle();
  }
  async function fillNewGroup(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Novo grupo' }));
    const form = dialog('Novo grupo');
    await user.type(form.getByRole('textbox', { name: /^Nome/ }), 'Jurídico');
    await user.type(form.getByRole('textbox', { name: /^Descrição/ }), 'Pareceres');
    return form;
  }

  afterEach(() => backend.verify());

  it('lists the groups in a table: the name links to the group, then the description, members, Modelagem and Situação', async () => {
    await open();

    const table = screen.getByRole('table', { name: 'Grupos' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Nome',
      'Descrição',
      'Membros',
      'Modelagem',
      'Situação',
    ]);
    const [, credito, cadastro] = within(table).getAllByRole('row');
    expect(within(credito).getByRole('link', { name: 'Crédito' }).getAttribute('href')).toBe('/administracao/grupos/g-1');
    expect(within(credito).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual(['Análise de crédito', '2', 'Modela processos', '']);
    expect(within(cadastro).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual(['', '0', '', '']);
  });

  it('adds the archived groups with Mostrar arquivados', async () => {
    const user = await open();

    await user.click(screen.getByRole('checkbox', { name: 'Mostrar arquivados' }));
    await answer('/api/admin/groups?includeArchived=true', [ANTIGO, CADASTRO, CREDITO]);

    const antigo = screen.getAllByRole('row')[1];
    expect(within(antigo).getByRole('rowheader').textContent?.trim()).toBe('Antigo');
    expect(within(antigo).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual(['', '1', 'Modela processos', 'Arquivado']);

    await user.click(screen.getByRole('checkbox', { name: 'Mostrar arquivados' }));
    await answer('/api/admin/groups', [CADASTRO, CREDITO]);
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('says when there is no group yet', async () => {
    await open([]);

    expect(screen.getByText('Nenhum grupo ainda. Crie o primeiro com “Novo grupo”.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('creates a group, checking the fields as typed, and lists it', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo grupo' }));
    const form = dialog('Novo grupo');
    const name = form.getByRole('textbox', { name: /^Nome/ });

    await user.type(name, 'x'.repeat(101));
    expect(form.getByText(NAME_TEXT)).toBeTruthy();
    await user.clear(name);
    await user.type(name, '  Jurídico ');
    await user.type(form.getByRole('textbox', { name: /^Descrição/ }), 'Pareceres');
    expect(form.getByText('9/500 caracteres')).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Criar' }));

    const request = backend.expectOne({ method: 'POST', url: '/api/admin/groups' });
    expect(request.request.body).toEqual({ name: 'Jurídico', description: 'Pareceres' });
    request.flush({ ...CADASTRO, id: 'g-4', name: 'Jurídico', description: 'Pareceres', version: 1, members: [] }, { status: 201, statusText: 'Created' });
    await settle();

    await answer('/api/admin/groups', [CADASTRO, CREDITO, { ...CADASTRO, id: 'g-4', name: 'Jurídico' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toasts()).toContain('Grupo criado.');
  });

  it('sends a blank description as none, and nothing while the name is missing', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo grupo' }));
    const form = dialog('Novo grupo');

    await user.click(form.getByRole('button', { name: 'Criar' }));
    expect(form.getByText(NAME_TEXT)).toBeTruthy();
    backend.expectNone({ method: 'POST', url: '/api/admin/groups' });

    await user.type(form.getByRole('textbox', { name: /^Nome/ }), 'Jurídico');
    await user.type(form.getByRole('textbox', { name: /^Descrição/ }), '   ');
    await user.click(form.getByRole('button', { name: 'Criar' }));
    const request = backend.expectOne({ method: 'POST', url: '/api/admin/groups' });
    expect(request.request.body).toEqual({ name: 'Jurídico', description: null });
    request.flush({ ...CADASTRO, version: 1, members: [] }, { status: 201, statusText: 'Created' });
    await settle();
    await answer('/api/admin/groups', [CADASTRO, CREDITO]);
  });

  it("shows the server's answer at its field: a name already in use", async () => {
    const user = await open();
    const form = await fillNewGroup(user);
    await user.click(form.getByRole('button', { name: 'Criar' }));

    backend.expectOne({ method: 'POST', url: '/api/admin/groups' }).flush(...problem(409, 'group_name_taken'));
    await settle();

    expect(form.getByText('Já existe um grupo com este nome.')).toBeTruthy();
  });

  it('after a lost answer, Tentar de novo sends it again; a name then in use may be the first attempt', async () => {
    const user = await open();
    const form = await fillNewGroup(user);
    await user.click(form.getByRole('button', { name: 'Criar' }));
    backend.expectOne({ method: 'POST', url: '/api/admin/groups' }).error(new ProgressEvent('error'));
    await settle();

    await user.click(form.getByRole('button', { name: 'Tentar de novo' }));
    backend.expectOne({ method: 'POST', url: '/api/admin/groups' }).flush(...problem(409, 'group_name_taken'));
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Não foi possível confirmar a tentativa anterior. Se ela criou o grupo, ele já está na lista.')).toBeTruthy();
    await answer('/api/admin/groups', [CADASTRO, CREDITO]);
  });

  it.each(THEMES)('passes axe in the %s theme, with the list and the new group dialog', async (theme) => {
    applyTheme(theme);
    const user = await open([CREDITO, CADASTRO, ANTIGO]);
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: 'Novo grupo' }));
    await user.click(dialog('Novo grupo').getByRole('button', { name: 'Criar' }));
    await expectNoAxeViolations();
  });
});
