import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { UsersPage } from './users-page';

const ANA = {
  id: 'u-ana',
  username: 'ana.souza',
  displayName: 'Ana Souza',
  isAdmin: true,
  isActive: true,
  isLocked: false,
  mustChangePassword: false,
  createdAt: '2026-10-01T12:00:00Z',
  version: 2,
  groups: [],
};
const BETO = { ...ANA, id: 'u-beto', username: 'beto', displayName: 'Beto Lima', isAdmin: false, isActive: false, isLocked: true, mustChangePassword: true };
const PASSWORD = 'k7Qm-temporaria-Zx9';
const FIRST = '/api/admin/users?limit=50&offset=0';
const USERNAME_TEXT = 'Use de 3 a 64 caracteres: letras minúsculas, dígitos, ponto, hífen ou sublinhado.';
const NAME_TEXT = 'Use um nome de 1 a 200 caracteres.';
const problem = (status: number, code: string) => [{ type: 'about:blank', title: code, status, code }, { status, statusText: code }] as const;

describe('UsersPage (admin-ui.md §4.1, §4.3, A1)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const typingStops = () => new Promise((resolve) => setTimeout(resolve, 350));
  const dialog = (name: string) => within(screen.getByRole('dialog', { name }));
  const searchbox = () => screen.getByRole('searchbox', { name: 'Buscar por nome ou usuário' });

  async function open(page: object = { items: [ANA, BETO], total: 2 }) {
    await render(UsersPage, {
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideJsdomInteractivity()],
    });
    backend = TestBed.inject(HttpTestingController);
    await answer(FIRST, page);
    return userEvent.setup();
  }
  async function answer(url: string, page: object) {
    backend.expectOne({ method: 'GET', url }).flush(page);
    await settle();
  }
  async function fillNewUser(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Novo usuário' }));
    const form = dialog('Novo usuário');
    await user.type(form.getByRole('textbox', { name: /^Usuário/ }), 'ana.souza');
    await user.type(form.getByRole('textbox', { name: /^Nome/ }), 'Ana Souza');
    return form;
  }

  afterEach(() => backend.verify());

  it('lists the users in a table: the name links to the user, then the username, the role and the state', async () => {
    await open();

    const table = screen.getByRole('table', { name: 'Usuários' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual(['Nome', 'Usuário', 'Papel', 'Situação']);
    const [, ana, beto] = within(table).getAllByRole('row');
    expect(within(ana).getByRole('link', { name: 'Ana Souza' }).getAttribute('href')).toBe('/administracao/usuarios/u-ana');
    expect(within(ana).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual(['ana.souza', 'Administrador', 'Ativo']);
    expect(within(beto).getByRole('rowheader').textContent?.trim()).toBe('Beto Lima');
    expect(within(beto).getAllByRole('cell')[1].textContent?.trim()).toBe('');
    expect(within(beto).getAllByRole('listitem').map((state) => state.textContent?.trim())).toEqual(['Inativo', 'Bloqueado', 'Troca de senha pendente']);
    expect(screen.getByText('2 usuários')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Páginas de usuários' })).toBeNull(); // a single page
  });

  it('pages by 50 with Anterior and Próxima, each disabled at its end', async () => {
    const user = await open({ items: [ANA, BETO], total: 120 });
    const previous = () => screen.getByRole('button', { name: 'Anterior' }) as HTMLButtonElement;
    const next = () => screen.getByRole('button', { name: 'Próxima' }) as HTMLButtonElement;
    expect([previous().disabled, next().disabled]).toEqual([true, false]);
    expect(screen.getByText('120 usuários')).toBeTruthy();
    expect(screen.getByText('1–50 de 120')).toBeTruthy();

    await user.click(next());
    await answer('/api/admin/users?limit=50&offset=50', { items: [ANA], total: 120 });
    await user.click(next());
    await answer('/api/admin/users?limit=50&offset=100', { items: [BETO], total: 120 });
    expect([previous().disabled, next().disabled]).toEqual([false, true]);
    expect(screen.getByText('101–120 de 120')).toBeTruthy();

    await user.click(previous());
    await answer('/api/admin/users?limit=50&offset=50', { items: [ANA], total: 120 });
    expect(screen.getByText('51–100 de 120')).toBeTruthy();
  });

  it('searches 300 ms after typing stops, from the first page', async () => {
    const user = await open({ items: [ANA, BETO], total: 120 });
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await answer('/api/admin/users?limit=50&offset=50', { items: [BETO], total: 120 });

    await user.type(searchbox(), 'ana');
    backend.expectNone((request) => request.url === '/api/admin/users');
    await typingStops();

    await answer('/api/admin/users?search=ana&limit=50&offset=0', { items: [ANA], total: 1 });
    expect(screen.getByText('1 usuário')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('shows only the answer to the latest search', async () => {
    const user = await open();

    await user.type(searchbox(), 'an');
    await typingStops();
    const stale = backend.expectOne({ method: 'GET', url: '/api/admin/users?search=an&limit=50&offset=0' });
    await user.type(searchbox(), 'a');
    await typingStops();

    expect(stale.cancelled).toBe(true);
    await answer('/api/admin/users?search=ana&limit=50&offset=0', { items: [ANA], total: 1 });
    expect(screen.getByText('1 usuário')).toBeTruthy();
  });

  it('says when no user matches the search', async () => {
    const user = await open();

    await user.type(searchbox(), 'zzz');
    await typingStops();
    await answer('/api/admin/users?search=zzz&limit=50&offset=0', { items: [], total: 0 });

    expect(screen.getByText('Nenhum usuário encontrado.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers Tentar de novo when the list does not load', async () => {
    await render(UsersPage, {
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideJsdomInteractivity()],
    });
    backend = TestBed.inject(HttpTestingController);
    backend.expectOne(FIRST).flush(...problem(403, 'forbidden'));
    await settle();

    expect(screen.getByText('Você não tem permissão para fazer isso.')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await answer(FIRST, { items: [ANA], total: 1 });
    expect(screen.getByRole('table', { name: 'Usuários' })).toBeTruthy();
  });

  it('creates a user, checking the fields as typed, then shows the temporary password once (§4.1, §4.3)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo usuário' }));
    const form = dialog('Novo usuário');
    const username = form.getByRole('textbox', { name: /^Usuário/ });

    await user.type(username, 'Ana');
    expect(form.getByText(USERNAME_TEXT)).toBeTruthy();
    await user.clear(username);
    await user.type(username, 'ana.souza');
    expect(form.queryByText(USERNAME_TEXT)).toBeNull();
    await user.type(form.getByRole('textbox', { name: /^Nome/ }), 'Ana Souza');
    await user.click(form.getByRole('checkbox', { name: 'Administrador' }));
    await user.click(form.getByRole('button', { name: 'Criar' }));

    const request = backend.expectOne({ method: 'POST', url: '/api/admin/users' });
    expect(request.request.body).toEqual({ username: 'ana.souza', displayName: 'Ana Souza', isAdmin: true });
    request.flush({ user: ANA, temporaryPassword: PASSWORD }, { status: 201, statusText: 'Created' });
    await settle();
    await answer(FIRST, { items: [ANA, BETO], total: 2 }); // the list behind it reloads

    const shown = dialog('Senha temporária de ana.souza');
    expect((shown.getByRole('textbox', { name: 'Senha temporária' }) as HTMLInputElement).value).toBe(PASSWORD);
    expect(
      shown.getByText('Esta senha aparece só agora. Entregue-a ao usuário por um canal seguro; ele vai trocá-la no primeiro acesso.'),
    ).toBeTruthy();
    await user.click(shown.getByRole('button', { name: 'Concluir' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(PASSWORD); // kept nowhere once closed (§4.3)
  });

  it('sends nothing while a field is missing or invalid, and says which', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo usuário' }));
    const form = dialog('Novo usuário');
    expect(form.queryByText(USERNAME_TEXT)).toBeNull(); // nothing typed yet

    await user.click(form.getByRole('button', { name: 'Criar' }));

    expect(form.getByText(USERNAME_TEXT)).toBeTruthy();
    expect(form.getByText(NAME_TEXT)).toBeTruthy();
    backend.expectNone({ method: 'POST', url: '/api/admin/users' });
  });

  it("shows the server's answer at its field: a username already in use", async () => {
    const user = await open();
    const form = await fillNewUser(user);
    await user.click(form.getByRole('button', { name: 'Criar' }));

    backend.expectOne({ method: 'POST', url: '/api/admin/users' }).flush(...problem(409, 'username_taken'));
    await settle();

    expect(form.getByText('Este identificador já está em uso.')).toBeTruthy();
    await user.type(form.getByRole('textbox', { name: /^Usuário/ }), '2');
    expect(form.queryByText('Este identificador já está em uso.')).toBeNull();
  });

  it('after a lost answer, Tentar de novo sends it again; a username then in use may be the first attempt', async () => {
    const user = await open();
    const form = await fillNewUser(user);
    await user.click(form.getByRole('button', { name: 'Criar' }));
    backend.expectOne({ method: 'POST', url: '/api/admin/users' }).error(new ProgressEvent('error'));
    await settle();
    expect(form.getByText('Não foi possível confirmar o envio.')).toBeTruthy();

    await user.click(form.getByRole('button', { name: 'Tentar de novo' }));
    const again = backend.expectOne({ method: 'POST', url: '/api/admin/users' });
    expect(again.request.body).toEqual({ username: 'ana.souza', displayName: 'Ana Souza', isAdmin: false });
    again.flush(...problem(409, 'username_taken'));
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByText(
        'Não foi possível confirmar a tentativa anterior. Se ela criou o usuário, a senha temporária se perdeu: redefina a senha na página do usuário.',
      ),
    ).toBeTruthy();
    await answer(FIRST, { items: [ANA, BETO], total: 2 });
  });

  it.each(THEMES)('passes axe in the %s theme, with the list and the new user dialog', async (theme) => {
    applyTheme(theme);
    const user = await open({ items: [ANA, BETO], total: 120 });
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: 'Novo usuário' }));
    await user.click(dialog('Novo usuário').getByRole('button', { name: 'Criar' })); // with its errors shown
    await expectNoAxeViolations();
  });
});
