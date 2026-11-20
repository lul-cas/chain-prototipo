import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { BotsApi } from '../bots/bots-api';
import { GroupsApi } from './groups-api';

const CREDITO = { id: 'g-1', name: 'Crédito', description: 'Análise', isArchived: false, isModeler: true, memberCount: 2 };
const VIEW = { ...CREDITO, version: 5, members: [{ id: 'u-ana', username: 'ana.souza', displayName: 'Ana Souza', isActive: true }] };
const NO_CONTENT = { status: 204, statusText: 'No Content' };

describe('GroupsApi (identity.md I2; admin-ui.md §5)', () => {
  let api: GroupsApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()] });
    api = TestBed.inject(GroupsApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('lists the groups, adding the archived ones only when asked', async () => {
    const active = firstValueFrom(api.list(false));
    backend.expectOne({ method: 'GET', url: '/api/admin/groups' }).flush([CREDITO]);
    expect(await active).toEqual([CREDITO]);

    const all = firstValueFrom(api.list(true));
    backend.expectOne({ method: 'GET', url: '/api/admin/groups?includeArchived=true' }).flush([]);
    await all;
  });

  it('reads a group with its ETag, creates one, and edits the name and description with If-Match', async () => {
    const read = firstValueFrom(api.get('g-1'));
    backend.expectOne({ method: 'GET', url: '/api/admin/groups/g-1' }).flush(VIEW, { headers: { ETag: '"5"' } });
    expect(await read).toEqual({ ...VIEW, etag: '"5"' });

    const created = firstValueFrom(api.create('Crédito', 'Análise'));
    const post = backend.expectOne({ method: 'POST', url: '/api/admin/groups' });
    expect(post.request.body).toEqual({ name: 'Crédito', description: 'Análise' });
    post.flush(VIEW, { status: 201, statusText: 'Created' });
    expect((await created).id).toBe('g-1');

    const saved = firstValueFrom(api.update('g-1', '"5"', { name: 'Crédito PJ', description: '' }));
    const patch = backend.expectOne({ method: 'PATCH', url: '/api/admin/groups/g-1' });
    expect(patch.request.headers.get('If-Match')).toBe('"5"');
    expect(patch.request.body).toEqual({ name: 'Crédito PJ', description: '' }); // empty clears it (identity.md I2)
    patch.flush({ ...VIEW, name: 'Crédito PJ', description: null, version: 6 }, { headers: { ETag: '"6"' } });
    expect((await saved).etag).toBe('"6"');
  });

  it('archives and unarchives, grants and revokes Modeler, and adds and removes members', async () => {
    for (const [method, url, call] of [
      ['POST', '/api/admin/groups/g-1/archive', () => api.archive('g-1')],
      ['POST', '/api/admin/groups/g-1/unarchive', () => api.unarchive('g-1')],
      ['PUT', '/api/admin/groups/g-1/modeler', () => api.setModeler('g-1', true)],
      ['DELETE', '/api/admin/groups/g-1/modeler', () => api.setModeler('g-1', false)],
      ['PUT', '/api/admin/groups/g-1/members/u-ana', () => api.addMember('g-1', 'u-ana')],
      ['DELETE', '/api/admin/groups/g-1/members/u-ana', () => api.removeMember('g-1', 'u-ana')],
    ] as const) {
      const done = firstValueFrom(call(), { defaultValue: undefined });
      backend.expectOne({ method, url }).flush(null, NO_CONTENT);
      await done;
    }
  });
});

describe('BotsApi, the list (identity.md I3)', () => {
  it('lists the bots', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const backend = TestBed.inject(HttpTestingController);
    const bot = { id: 'b-1', name: 'erp-sync', displayName: 'Sincronizador', isActive: true };

    const listed = firstValueFrom(TestBed.inject(BotsApi).list());
    backend.expectOne({ method: 'GET', url: '/api/admin/bots' }).flush([bot]);

    expect(await listed).toEqual([bot]);
    backend.verify();
  });
});
