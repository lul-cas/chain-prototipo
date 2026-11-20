import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { BotsApi } from './bots-api';

const TOKEN = { id: 't-1', label: 'produção', prefix: 'a1b2c3d4', createdAt: '2026-10-01T12:00:00Z', lastUsedAt: null, revokedAt: null };
const ERP = {
  id: 'b-erp',
  name: 'erp-sync',
  displayName: 'Sincronizador do ERP',
  isActive: true,
  mcpEnabled: false,
  mcpCallsPerMinute: null,
  ownerId: null,
  createdAt: '2026-10-01T12:00:00Z',
  version: 3,
  activeTokenCount: 1,
  tokens: [TOKEN],
  groups: [{ id: 'g-1', name: 'Integrações' }],
};
const NO_CONTENT = { status: 204, statusText: 'No Content' };

describe('BotsApi (identity.md I3; admin-ui.md §6)', () => {
  let api: BotsApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()] });
    api = TestBed.inject(BotsApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('reads a bot with its ETag, creates one, and renames it with If-Match', async () => {
    const read = firstValueFrom(api.get('b-erp'));
    backend.expectOne({ method: 'GET', url: '/api/admin/bots/b-erp' }).flush(ERP, { headers: { ETag: '"3"' } });
    expect(await read).toEqual({ ...ERP, etag: '"3"' });

    const created = firstValueFrom(api.create('erp-sync', 'Sincronizador do ERP'));
    const post = backend.expectOne({ method: 'POST', url: '/api/admin/bots' });
    expect(post.request.body).toEqual({ name: 'erp-sync', displayName: 'Sincronizador do ERP' });
    post.flush({ ...ERP, tokens: [], groups: [], activeTokenCount: 0 }, { status: 201, statusText: 'Created' });
    expect((await created).id).toBe('b-erp');

    const renamed = firstValueFrom(api.update('b-erp', '"3"', 'ERP'));
    const patch = backend.expectOne({ method: 'PATCH', url: '/api/admin/bots/b-erp' });
    expect([patch.request.headers.get('If-Match'), patch.request.body]).toEqual(['"3"', { displayName: 'ERP' }]);
    patch.flush({ ...ERP, displayName: 'ERP', version: 4 }, { headers: { ETag: '"4"' } });
    expect((await renamed).etag).toBe('"4"');
  });

  it('switches the bot and its MCP access, sets its rate, and makes and revokes tokens', async () => {
    for (const [url, call] of [
      ['/api/admin/bots/b-erp/deactivate', () => api.setActive('b-erp', false)],
      ['/api/admin/bots/b-erp/activate', () => api.setActive('b-erp', true)],
      ['/api/admin/bots/b-erp/mcp/enable', () => api.setMcp('b-erp', true)],
      ['/api/admin/bots/b-erp/mcp/disable', () => api.setMcp('b-erp', false)],
      ['/api/admin/bots/b-erp/tokens/t-1/revoke', () => api.revokeToken('b-erp', 't-1')],
    ] as const) {
      const done = firstValueFrom(call(), { defaultValue: undefined });
      backend.expectOne({ method: 'POST', url }).flush(null, NO_CONTENT);
      await done;
    }

    for (const rate of [120, null]) {
      const set = firstValueFrom(api.setRate('b-erp', rate));
      const put = backend.expectOne({ method: 'PUT', url: '/api/admin/bots/b-erp/mcp/rate' });
      expect(put.request.body).toEqual({ callsPerMinute: rate });
      put.flush({ ...ERP, mcpCallsPerMinute: rate });
      await set;
    }

    const made = firstValueFrom(api.createToken('b-erp', 'homologação'));
    const post = backend.expectOne({ method: 'POST', url: '/api/admin/bots/b-erp/tokens' });
    expect(post.request.body).toEqual({ label: 'homologação' });
    post.flush({ token: { ...TOKEN, id: 't-2', label: 'homologação' }, value: 'chn_a1b2c3d4_segredo' }, { status: 201, statusText: 'Created' });
    expect((await made).value).toBe('chn_a1b2c3d4_segredo');
  });
});
