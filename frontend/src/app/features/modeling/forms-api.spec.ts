import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { FormDocument } from '../../forms/model';
import { ApiProblem } from '../../core/http/api-problem';
import { FormsApi, issuesOf } from './forms-api';

describe('FormsApi (forms.md, for the node panel of workflow-editor.md §10.5)', () => {
  let api: FormsApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    api = TestBed.inject(FormsApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('lists the forms by name, with their latest version', async () => {
    const listing = firstValueFrom(api.list());
    backend.expectOne({ method: 'GET', url: '/api/forms' }).flush([
      { id: 'f-2', name: 'Proposta', description: null, latestVersion: 3, draftUpdatedAt: '2026-10-17T12:00:00Z' },
      { id: 'f-1', name: 'Cadastro', description: 'x', latestVersion: null, draftUpdatedAt: '2026-10-16T12:00:00Z' },
    ]);

    expect(await listing).toEqual([
      { id: 'f-1', name: 'Cadastro', latestVersion: null },
      { id: 'f-2', name: 'Proposta', latestVersion: 3 },
    ]);
  });

  it('reads the document of a version', async () => {
    const reading = firstValueFrom(api.version('f-2', 3));
    const document = { schemaVersion: 1, components: [{ type: 'text', key: 'cpf', label: 'CPF' }] };
    backend
      .expectOne({ method: 'GET', url: '/api/forms/f-2/versions/3' })
      .flush({ versionNumber: 3, contentHash: 'sha256:x', publishedAt: '2026-10-17T12:00:00Z', document });

    expect(await reading).toEqual(document);
  });

  describe('for the form designer (form-designer.md §12.1, N3a)', () => {
    const body = { id: 'f-1', name: 'Proposta', description: null, latestVersion: null, draftUpdatedAt: '2026-10-19T12:00:00Z', version: 4, draft: { schemaVersion: 1, components: [] } };

    it('lists the summaries, by name', async () => {
      const listing = firstValueFrom(api.summaries());
      backend.expectOne({ method: 'GET', url: '/api/forms' }).flush([{ ...body, id: 'f-2', name: 'Zeta' }, body]);

      expect((await listing).map((form) => form.name)).toEqual(['Proposta', 'Zeta']);
    });

    it('creates a form and gives back its id', async () => {
      const creating = firstValueFrom(api.create('Proposta', ''));
      const request = backend.expectOne({ method: 'POST', url: '/api/forms' });
      expect(request.request.body).toEqual({ name: 'Proposta', description: null });
      request.flush(body, { status: 201, statusText: 'Created', headers: { ETag: '"4"' } });

      expect(await creating).toBe('f-1');
    });

    it('reads a form with its ETag, and renames it with If-Match', async () => {
      const reading = firstValueFrom(api.get('f-1'));
      backend.expectOne({ method: 'GET', url: '/api/forms/f-1' }).flush(body, { headers: { ETag: '"4"' } });
      expect(await reading).toEqual({ ...body, etag: '"4"' });

      const renaming = firstValueFrom(api.rename('f-1', '"4"', 'Proposta PJ', 'Pessoa jurídica'));
      const request = backend.expectOne({ method: 'PATCH', url: '/api/forms/f-1' });
      expect(request.request.headers.get('If-Match')).toBe('"4"');
      expect(request.request.body).toEqual({ name: 'Proposta PJ', description: 'Pessoa jurídica' });
      request.flush({ ...body, name: 'Proposta PJ', version: 5 }, { headers: { ETag: '"5"' } });
      expect((await renaming).etag).toBe('"5"');
    });

    it('saves the draft with If-Match, and gives the new ETag', async () => {
      const document: FormDocument = { schemaVersion: 1, components: [{ type: 'text', key: 'nome', label: 'Nome' }] };
      const saving = firstValueFrom(api.saveDraft('f-1', '"4"', document));
      const request = backend.expectOne({ method: 'PUT', url: '/api/forms/f-1/draft' });
      expect(request.request.headers.get('If-Match')).toBe('"4"');
      expect(request.request.body).toEqual({ document });
      request.flush({ ...body, version: 5, draft: document }, { headers: { ETag: '"5"' } });

      expect(await saving).toMatchObject({ etag: '"5"', draft: document });
    });

    it('validates the draft and publishes it with If-Match', async () => {
      const validating = firstValueFrom(api.validate('f-1'));
      backend
        .expectOne({ method: 'POST', url: '/api/forms/f-1/validate' })
        .flush({ valid: false, errors: [{ code: 'FM002', message: 'Repeated.', path: 'cpf' }, { code: 'FM006', message: 'Too many.' }] });
      expect(await validating).toEqual([
        { code: 'FM002', message: 'Repeated.', path: 'cpf' },
        { code: 'FM006', message: 'Too many.', path: null },
      ]);

      const publishing = firstValueFrom(api.publish('f-1', '"4"'));
      const request = backend.expectOne({ method: 'POST', url: '/api/forms/f-1/publish' });
      expect(request.request.headers.get('If-Match')).toBe('"4"');
      request.flush({ versionNumber: 1, contentHash: 'sha256:x', created: true }, { status: 201, statusText: 'Created' });
      expect(await publishing).toEqual({ versionNumber: 1, created: true });
    });

    it('reads the problems of a refused publish', async () => {
      const publishing = firstValueFrom(api.publish('f-1', '"4"')).catch((error: unknown) => error);
      backend
        .expectOne('/api/forms/f-1/publish')
        .flush(
          { type: 'about:blank', title: 'No', status: 422, code: 'form_validation_failed', errors: [{ code: 'FM003', message: 'Options.', path: null }] },
          { status: 422, statusText: 'Unprocessable' },
        );

      expect(issuesOf(await publishing as ApiProblem)).toEqual([{ code: 'FM003', message: 'Options.', path: null }]);
    });
  });

  describe('versions (form-designer.md §9.7, N3g)', () => {
    it('lists the versions newest first', async () => {
      const listing = firstValueFrom(api.versions('f-1'));
      backend.expectOne({ method: 'GET', url: '/api/forms/f-1/versions' }).flush([
        { versionNumber: 1, contentHash: 'a', publishedAt: '2026-10-01T12:00:00Z', publishedBy: 'u' },
        { versionNumber: 2, contentHash: 'b', publishedAt: '2026-10-02T12:00:00Z', publishedBy: 'u' },
      ]);

      expect((await listing).map((version) => version.versionNumber)).toEqual([2, 1]);
    });

    it('restores a version into the draft with If-Match', async () => {
      const restoring = firstValueFrom(api.restore('f-1', 2, '"4"'));
      const request = backend.expectOne({ method: 'POST', url: '/api/forms/f-1/versions/2/restore' });
      expect(request.request.headers.get('If-Match')).toBe('"4"');
      request.flush({ id: 'f-1', name: 'P', description: null, latestVersion: 2, draftUpdatedAt: 'x', version: 5, draft: { schemaVersion: 1, components: [] } }, { headers: { ETag: '"5"' } });

      expect((await restoring).etag).toBe('"5"');
    });

    it("sends a test submission as the renderer's JSON, exact decimals and all", async () => {
      const testing = firstValueFrom(api.validateSubmission('f-1', 2, '{"valor":1.10}'));
      const request = backend.expectOne({ method: 'POST', url: '/api/forms/f-1/versions/2/validate-submission' });
      expect(request.request.body).toBe('{"valor":1.10}');
      expect(request.request.headers.get('Content-Type')).toBe('application/json');
      request.flush({ valid: false, errors: [{ key: 'valor', code: 'out_of_range' }], values: {} });

      expect(await testing).toEqual({ valid: false, errors: [{ key: 'valor', code: 'out_of_range' }], values: {} });
    });
  });
});
