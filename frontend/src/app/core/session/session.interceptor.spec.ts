import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../http/api-problem';
import { ANA } from '../../../testing/session';
import { sessionInterceptor } from './session.interceptor';
import { SessionService } from './session.service';

@Component({ template: '' })
class Blank {}

describe('sessionInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let router: Router;
  let session: SessionService;

  beforeEach(async () => {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        provideHttpClient(withInterceptors([sessionInterceptor, apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    session = TestBed.inject(SessionService);
    const loading = session.load();
    backend.expectOne('/api/auth/me').flush(ANA);
    await loading;
    await router.navigateByUrl('/solicitacoes/42?aba=dados');
  });

  afterEach(() => backend.verify());

  async function call(url: string, status: number, code: string): Promise<void> {
    const request = firstValueFrom(http.get(url)).catch(() => undefined);
    backend.expectOne(url).flush({ code }, { status, statusText: 'Error' });
    await request;
    await new Promise((resolve) => setTimeout(resolve));
  }

  it('signs out and asks to log in again, coming back to the current page', async () => {
    await call('/api/instances', 401, 'unauthenticated');

    expect(session.signedIn()).toBe(false);
    expect(router.url).toBe('/entrar?returnUrl=%2Fsolicitacoes%2F42%3Faba%3Ddados');
  });

  it('sends a user with a pending password change to the change page', async () => {
    await call('/api/instances', 403, 'password_change_required');

    expect(session.signedIn()).toBe(true);
    expect(router.url).toBe('/trocar-senha?returnUrl=%2Fsolicitacoes%2F42%3Faba%3Ddados');
  });

  it.each(['/api/auth/login', '/api/auth/me', '/api/auth/logout'])('leaves a 401 from %s to its caller', async (url) => {
    await call(url, 401, 'invalid_credentials');

    expect(router.url).toBe('/solicitacoes/42?aba=dados');
  });

  it('leaves other errors to the caller', async () => {
    await call('/api/instances', 403, 'forbidden');

    expect(session.signedIn()).toBe(true);
    expect(router.url).toBe('/solicitacoes/42?aba=dados');
  });
});
