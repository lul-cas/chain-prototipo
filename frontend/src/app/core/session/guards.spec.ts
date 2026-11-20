import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { apiProblemInterceptor } from '../http/api-problem';
import { Me } from '../http/auth-api';
import { ANA } from '../../../testing/session';
import { canModel, isAdmin, passwordChangeAllowed, signedIn, signedOut } from './guards';
import { safeReturnUrl } from './return-url';
import { SessionService } from './session.service';

@Component({ template: '' })
class Blank {}

describe('session guards', () => {
  let router: Router;

  async function start(me: Me | null, url: string): Promise<string> {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'entrar', component: Blank, canActivate: [signedOut] },
          { path: 'trocar-senha', component: Blank, canActivate: [passwordChangeAllowed] },
          { path: 'processos', component: Blank, canActivate: [signedIn, canModel] },
          { path: 'administracao/destinos', component: Blank, canActivate: [signedIn, isAdmin] },
          { path: '**', component: Blank, canActivate: [signedIn] },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    router = TestBed.inject(Router);
    const backend = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(SessionService).load();
    const request = backend.expectOne('/api/auth/me');
    if (me) {
      request.flush(me);
    } else {
      request.flush({ code: 'unauthenticated' }, { status: 401, statusText: 'Unauthorized' });
    }
    await loading;
    await router.navigateByUrl(url);
    return router.url;
  }

  it('sends a signed-out visitor to the login page with the page as return URL', async () => {
    expect(await start(null, '/solicitacoes?status=running')).toBe('/entrar?returnUrl=%2Fsolicitacoes%3Fstatus%3Drunning');
  });

  it('lets a signed-in user in', async () => {
    expect(await start(ANA, '/solicitacoes')).toBe('/solicitacoes');
  });

  it('holds a user with a pending password change on the change page', async () => {
    expect(await start({ ...ANA, mustChangePassword: true }, '/solicitacoes')).toBe('/trocar-senha?returnUrl=%2Fsolicitacoes');
  });

  it('sends a signed-in user away from the login page', async () => {
    expect(await start(ANA, '/entrar')).toBe('/');
  });

  it('shows the login page to a signed-out visitor', async () => {
    expect(await start(null, '/entrar')).toBe('/entrar');
  });

  it('lets those who can model reach the processes, and shows anyone else the not-found page (workflow-editor.md §10.1)', async () => {
    expect(await start({ ...ANA, canModel: true }, '/processos')).toBe('/processos');
    expect(await start(ANA, '/processos')).toBe('/nao-encontrado');
  });

  it('lets admins reach the admin pages, and shows a Modeler the not-found page (automation-ui.md §2)', async () => {
    expect(await start({ ...ANA, isAdmin: true, canModel: true }, '/administracao/destinos')).toBe('/administracao/destinos');
    expect(await start({ ...ANA, canModel: true }, '/administracao/destinos')).toBe('/nao-encontrado');
  });

  it('lets any signed-in user change the password, and asks others to log in first', async () => {
    expect(await start(ANA, '/trocar-senha')).toBe('/trocar-senha');
    expect(await start(null, '/trocar-senha')).toBe('/entrar?returnUrl=%2Ftrocar-senha');
  });
});

describe('safeReturnUrl', () => {
  it.each([
    ['/solicitacoes/42?aba=dados', '/solicitacoes/42?aba=dados'],
    [null, '/'],
    ['', '/'],
    ['https://evil.example/', '/'],
    ['//evil.example/path', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/entrar?returnUrl=%2F', '/'],
  ])('accepts only paths inside the app: %s → %s', (value, expected) => {
    expect(safeReturnUrl(value)).toBe(expected);
  });
});
