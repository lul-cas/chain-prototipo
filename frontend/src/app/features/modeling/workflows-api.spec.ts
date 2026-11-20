import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { ApiProblem, apiProblemInterceptor } from '../../core/http/api-problem';
import { WorkflowsApi, problemsOf } from './workflows-api';

const DEFINITION = {
  id: 'w-1',
  name: 'Concessão de Crédito',
  description: null,
  isActive: true,
  latestVersion: 2,
  draftUpdatedAt: '2026-10-17T12:00:00Z',
  version: 7,
  draft: { schemaVersion: 1, lanes: [], nodes: [{ id: 'start', type: 'start', label: 'Início' }], flows: [] },
};

describe('WorkflowsApi (workflow-definition.md §5.5)', () => {
  let api: WorkflowsApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    api = TestBed.inject(WorkflowsApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('reads a process with its draft and the ETag that guards the next change', async () => {
    const reading = firstValueFrom(api.get('w-1'));
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1' }).flush(DEFINITION, { headers: { ETag: '"7"' } });

    const process = await reading;
    expect(process.etag).toBe('"7"');
    expect(process.name).toBe('Concessão de Crédito');
    expect(process.draft.nodes.map((node) => node.id)).toEqual(['start']);
    expect(process.draft.flows).toEqual([]);
  });

  it('renames with If-Match and returns the new ETag', async () => {
    const renaming = firstValueFrom(api.rename('w-1', '"7"', 'Crédito', 'Concessão a clientes'));
    const call = backend.expectOne({ method: 'PATCH', url: '/api/workflows/w-1' });
    expect(call.request.headers.get('If-Match')).toBe('"7"');
    expect(call.request.body).toEqual({ name: 'Crédito', description: 'Concessão a clientes' });
    call.flush({ ...DEFINITION, name: 'Crédito', version: 8 }, { headers: { ETag: '"8"' } });

    expect((await renaming).etag).toBe('"8"');
  });

  it('saves the draft with If-Match, and returns the process with the new ETag', async () => {
    const document = { schemaVersion: 1, lanes: [], nodes: [], flows: [] };
    const saving = firstValueFrom(api.saveDraft('w-1', '"7"', document));
    const call = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/draft' });
    expect(call.request.headers.get('If-Match')).toBe('"7"');
    expect(call.request.body).toEqual({ document });
    call.flush({ ...DEFINITION, draft: document, draftUpdatedAt: '2026-10-17T13:00:00Z', version: 8 }, { headers: { ETag: '"8"' } });

    const saved = await saving;
    expect(saved.etag).toBe('"8"');
    expect(saved.draftUpdatedAt).toBe('2026-10-17T13:00:00Z');
  });

  it('publishes with If-Match, and tells a new version from an unchanged one', async () => {
    const publishing = firstValueFrom(api.publish('w-1', '"7"'));
    const call = backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/publish' });
    expect(call.request.headers.get('If-Match')).toBe('"7"');
    call.flush({ versionNumber: 3, contentHash: 'sha256:x', created: true }, { status: 201, statusText: 'Created' });

    expect(await publishing).toEqual({ versionNumber: 3, created: true });
  });

  it('lists, creates and validates', async () => {
    const listing = firstValueFrom(api.list());
    backend.expectOne({ method: 'GET', url: '/api/workflows' }).flush([DEFINITION]);
    expect((await listing).map((process) => process.id)).toEqual(['w-1']);

    const creating = firstValueFrom(api.create('Novo', ''));
    const created = backend.expectOne({ method: 'POST', url: '/api/workflows' });
    expect(created.request.body).toEqual({ name: 'Novo', description: null });
    created.flush({ ...DEFINITION, id: 'w-2' }, { status: 201, statusText: 'Created' });
    expect(await creating).toBe('w-2');

    const validating = firstValueFrom(api.validate('w-1'));
    backend
      .expectOne({ method: 'POST', url: '/api/workflows/w-1/validate' })
      .flush({ valid: false, errors: [{ code: 'WF001', message: 'Exactly one start node.', elementId: null }] });
    expect(await validating).toEqual([{ code: 'WF001', message: 'Exactly one start node.', elementId: null }]);
  });

  it('lists the groups a lane can be given', async () => {
    const listing = firstValueFrom(api.groups());
    backend.expectOne({ method: 'GET', url: '/api/workflows/groups' }).flush([{ id: 'g-1', name: 'Análise' }]);

    expect(await listing).toEqual([{ id: 'g-1', name: 'Análise' }]);
  });

  it('lists the published versions newest first, reads one, and restores one into the draft with its ETag (§10.11)', async () => {
    const listing = firstValueFrom(api.versions('w-1'));
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/versions' }).flush([
      { versionNumber: 1, contentHash: 'sha256:a', publishedAt: '2026-10-16T12:00:00Z', publishedBy: 'u-1' },
      { versionNumber: 2, contentHash: 'sha256:b', publishedAt: '2026-10-17T12:00:00Z', publishedBy: 'u-1' },
    ]);
    expect(await listing).toEqual([
      { versionNumber: 2, publishedAt: '2026-10-17T12:00:00Z' },
      { versionNumber: 1, publishedAt: '2026-10-16T12:00:00Z' },
    ]);

    const reading = firstValueFrom(api.version('w-1', 1));
    const document = { schemaVersion: 1, lanes: [], nodes: [{ id: 'start', type: 'start', label: 'Início' }], flows: [] };
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/versions/1' }).flush({ versionNumber: 1, contentHash: 'sha256:a', document });
    expect((await reading).nodes.map((node) => node.id)).toEqual(['start']);

    const restoring = firstValueFrom(api.restore('w-1', 1, '"7"'));
    const request = backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/versions/1/restore' });
    expect(request.request.headers.get('If-Match')).toBe('"7"');
    request.flush(
      { id: 'w-1', name: 'P', description: null, isActive: true, latestVersion: 2, draftUpdatedAt: '2026-10-18T12:00:00Z', version: 8, draft: document },
      { headers: { ETag: '"8"' } },
    );
    const restored = await restoring;
    expect(restored.etag).toBe('"8"');
    expect(restored.draft.nodes.map((node) => node.id)).toEqual(['start']);
  });

  it("reads a version's contract as a sub-workflow: its start form's fields, or none, and its top-level data at completion", async () => {
    const reading = firstValueFrom(api.contract('w-2', 3));
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-2/versions/3/contract' }).flush({
      versionNumber: 3,
      inputs: [
        { key: 'valor', type: 'number', required: true },
        { key: 'obs', type: 'text', required: false },
      ],
      outputs: [
        { path: ['endereco'], type: 'object', presence: 'optional', sources: ['start'] },
        { path: ['endereco', 'cep'], type: 'text', presence: 'optional', sources: ['start'] },
        { path: ['valor'], type: 'number', presence: 'definite', sources: ['start'] },
      ],
    });
    expect(await reading).toEqual({
      version: 3,
      inputs: [
        { key: 'valor', type: 'number', required: true },
        { key: 'obs', type: 'text', required: false },
      ],
      outputs: [
        { key: 'endereco', type: 'object', required: false },
        { key: 'valor', type: 'number', required: true },
      ],
    });

    const free = firstValueFrom(api.contract('w-3', 1));
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-3/versions/1/contract' }).flush({ versionNumber: 1, inputs: null, outputs: [] });
    expect(await free).toEqual({ version: 1, inputs: null, outputs: [] });
  });

  it('reads the data catalog at a node of the saved draft, or null when the saved draft has no such node', async () => {
    const entries = [{ path: ['valor'], type: 'number', presence: 'definite', sources: ['start'] }];
    const reading = firstValueFrom(api.catalog('w-1', 'gw'));
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/data-catalog' }).flush({ nodes: [{ nodeId: 'start', entries: [] }, { nodeId: 'gw', entries }] });
    expect(await reading).toEqual(entries);

    const missing = firstValueFrom(api.catalog('w-1', 'gateway_9'));
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/data-catalog' }).flush({ nodes: [] });
    expect(await missing).toBeNull();
  });

  it("reads the process's grants, and replaces them with If-Match, taking the process's new ETag (admin-ui.md §7, S-A2)", async () => {
    const grants = [{ groupId: 'g-1', groupName: 'Crédito', capabilities: ['start', 'viewSensitive'] }];
    const read = firstValueFrom(api.grants('w-1'));
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/grants' }).flush(grants);
    expect(await read).toEqual(grants);

    const replaced = firstValueFrom(api.replaceGrants('w-1', '"7"', [{ groupId: 'g-1', capabilities: ['start'] }]));
    const call = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/grants' });
    expect(call.request.headers.get('If-Match')).toBe('"7"');
    expect(call.request.body).toEqual([{ groupId: 'g-1', capabilities: ['start'] }]);
    call.flush([{ groupId: 'g-1', groupName: 'Crédito', capabilities: ['start'] }], { headers: { ETag: '"8"' } });

    expect(await replaced).toEqual({ grants: [{ groupId: 'g-1', groupName: 'Crédito', capabilities: ['start'] }], etag: '"8"' });
    backend.verify();
  });

  it('reads the problems of a publish the server refused', () => {
    const refused: ApiProblem = {
      kind: 'api-problem',
      status: 422,
      code: 'publish_validation_failed',
      title: 'The draft cannot be published.',
      errors: [{ code: 'WF012', message: 'The gateway needs both flows.', elementId: 'docs_ok' }, 'not-a-finding'],
    };

    expect(problemsOf(refused)).toEqual([{ code: 'WF012', message: 'The gateway needs both flows.', elementId: 'docs_ok' }]);
  });
});
