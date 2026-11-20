import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { AutomationsApi } from './automations-api';

describe('AutomationsApi (automation.md §5.1, for the automatic step of workflow-editor.md §10.9)', () => {
  let api: AutomationsApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    api = TestBed.inject(AutomationsApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('lists the automations by name, with their latest version', async () => {
    const listing = firstValueFrom(api.list());
    backend.expectOne({ method: 'GET', url: '/api/automations' }).flush([
      { id: 'a-2', name: 'Consultar CPF', description: null, latestVersion: 2, draftUpdatedAt: '2026-10-17T12:00:00Z' },
      { id: 'a-1', name: 'Calcular frete', description: 'x', latestVersion: null, draftUpdatedAt: '2026-10-16T12:00:00Z' },
    ]);

    expect(await listing).toEqual([
      { id: 'a-1', name: 'Calcular frete', latestVersion: null },
      { id: 'a-2', name: 'Consultar CPF', latestVersion: 2 },
    ]);
  });

  it("reads a version's inputs and outputs, in order", async () => {
    const reading = firstValueFrom(api.contract('a-2', 2));
    backend.expectOne({ method: 'GET', url: '/api/automations/a-2/versions/2' }).flush({
      versionNumber: 2,
      contentHash: 'sha256:x',
      publishedAt: '2026-10-17T12:00:00Z',
      document: {
        schemaVersion: 1,
        kind: 'http',
        inputs: [
          { key: 'cpf', type: 'text', required: true },
          { key: 'valor', type: 'number', required: false },
        ],
        outputs: [
          { key: 'situacao', type: 'text', required: true, source: 'body', path: ['resultado', 'situacao'] },
          { key: 'httpStatus', type: 'number', required: true, source: 'status' },
        ],
      },
    });

    expect(await reading).toEqual({
      version: 2,
      inputs: [
        { key: 'cpf', type: 'text', required: true },
        { key: 'valor', type: 'number', required: false },
      ],
      outputs: [
        { key: 'situacao', type: 'text', required: true },
        { key: 'httpStatus', type: 'number', required: true },
      ],
    });
  });

  describe('for the automation editor (automation-ui.md §5.4, AS3)', () => {
    const body = { id: 'a-1', name: 'Consulta CPF', description: null, latestVersion: null, draftUpdatedAt: '2026-10-19T12:00:00Z', version: 2, draft: { schemaVersion: 1 } };

    it('lists the summaries by name, creates, reads and renames with the ETag', async () => {
      const listing = firstValueFrom(api.summaries());
      backend.expectOne({ method: 'GET', url: '/api/automations' }).flush([{ ...body, name: 'Zeta' }, body]);
      expect((await listing).map((automation) => automation.name)).toEqual(['Consulta CPF', 'Zeta']);

      const creating = firstValueFrom(api.create('Consulta CPF', ''));
      const create = backend.expectOne({ method: 'POST', url: '/api/automations' });
      expect(create.request.body).toEqual({ name: 'Consulta CPF', description: null });
      create.flush(body, { status: 201, statusText: 'Created' });
      expect(await creating).toBe('a-1');

      const reading = firstValueFrom(api.get('a-1'));
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1' }).flush(body, { headers: { ETag: '"2"' } });
      expect((await reading).etag).toBe('"2"');

      const renaming = firstValueFrom(api.rename('a-1', '"2"', 'Consulta', 'Do CPF'));
      const rename = backend.expectOne({ method: 'PATCH', url: '/api/automations/a-1' });
      expect(rename.request.headers.get('If-Match')).toBe('"2"');
      rename.flush({ ...body, name: 'Consulta', version: 3 }, { headers: { ETag: '"3"' } });
      expect((await renaming).etag).toBe('"3"');
    });

    it('validates and publishes with If-Match, and reads the resources', async () => {
      const validating = firstValueFrom(api.validate('a-1'));
      backend.expectOne({ method: 'POST', url: '/api/automations/a-1/validate' }).flush({ valid: false, errors: [{ code: 'AU101', message: 'No.', path: 'request.destination' }] });
      expect(await validating).toEqual([{ code: 'AU101', message: 'No.', path: 'request.destination' }]);

      const publishing = firstValueFrom(api.publish('a-1', '"2"'));
      const publish = backend.expectOne({ method: 'POST', url: '/api/automations/a-1/publish' });
      expect(publish.request.headers.get('If-Match')).toBe('"2"');
      publish.flush({ versionNumber: 1, contentHash: 'x', created: true }, { status: 201, statusText: 'Created' });
      expect(await publishing).toEqual({ versionNumber: 1, created: true });

      const reading = firstValueFrom(api.resources());
      backend.expectOne({ method: 'GET', url: '/api/automations/resources' }).flush({ destinations: [{ name: 'erp', description: null, scheme: 'https', host: 'api.erp.example', port: null, pathPrefix: '/v1' }], secrets: [] });
      expect((await reading).destinations[0].name).toBe('erp');
    });

    it('saves the draft with If-Match and reads the new ETag (AS4a)', async () => {
      const saving = firstValueFrom(api.saveDraft('a-1', '"2"', { schemaVersion: 1 }));
      const save = backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' });
      expect(save.request.headers.get('If-Match')).toBe('"2"');
      expect(save.request.body).toEqual({ document: { schemaVersion: 1 } });
      save.flush({ id: 'a-1', name: 'A', description: null, latestVersion: null, draftUpdatedAt: '2026-10-19T12:00:00Z', version: 3, draft: {} }, { headers: { ETag: '"3"' } });
      expect((await saving).etag).toBe('"3"');
    });

    it('lists the versions newest first, reads one, and restores one with If-Match (AS6)', async () => {
      const listing = firstValueFrom(api.versions('a-1'));
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1/versions' }).flush([
        { versionNumber: 1, contentHash: 'h1', publishedAt: '2026-10-18T12:00:00Z', publishedBy: 'u-1' },
        { versionNumber: 2, contentHash: 'h2', publishedAt: '2026-10-19T12:00:00Z', publishedBy: 'u-1' },
      ]);
      expect((await listing).map((version) => version.versionNumber)).toEqual([2, 1]);

      const reading = firstValueFrom(api.version('a-1', 2));
      backend
        .expectOne({ method: 'GET', url: '/api/automations/a-1/versions/2' })
        .flush({ versionNumber: 2, contentHash: 'h2', publishedAt: '2026-10-19T12:00:00Z', document: { schemaVersion: 1 } });
      expect(await reading).toEqual({ versionNumber: 2, publishedAt: '2026-10-19T12:00:00Z', document: { schemaVersion: 1 } });

      const restoring = firstValueFrom(api.restore('a-1', 1, '"4"'));
      const restore = backend.expectOne({ method: 'POST', url: '/api/automations/a-1/versions/1/restore' });
      expect(restore.request.headers.get('If-Match')).toBe('"4"');
      restore.flush({ id: 'a-1', name: 'A', description: null, latestVersion: 2, draftUpdatedAt: '2026-10-19T12:00:00Z', version: 5, draft: { schemaVersion: 1 } }, { headers: { ETag: '"5"' } });
      expect((await restoring).etag).toBe('"5"');
    });
  });
});
