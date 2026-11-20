import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { Me } from '../../core/http/auth-api';
import { SessionService } from '../../core/session/session.service';
import { ToastService } from '../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../testing/axe';
import { ANA } from '../../../testing/session';
import { THEMES, applyTheme } from '../../../testing/themes';
import { ChangePasswordPage } from './change-password-page';

@Component({ template: '<p>destino</p>' })
class Destination {}

const NEW_PASSWORD = 'uma-senha-bem-comprida';

describe('ChangePasswordPage', () => {
  let backend: HttpTestingController;
  let router: Router;

  async function open(me: Me, url = '/trocar-senha'): Promise<void> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'trocar-senha', component: ChangePasswordPage },
          { path: '**', component: Destination },
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
    await RouterTestingHarness.create(url);
  }

  afterEach(() => backend.verify());

  const current = () => screen.getByLabelText(/^Senha atual/);
  const next = () => screen.getByLabelText(/^Nova senha/);
  const confirmation = () => screen.getByLabelText(/^Confirme a nova senha/);

  async function fill(currentValue: string, nextValue: string, confirmationValue: string): Promise<void> {
    const user = userEvent.setup();
    if (currentValue) {
      await user.type(current(), currentValue);
    }
    if (nextValue) {
      await user.type(next(), nextValue);
    }
    if (confirmationValue) {
      await user.type(confirmation(), confirmationValue);
    }
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve));

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('explains a forced change and offers only "Sair" besides the change', async () => {
      await open({ ...ANA, mustChangePassword: true });

      expect(screen.getByRole('heading', { level: 1, name: 'Trocar senha' })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('defina uma nova senha antes de continuar');
      expect(screen.getByRole('button', { name: 'Sair' })).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Cancelar' })).toBeNull();
      expect(next().getAttribute('autocomplete')).toBe('new-password');
      expect(screen.getAllByRole('button', { name: 'Mostrar senha' })).toHaveLength(3);
      await expectNoAxeViolations();
    });
  });

  it('lets a voluntary change be cancelled', async () => {
    await open(ANA);

    expect(screen.getByRole('link', { name: 'Cancelar' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('button', { name: 'Sair' })).toBeNull();
  });

  it.each([
    ['', '', '', ['Informe a senha atual.', 'Informe a nova senha.', 'Confirme a nova senha.']],
    ['temporaria', 'curta', 'curta', ['A nova senha precisa ter pelo menos 12 caracteres.']],
    ['temporaria', NEW_PASSWORD, 'outra-senha-comprida', ['As senhas não coincidem.']],
  ])('checks the fields in the browser first (%s / %s / %s)', async (currentValue, nextValue, confirmationValue, errors) => {
    await open({ ...ANA, mustChangePassword: true });

    await fill(currentValue, nextValue, confirmationValue);

    for (const error of errors) {
      expect(await screen.findByText(error)).toBeTruthy();
    }
    backend.expectNone('/api/auth/change-password');
  });

  it('marks the current password when the server rejects it', async () => {
    await open({ ...ANA, mustChangePassword: true });

    await fill('errada', NEW_PASSWORD, NEW_PASSWORD);
    backend.expectOne('/api/auth/change-password').flush({ code: 'invalid_current_password' }, { status: 403, statusText: 'Forbidden' });

    expect(await screen.findByText('A senha atual está incorreta.')).toBeTruthy();
    expect(current().getAttribute('aria-invalid')).toBe('true');
  });

  it('marks the new password with the policy the server enforces', async () => {
    await open({ ...ANA, mustChangePassword: true });

    await fill('temporaria', 'ana-ana-ana-ana', 'ana-ana-ana-ana');
    backend
      .expectOne('/api/auth/change-password')
      .flush({ code: 'validation_failed', errors: ['password_equals_username'] }, { status: 400, statusText: 'Bad Request' });

    expect(await screen.findByText('A nova senha não pode ser igual ao nome de usuário.')).toBeTruthy();
    expect(next().getAttribute('aria-invalid')).toBe('true');
  });

  it('changes the password, confirms it and continues to the return URL', async () => {
    await open({ ...ANA, mustChangePassword: true }, '/trocar-senha?returnUrl=%2Fsolicitacoes');
    const toasts = TestBed.inject(ToastService);

    await fill('temporaria', NEW_PASSWORD, NEW_PASSWORD);
    const request = backend.expectOne('/api/auth/change-password');
    expect(request.request.body).toEqual({ currentPassword: 'temporaria', newPassword: NEW_PASSWORD });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    backend.expectOne('/api/auth/me').flush(ANA);
    await settle();

    expect(router.url).toBe('/solicitacoes');
    expect(toasts.toasts().map((t) => t.message)).toEqual(['Senha alterada.']);
  });

  it('signs out from a forced change', async () => {
    await open({ ...ANA, mustChangePassword: true });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }));
    backend.expectOne({ method: 'POST', url: '/api/auth/logout' }).flush(null, { status: 204, statusText: 'No Content' });
    await settle();

    expect(router.url).toBe('/entrar');
  });
});
