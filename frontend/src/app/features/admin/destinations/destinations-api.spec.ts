import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { ApiProblem, apiProblemInterceptor } from '../../../core/http/api-problem';
import { DestinationsApi, usageOf } from './destinations-api';

const ERP = {
  name: 'erp',
  description: 'O ERP da empresa',
  scheme: 'https',
  host: 'api.erp.example',
  port: 8443,
  pathPrefix: '/v1',
  internal: false,
  allowSecretsOverHttp: false,
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 2_097_152,
  createdAt: '2026-10-18T12:00:00Z',
  updatedAt: '2026-10-19T12:00:00Z',
  version: 3,
};
const SETTINGS = {
  description: 'O ERP da empresa',
  scheme: 'https',
  host: 'api.erp.example',
  port: 8443,
  pathPrefix: '/v1',
  internal: false,
  allowSecretsOverHttp: false,
  maxRequestBytes: null,
  maxResponseBytes: 2_097_152,
};

describe('DestinationsApi (automation.md §3.2)', () => {
  let api: DestinationsApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()] });
    api = TestBed.inject(DestinationsApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('lists the destinations, and reads one with its ETag', async () => {
    const listing = firstValueFrom(api.list());
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/destinations' }).flush([ERP]);
    expect(await listing).toEqual([ERP]);

    const reading = firstValueFrom(api.get('erp'));
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/destinations/erp' }).flush(ERP, { headers: { ETag: '"3"' } });
    expect(await reading).toEqual({ ...ERP, etag: '"3"' });
  });

  it('creates with the name and every setting', async () => {
    const creating = firstValueFrom(api.create('erp', SETTINGS));
    const request = backend.expectOne({ method: 'POST', url: '/api/admin/automation/destinations' });
    expect(request.request.body).toEqual({ name: 'erp', ...SETTINGS });
    request.flush(ERP, { status: 201, statusText: 'Created', headers: { ETag: '"1"' } });

    expect((await creating).etag).toBe('"1"');
  });

  it('updates every setting with If-Match, forcing only when asked', async () => {
    const updating = firstValueFrom(api.update('erp', '"3"', SETTINGS));
    const request = backend.expectOne({ method: 'PUT', url: '/api/admin/automation/destinations/erp' });
    expect(request.request.headers.get('If-Match')).toBe('"3"');
    expect(request.request.body).toEqual(SETTINGS);
    request.flush({ ...ERP, version: 4 }, { headers: { ETag: '"4"' } });
    expect((await updating).etag).toBe('"4"');

    const forcing = firstValueFrom(api.update('erp', '"4"', SETTINGS, true));
    backend.expectOne({ method: 'PUT', url: '/api/admin/automation/destinations/erp?force=true' }).flush({ ...ERP, version: 5 }, { headers: { ETag: '"5"' } });
    await forcing;
  });

  it('deletes, forcing only when asked, and reads what uses a destination from a 409', async () => {
    const deleting = firstValueFrom(api.remove('erp')).catch((error: unknown) => error);
    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/destinations/erp' }).flush(
      {
        type: 'about:blank',
        title: 'In use',
        status: 409,
        code: 'destination_in_use',
        secrets: ['erp_key'],
        automations: ['consulta_cpf'],
        versions: [{ automation: 'consulta_cpf', version: 2, errors: [{ code: 'AU106', message: 'Host.', path: 'call.url' }] }],
      },
      { status: 409, statusText: 'Conflict' },
    );

    expect(usageOf((await deleting) as ApiProblem)).toEqual({
      secrets: ['erp_key'],
      automations: ['consulta_cpf'],
      versions: [{ automation: 'consulta_cpf', version: 2, errors: [{ code: 'AU106', message: 'Host.', path: 'call.url' }] }],
    });

    const forcing = firstValueFrom(api.remove('erp', true));
    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/destinations/erp?force=true' }).flush(null, { status: 204, statusText: 'No Content' });
    await forcing;
  });
});
