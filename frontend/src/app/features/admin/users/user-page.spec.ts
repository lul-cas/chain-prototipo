import { DATE_PIPE_DEFAULT_OPTIONS } from '@angular/common';
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
import { UserPage } from './user-page';

const BETO = {
  id: 'u-beto',
  username: 'beto',
  displayName: 'Beto Lima',
  isAdmin: false,
  isActive: true,
  isLocked: true,
  mustChangePassword: false,
  createdAt: '2026-10-01T01:30:00Z',
  version: 7,
  groups: [
    { id: 'g-1', name: 'Crédito' },
    { id: 'g-2', name: 'Diretoria' },
  ],
};
const ANA = { ...BETO, id: 'u-ana', username: 'ana.souza', displayName: 'Ana Souza', isAdmin: true, isLocked: false, version: 2, groups: [] };
const PASSWORD = 'k7Qm-temporaria-Zx9';
const problem = (status: number, code: string) => [{ type: 'about:blank', title: code, status, code }, { status, statusText: code }] as const;

@Component({ template: '' })
class Elsewhere {}

describe('UserPage (admin-ui.md §4.2, §4.3, A1)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);
  const dialog = (name: string) => within(screen.getByRole('dialog', { name }));
  const facts = () => within(screen.getByRole('list', { name: 'Papel e situação' })).getAllByRole('listitem').map((item) => item.textContent?.trim());

  async function open(body: object = BETO, status = 200) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'administracao/usuarios/:id', component: UserPage },
            { path: '**', component: Elsewhere },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
        { provide: DATE_PIPE_DEFAULT_OPTIONS, useValue: { timezone: '-0300' } }, // as app.config.ts sets it
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/administracao/usuarios/u-beto');
    await read('u-beto', body, status);
    return userEvent.setup();
  }
  async function read(id: string, body: object, status = 200) {
    const request = backend.expectOne({ method: 'GET', url: `/api/admin/users/${id}` });
    if (status >= 400) {
      request.flush(body, { status, statusText: 'Erro' });
    } else {
      request.flush(body, { headers: { ETag: `"${(body as { version: number }).version}"` } });
    }
    await settle();
  }
  /** Goes to another user's page, which the router opens in this same page. */
  async function goTo(id: string) {
    await TestBed.inject(Router).navigateByUrl(`/administracao/usuarios/${id}`);
    await settle();
  }
  async function confirm(user: ReturnType<typeof userEvent.setup>, title: string, label: string) {
    await user.click(dialog(title).getByRole('button', { name: label }));
  }

  afterEach(() => backend.verify());

  it('shows the user: name, username, when it was created, role, state and groups', async () => {
    await open({ ...BETO, isAdmin: true, mustChangePassword: true });

    expect(screen.getByRole('heading', { level: 1, name: 'Beto Lima' })).toBeTruthy();
    expect(screen.getByText('beto').tagName).toBe('CODE');
    expect(screen.getByText('Criado em 30/09/2026')).toBeTruthy(); // 22:30 of the day before, in UTC−03:00 (#142)
    expect(facts()).toEqual(['Administrador', 'Ativo', 'Bloqueado', 'Troca de senha pendente']);
    const groups = within(screen.getByRole('region', { name: 'Grupos' }));
    expect(groups.getAllByRole('link').map((link) => [link.textContent?.trim(), link.getAttribute('href')])).toEqual([
      ['Crédito', '/administracao/grupos/g-1'],
      ['Diretoria', '/administracao/grupos/g-2'],
    ]); // membership is edited there (Q-AD2)
  });

  it('offers the actions that apply: Desativar or Ativar, Redefinir senha, and Desbloquear only when locked', async () => {
    await open();
    const names = () => screen.getAllByRole('button').map((button) => button.textContent?.trim());
    expect(names()).toEqual(['Editar', 'Desativar', 'Redefinir senha', 'Desbloquear']);

    await goTo('u-ana');
    await read('u-ana', { ...ANA, isActive: false });

    expect(names()).toEqual(['Editar', 'Ativar', 'Redefinir senha']);
    expect(screen.getByText('Nenhum grupo.')).toBeTruthy();
  });

  it('edits the name and the role with If-Match, and shows them', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    const form = dialog('Editar Beto Lima');
    expect(form.queryByRole('textbox', { name: /^Usuário/ })).toBeNull(); // a username doesn't change
    const name = form.getByRole('textbox', { name: /^Nome/ }) as HTMLInputElement;
    expect(name.value).toBe('Beto Lima');

    await user.clear(name);
    await user.type(name, '  Beto L. ');
    await user.click(form.getByRole('checkbox', { name: 'Administrador' }));
    await user.click(form.getByRole('button', { name: 'Salvar' }));

    const request = backend.expectOne({ method: 'PATCH', url: '/api/admin/users/u-beto' });
    expect(request.request.headers.get('If-Match')).toBe('"7"');
    expect(request.request.body).toEqual({ displayName: 'Beto L.', isAdmin: true });
    request.flush({ ...BETO, displayName: 'Beto L.', isAdmin: true, version: 8 }, { headers: { ETag: '"8"' } });
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Beto L.' })).toBeTruthy();
    expect(facts()[0]).toBe('Administrador');
    expect(toasts()).toContain('Usuário salvo.');

    await user.click(screen.getByRole('button', { name: 'Editar' })); // the next edit sends the new version
    await user.click(dialog('Editar Beto L.').getByRole('button', { name: 'Salvar' }));
    const next = backend.expectOne({ method: 'PATCH', url: '/api/admin/users/u-beto' });
    expect(next.request.headers.get('If-Match')).toBe('"8"');
    next.flush({ ...BETO, displayName: 'Beto L.', isAdmin: true, version: 9 }, { headers: { ETag: '"9"' } });
    await settle();
  });

  it('says when the user changed meanwhile, and Recarregar fills the dialog with what the server has (§9)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    const form = dialog('Editar Beto Lima');
    await user.type(form.getByRole('textbox', { name: /^Nome/ }), ' Jr.');
    await user.click(form.getByRole('button', { name: 'Salvar' }));
    backend.expectOne({ method: 'PATCH', url: '/api/admin/users/u-beto' }).flush(...problem(412, 'version_mismatch'));
    await settle();

    expect(form.getByText('Este usuário mudou desde que você o abriu.')).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Recarregar' }));
    await read('u-beto', { ...BETO, displayName: 'Roberto Lima', version: 8 });

    expect((form.getByRole('textbox', { name: /^Nome/ }) as HTMLInputElement).value).toBe('Roberto Lima');
    expect(form.queryByText('Este usuário mudou desde que você o abriu.')).toBeNull();
    await user.click(form.getByRole('button', { name: 'Salvar' }));
    const again = backend.expectOne({ method: 'PATCH', url: '/api/admin/users/u-beto' });
    expect(again.request.headers.get('If-Match')).toBe('"8"');
    again.flush({ ...BETO, displayName: 'Roberto Lima', version: 9 }, { headers: { ETag: '"9"' } });
    await settle();
  });

  it('shows the last admin rule in the dialog', async () => {
    const user = await open({ ...BETO, isAdmin: true });
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    const form = dialog('Editar Beto Lima');
    await user.click(form.getByRole('checkbox', { name: 'Administrador' }));
    await user.click(form.getByRole('button', { name: 'Salvar' }));

    backend.expectOne({ method: 'PATCH', url: '/api/admin/users/u-beto' }).flush(...problem(409, 'last_admin'));
    await settle();

    expect(form.getByText('O Chain precisa de pelo menos um administrador ativo.')).toBeTruthy();
  });

  it('deactivates after asking, then shows the new state', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    const asked = dialog('Desativar Beto Lima?');
    expect(asked.getByText('Beto Lima não poderá entrar, e as sessões abertas terminam agora.')).toBeTruthy();
    await confirm(user, 'Desativar Beto Lima?', 'Desativar');

    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-beto/deactivate' }).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await read('u-beto', { ...BETO, isActive: false, version: 8 });

    expect(facts()).toEqual(['Inativo', 'Bloqueado']);
    expect(toasts()).toContain('Usuário desativado.');
    expect(screen.getByRole('button', { name: 'Ativar' })).toBeTruthy();
  });

  it('sends nothing when the question is cancelled', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    await confirm(user, 'Desativar Beto Lima?', 'Cancelar');

    backend.expectNone({ method: 'POST', url: '/api/admin/users/u-beto/deactivate' });
  });

  it.each([
    ['Ativar', 'activate', 'Beto Lima poderá entrar de novo.', 'Usuário ativado.', { ...BETO, isActive: false }],
    ['Desbloquear', 'unlock', 'Beto Lima poderá tentar entrar de novo agora, sem esperar o bloqueio terminar.', 'Usuário desbloqueado.', BETO],
  ])('%s asks first, then sends it and reads the user again', async (label, action, message, toast, shown) => {
    const user = await open(shown);
    await user.click(screen.getByRole('button', { name: label }));
    expect(dialog(`${label} Beto Lima?`).getByText(message)).toBeTruthy();
    await confirm(user, `${label} Beto Lima?`, label);

    backend.expectOne({ method: 'POST', url: `/api/admin/users/u-beto/${action}` }).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await read('u-beto', { ...BETO, isActive: true, isLocked: false, version: 8 });

    expect(facts()).toEqual(['Ativo']);
    expect(toasts()).toContain(toast);
  });

  it("shows the server's rule when an admin deactivates their own account", async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    await confirm(user, 'Desativar Beto Lima?', 'Desativar');

    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-beto/deactivate' }).flush(...problem(409, 'cannot_deactivate_self'));
    await settle();

    expect(screen.getByText('Você não pode desativar a própria conta.')).toBeTruthy();
  });

  it('after a lost answer, Tentar de novo sends the same action again without asking', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    await confirm(user, 'Desativar Beto Lima?', 'Desativar');
    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-beto/deactivate' }).error(new ProgressEvent('error'));
    await settle();
    expect(screen.getByText('Não foi possível confirmar a desativação.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-beto/deactivate' }).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await read('u-beto', { ...BETO, isActive: false, version: 8 });
    expect(screen.queryByText('Não foi possível confirmar a desativação.')).toBeNull();
  });

  it('resets the password after asking, then shows the new one once (§4.3)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    expect(
      dialog('Redefinir a senha de Beto Lima?').getByText(
        'Uma nova senha temporária é criada, as sessões abertas terminam e a conta é desbloqueada. A senha aparece em seguida, uma única vez.',
      ),
    ).toBeTruthy();
    await confirm(user, 'Redefinir a senha de Beto Lima?', 'Redefinir senha');

    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-beto/reset-password' }).flush({ temporaryPassword: PASSWORD });
    await settle();
    await read('u-beto', { ...BETO, isLocked: false, mustChangePassword: true, version: 8 });

    const shown = dialog('Senha temporária de beto');
    expect((shown.getByRole('textbox', { name: 'Senha temporária' }) as HTMLInputElement).value).toBe(PASSWORD);
    await user.click(shown.getByRole('button', { name: 'Concluir' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(facts()).toEqual(['Ativo', 'Troca de senha pendente']); // read again behind the dialog
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });

  it('says that a lost reset gets a new password on Tentar de novo', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    await confirm(user, 'Redefinir a senha de Beto Lima?', 'Redefinir senha');
    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-beto/reset-password' }).error(new ProgressEvent('error'));
    await settle();

    expect(screen.getByText('Não foi possível confirmar a nova senha. Tente de novo para gerar outra.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-beto/reset-password' }).flush({ temporaryPassword: PASSWORD });
    await settle();
    await read('u-beto', { ...BETO, isLocked: false, mustChangePassword: true, version: 8 });
    expect(dialog('Senha temporária de beto')).toBeTruthy();
  });

  it('says when the user does not exist, with the way back', async () => {
    await open(problem(404, 'not_found')[0], 404);

    expect(screen.getByText('Este usuário não existe.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para Usuários' }).getAttribute('href')).toBe('/administracao/usuarios');
  });

  it("starts afresh when the router keeps the page for another user: the old user's message is gone", async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    await confirm(user, 'Desativar Beto Lima?', 'Desativar');
    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-beto/deactivate' }).flush(...problem(409, 'cannot_deactivate_self'));
    await settle();

    await goTo('u-ana');
    await read('u-ana', ANA);

    expect(screen.getByRole('heading', { level: 1, name: 'Ana Souza' })).toBeTruthy();
    expect(screen.queryByText('Você não pode desativar a própria conta.')).toBeNull();
  });

  it.each(THEMES)('passes axe in the %s theme', async (theme) => {
    applyTheme(theme);
    const user = await open({ ...BETO, mustChangePassword: true });
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: 'Editar' }));
    await expectNoAxeViolations();
  });
});
