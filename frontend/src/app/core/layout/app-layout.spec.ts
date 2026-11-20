import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../http/api-problem';
import { SessionService } from '../session/session.service';
import { expectNoAxeViolations } from '../../../testing/axe';
import { ANA } from '../../../testing/session';
import { THEMES, applyTheme } from '../../../testing/themes';
import { AppLayout } from './app-layout';

@Component({ template: '<p>login</p>' })
class Login {}

@Component({ template: '<h1>Conteúdo</h1>' })
class Content {}

describe('AppLayout', () => {
  let backend: HttpTestingController;
  let router: Router;

  async function open(me = ANA): Promise<void> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'entrar', component: Login },
          { path: '', component: AppLayout, children: [{ path: 'tarefas', component: Content }] },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    const loading = TestBed.inject(SessionService).load();
    backend.expectOne('/api/auth/me').flush(me);
    await loading;
    await RouterTestingHarness.create('/tarefas');
  }

  afterEach(() => backend.verify());

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('shows who is signed in, the theme switch, "Sair" and the page', async () => {
      await open();

      expect(screen.getByText('Ana Souza')).toBeTruthy();
      expect(screen.getByRole('radiogroup', { name: 'Tema' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sair' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Tarefas' }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('heading', { level: 1, name: 'Conteúdo' })).toBeTruthy();
      await expectNoAxeViolations();
    });
  });

  it('offers "Processos" only to those who can model (workflow-editor.md §10.1)', async () => {
    await open();
    expect(screen.queryByRole('link', { name: 'Processos' })).toBeNull();

    await open({ ...ANA, canModel: true });
    expect(screen.getByRole('link', { name: 'Processos' }).getAttribute('href')).toBe('/processos');
  });

  it('offers "Formulários" after "Processos", only to those who can model (form-designer.md §12.1)', async () => {
    await open();
    expect(screen.queryByRole('link', { name: 'Formulários' })).toBeNull();

    await open({ ...ANA, canModel: true });
    const links = screen.getAllByRole('link').map((link) => link.textContent?.trim());
    expect(links.indexOf('Formulários')).toBe(links.indexOf('Processos') + 1);
    expect(links.indexOf('Automações')).toBe(links.indexOf('Formulários') + 1); // automation-ui.md §2
    expect(screen.getByRole('link', { name: 'Formulários' }).getAttribute('href')).toBe('/formularios');
  });

  it('offers the Administração group only to admins: Usuários, Grupos and Bots, then Destinos and Credenciais (automation-ui.md §2; admin-ui.md §3)', async () => {
    await open({ ...ANA, canModel: true });
    expect(screen.queryByRole('group', { name: 'Administração' })).toBeNull();

    await open({ ...ANA, isAdmin: true, canModel: true });
    const admin = within(screen.getByRole('group', { name: 'Administração' }));
    expect(admin.getAllByRole('link').map((link) => link.textContent?.trim())).toEqual(['Usuários', 'Grupos', 'Bots', 'Destinos', 'Credenciais']);
    expect(admin.getByRole('link', { name: 'Usuários' }).getAttribute('href')).toBe('/administracao/usuarios');
    expect(admin.getByRole('link', { name: 'Grupos' }).getAttribute('href')).toBe('/administracao/grupos');
    expect(admin.getByRole('link', { name: 'Bots' }).getAttribute('href')).toBe('/administracao/bots');
    expect(admin.getByRole('link', { name: 'Destinos' }).getAttribute('href')).toBe('/administracao/destinos');
    expect(admin.getByRole('link', { name: 'Credenciais' }).getAttribute('href')).toBe('/administracao/credenciais');
  });

  it('signs out and goes to the login page', async () => {
    await open();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }));
    backend.expectOne({ method: 'POST', url: '/api/auth/logout' }).flush(null, { status: 204, statusText: 'No Content' });
    await new Promise((resolve) => setTimeout(resolve));

    expect(router.url).toBe('/entrar');
    expect(TestBed.inject(SessionService).signedIn()).toBe(false);
  });
});
