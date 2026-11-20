import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { SecretsApi } from './secrets-api';

const KEY = {
  name: 'erp_key',
  description: 'Token do ERP',
  allowedDestinations: ['erp'],
  version: 3,
  keyId: 'kek-2026',
  createdAt: '2026-10-01T12:00:00Z',
  rotatedAt: '2026-10-18T12:00:00Z',
  updatedAt: '2026-10-18T12:00:00Z',
};

describe('SecretsApi (automation.md §4.2)', () => {
  let api: SecretsApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()] });
    api = TestBed.inject(SecretsApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('lists and reads metadata only, with the ETag', async () => {
    const listing = firstValueFrom(api.list());
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/secrets' }).flush([KEY]);
    expect(await listing).toEqual([KEY]);

    const reading = firstValueFrom(api.get('erp_key'));
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/secrets/erp_key' }).flush(KEY, { headers: { ETag: '"7"' } });
    expect(await reading).toEqual({ ...KEY, etag: '"7"' });
  });

  it('sends the value only to create and to change it', async () => {
    const creating = firstValueFrom(api.create('erp_key', 'Token do ERP', 'segredo', ['erp']));
    const create = backend.expectOne({ method: 'POST', url: '/api/admin/automation/secrets' });
    expect(create.request.body).toEqual({ name: 'erp_key', description: 'Token do ERP', value: 'segredo', allowedDestinations: ['erp'] });
    create.flush({ ...KEY, version: 1 }, { status: 201, statusText: 'Created', headers: { ETag: '"1"' } });
    await creating;

    const changing = firstValueFrom(api.setValue('erp_key', '"7"', 'novo'));
    const change = backend.expectOne({ method: 'PUT', url: '/api/admin/automation/secrets/erp_key/value' });
    expect(change.request.headers.get('If-Match')).toBe('"7"');
    expect(change.request.body).toEqual({ value: 'novo' });
    change.flush({ ...KEY, version: 4 }, { headers: { ETag: '"8"' } });
    expect((await changing).version).toBe(4);
  });

  it('edits the description and the destinations with If-Match, forcing only when asked, and deletes', async () => {
    const editing = firstValueFrom(api.update('erp_key', '"7"', 'Outro', [], true));
    const edit = backend.expectOne({ method: 'PATCH', url: '/api/admin/automation/secrets/erp_key?force=true' });
    expect(edit.request.headers.get('If-Match')).toBe('"7"');
    expect(edit.request.body).toEqual({ description: 'Outro', allowedDestinations: [] });
    expect(JSON.stringify(edit.request.body)).not.toContain('value');
    edit.flush(KEY, { headers: { ETag: '"8"' } });
    await editing;

    const deleting = firstValueFrom(api.remove('erp_key'));
    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/secrets/erp_key' }).flush(null, { status: 204, statusText: 'No Content' });
    await deleting;
  });
});
