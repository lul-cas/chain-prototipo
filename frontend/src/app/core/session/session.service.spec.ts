import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { apiProblemInterceptor, isApiProblem } from '../http/api-problem';
import { Me } from '../http/auth-api';
import { ANA } from '../../../testing/session';
import { SessionService } from './session.service';

describe('SessionService', () => {
  let session: SessionService;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    session = TestBed.inject(SessionService);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  const flushMe = (me: Me) => backend.expectOne({ method: 'GET', url: '/api/auth/me' }).flush(me);
  const unauthorized = { status: 401, statusText: 'Unauthorized' };

  it('loads the signed-in user', async () => {
    const loading = session.load();
    flushMe(ANA);

    expect(await loading).toEqual(ANA);
    expect(session.signedIn()).toBe(true);
    expect(session.user()?.displayName).toBe('Ana Souza');
    expect(session.mustChangePassword()).toBe(false);
  });

  it('treats 401 from /me as signed out', async () => {
    const loading = session.load();
    backend.expectOne('/api/auth/me').flush({ code: 'unauthenticated' }, unauthorized);

    expect(await loading).toBeNull();
    expect(session.signedIn()).toBe(false);
    expect(session.user()).toBeNull();
  });

  it('logs in and then loads the user, who may have to change the password', async () => {
    const login = session.login('ana', 'temporary-password');
    const request = backend.expectOne({ method: 'POST', url: '/api/auth/login' });
    expect(request.request.body).toEqual({ username: 'ana', password: 'temporary-password' });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await Promise.resolve();
    flushMe({ ...ANA, mustChangePassword: true });

    expect((await login).mustChangePassword).toBe(true);
    expect(session.mustChangePassword()).toBe(true);
  });

  it('rejects a failed login with the API problem and stays signed out', async () => {
    const login = session.login('ana', 'wrong');
    backend.expectOne('/api/auth/login').flush({ code: 'invalid_credentials' }, unauthorized);

    const error = await login.then(
      () => null,
      (e: unknown) => e,
    );
    expect(isApiProblem(error) && error.code).toBe('invalid_credentials');
    expect(session.signedIn()).toBe(false);
  });

  it('changes the password and reloads the user', async () => {
    const loading = session.load();
    flushMe({ ...ANA, mustChangePassword: true });
    await loading;

    const change = session.changePassword('temporary-password', 'a-much-longer-password');
    const request = backend.expectOne({ method: 'POST', url: '/api/auth/change-password' });
    expect(request.request.body).toEqual({ currentPassword: 'temporary-password', newPassword: 'a-much-longer-password' });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await Promise.resolve();
    flushMe(ANA);
    await change;

    expect(session.mustChangePassword()).toBe(false);
  });

  it('logs out, and forgets the user even when the session had already ended', async () => {
    const loading = session.load();
    flushMe(ANA);
    await loading;

    const logout = session.logout();
    backend.expectOne({ method: 'POST', url: '/api/auth/logout' }).flush({ code: 'unauthenticated' }, unauthorized);
    await logout;

    expect(session.signedIn()).toBe(false);
  });
});
