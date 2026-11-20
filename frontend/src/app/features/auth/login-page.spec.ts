import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../testing/axe';
import { ANA } from '../../../testing/session';
import { THEMES, applyTheme } from '../../../testing/themes';
import { LoginPage } from './login-page';

@Component({ template: '<p>destino</p>' })
class Destination {}

describe('LoginPage', () => {
  let backend: HttpTestingController;
  let router: Router;
  let harness: RouterTestingHarness;

  async function open(url = '/entrar'): Promise<void> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'entrar', component: LoginPage },
          { path: '**', component: Destination },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    harness = await RouterTestingHarness.create(url);
  }

  afterEach(() => backend.verify());

  async function logIn(username: string, password: string): Promise<void> {
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Usuário/ }), username);
    await user.type(screen.getByLabelText(/^Senha/), password);
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
  }

  async function answerLogin(): Promise<void> {
    backend.expectOne({ method: 'POST', url: '/api/auth/login' }).flush(null, { status: 204, statusText: 'No Content' });
    await new Promise((resolve) => setTimeout(resolve));
  }

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('asks for the username and the password, with a "Mostrar senha" toggle', async () => {
      await open();

      expect(screen.getByRole('heading', { level: 1, name: 'Entrar' })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: /Usuário/ }).getAttribute('autocomplete')).toBe('username');
      expect(screen.getByLabelText(/^Senha/).getAttribute('autocomplete')).toBe('current-password');
      expect(screen.getByRole('button', { name: 'Mostrar senha' })).toBeTruthy();
      await expectNoAxeViolations();
    });
  });

  it('shows field errors for empty fields without calling the API', async () => {
    await open();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByText('Informe o usuário.')).toBeTruthy();
    expect(screen.getByText('Informe a senha.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /Usuário/ }));
    backend.expectNone('/api/auth/login');
  });

  it('shows one generic message for wrong credentials', async () => {
    await open();

    await logIn('ana', 'wrong-password');
    backend.expectOne('/api/auth/login').flush({ code: 'invalid_credentials' }, { status: 401, statusText: 'Unauthorized' });

    expect((await screen.findByRole('alert')).textContent).toContain('Usuário ou senha inválidos.');
    expect(router.url).toBe('/entrar');
  });

  it('explains when the server cannot be reached', async () => {
    await open();

    await logIn('ana', 'a-password');
    backend.expectOne('/api/auth/login').error(new ProgressEvent('error'), { status: 0 });

    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível falar com o servidor.');
  });

  it('sends the username without surrounding spaces and the password as typed', async () => {
    await open();

    await logIn('  Ana ', ' a password ');
    const request = backend.expectOne('/api/auth/login');

    expect(request.request.body).toEqual({ username: 'Ana', password: ' a password ' });
    request.flush({ code: 'invalid_credentials' }, { status: 401, statusText: 'Unauthorized' });
    await screen.findByRole('alert');
  });

  it('logs in, loads the user and opens the return URL', async () => {
    await open('/entrar?returnUrl=%2Fsolicitacoes%2F42');

    await logIn('ana', 'a-password');
    await answerLogin();
    backend.expectOne('/api/auth/me').flush(ANA);

    await harness.fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    expect(router.url).toBe('/solicitacoes/42');
  });

  it('ignores a return URL that points outside the app', async () => {
    await open('/entrar?returnUrl=https%3A%2F%2Fevil.example');

    await logIn('ana', 'a-password');
    await answerLogin();
    backend.expectOne('/api/auth/me').flush(ANA);

    await new Promise((resolve) => setTimeout(resolve));
    expect(router.url).toBe('/');
  });

  it('takes a user with a temporary password to the change page, keeping the return URL', async () => {
    await open('/entrar?returnUrl=%2Fsolicitacoes');

    await logIn('ana', 'temporary-password');
    await answerLogin();
    backend.expectOne('/api/auth/me').flush({ ...ANA, mustChangePassword: true });

    await new Promise((resolve) => setTimeout(resolve));
    expect(router.url).toBe('/trocar-senha?returnUrl=%2Fsolicitacoes');
  });
});
