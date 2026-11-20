import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { UsersApi } from './users-api';

const ANA = {
  id: 'u-ana',
  username: 'ana.souza',
  displayName: 'Ana Souza',
  isAdmin: false,
  isActive: true,
  isLocked: false,
  mustChangePassword: true,
  createdAt: '2026-10-19T12:00:00Z',
  version: 4,
  groups: [{ id: 'g-1', name: 'Crédito' }],
};

describe('UsersApi (identity.md I2)', () => {
  let api: UsersApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()] });
    api = TestBed.inject(UsersApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('lists a page of 50, sending the search only when there is one, without its spaces', async () => {
    const first = firstValueFrom(api.list('', 0));
    backend.expectOne({ method: 'GET', url: '/api/admin/users?limit=50&offset=0' }).flush({ items: [ANA], total: 1 });
    expect(await first).toEqual({ items: [ANA], total: 1 });

    const searched = firstValueFrom(api.list('  ana ', 50));
    backend.expectOne({ method: 'GET', url: '/api/admin/users?search=ana&limit=50&offset=50' }).flush({ items: [], total: 0 });
    expect(await searched).toEqual({ items: [], total: 0 });

    const blank = firstValueFrom(api.list('   ', 0));
    backend.expectOne({ method: 'GET', url: '/api/admin/users?limit=50&offset=0' }).flush({ items: [], total: 0 });
    await blank;
  });

  it('reads a user with its ETag, and edits the name and role with If-Match', async () => {
    const read = firstValueFrom(api.get('u-ana'));
    backend.expectOne({ method: 'GET', url: '/api/admin/users/u-ana' }).flush(ANA, { headers: { ETag: '"4"' } });
    expect(await read).toEqual({ ...ANA, etag: '"4"' });

    const saved = firstValueFrom(api.update('u-ana', '"4"', { displayName: 'Ana S.', isAdmin: true }));
    const request = backend.expectOne({ method: 'PATCH', url: '/api/admin/users/u-ana' });
    expect(request.request.headers.get('If-Match')).toBe('"4"');
    expect(request.request.body).toEqual({ displayName: 'Ana S.', isAdmin: true });
    request.flush({ ...ANA, displayName: 'Ana S.', isAdmin: true, version: 5 }, { headers: { ETag: '"5"' } });
    expect(await saved).toEqual({ ...ANA, displayName: 'Ana S.', isAdmin: true, version: 5, etag: '"5"' });
  });

  it('creates a user, whose answer carries the temporary password', async () => {
    const created = firstValueFrom(api.create('ana.souza', 'Ana Souza', true));
    const request = backend.expectOne({ method: 'POST', url: '/api/admin/users' });
    expect(request.request.body).toEqual({ username: 'ana.souza', displayName: 'Ana Souza', isAdmin: true });
    request.flush({ user: ANA, temporaryPassword: 'Senha-Temporaria-123' }, { status: 201, statusText: 'Created' });

    expect(await created).toEqual({ user: ANA, temporaryPassword: 'Senha-Temporaria-123' });
  });

  it('deactivates, activates and unlocks, and resets the password into a new temporary one', async () => {
    for (const [action, call] of [
      ['deactivate', () => api.deactivate('u-ana')],
      ['activate', () => api.activate('u-ana')],
      ['unlock', () => api.unlock('u-ana')],
    ] as const) {
      const done = firstValueFrom(call(), { defaultValue: undefined });
      backend.expectOne({ method: 'POST', url: `/api/admin/users/u-ana/${action}` }).flush(null, { status: 204, statusText: 'No Content' });
      await done;
    }

    const reset = firstValueFrom(api.resetPassword('u-ana'));
    backend.expectOne({ method: 'POST', url: '/api/admin/users/u-ana/reset-password' }).flush({ temporaryPassword: 'Outra-Senha-456' });
    expect(await reset).toBe('Outra-Senha-456');
  });

  it('escapes the id in the path', async () => {
    const read = firstValueFrom(api.get('a/b'));
    backend.expectOne({ method: 'GET', url: '/api/admin/users/a%2Fb' }).flush(ANA);
    await read;
  });
});
