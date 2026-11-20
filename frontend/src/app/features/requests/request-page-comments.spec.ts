import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { RequestPage } from './request-page';

// requests-ui.md §6, "Commenting", and the files of Dados and the timeline (card #34, N8b).

const ANA = { id: 'u-ana', username: 'ana', displayName: 'Ana Souza' };
const CONTRATO = { fileId: 'f-1', name: 'contrato.pdf', size: 2048, contentType: 'application/pdf' };

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    definitionId: 'd-1',
    definitionName: 'Concessão de Crédito',
    versionNumber: 1,
    status: 'running',
    currentNodeId: 'analyse',
    requester: ANA,
    startedAt: '2026-10-16T12:00:00Z',
    endedAt: null,
    openTasks: [],
    participants: [ANA],
    timeline: [
      { type: 'instance.started', occurredAt: '2026-10-16T12:00:00Z', actor: ANA, actedAsGroup: null, taskId: null, details: {} },
      { type: 'attachment.added', occurredAt: '2026-10-16T12:00:00Z', actor: ANA, actedAsGroup: null, taskId: null, details: { ...CONTRATO, submissionId: 's-1' } },
    ],
    data: { cliente: 'ACME', documentos: [CONTRATO, { ...CONTRATO, fileId: 'f-2', name: 'rg.pdf' }] },
    incidents: [],
    parent: null,
    children: [],
    version: 3,
    ...overrides,
  };
}

describe('RequestPage: comments and files (requests-ui.md §6)', () => {
  let backend: HttpTestingController;

  async function open(body: object): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'solicitacoes/:id', component: RequestPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/solicitacoes/r-1');
    backend.expectOne('/api/instances/r-1').flush(body);
    await new Promise((resolve) => setTimeout(resolve));
  }

  afterEach(() => backend.verify());

  it('links the files of the data and of the timeline, which download them', async () => {
    await open(view());

    const links = screen.getAllByRole('link', { name: 'contrato.pdf' }).map((link) => link.getAttribute('href'));
    expect(links).toEqual(['/api/files/f-1', '/api/files/f-1']); // Dados, then the timeline
    expect(screen.getByRole('link', { name: 'rg.pdf' }).getAttribute('href')).toBe('/api/files/f-2');
    expect(screen.getByRole('link', { name: 'rg.pdf' }).closest('dd')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('contrato.pdf, rg.pdf');
    const attached = screen.getByRole('region', { name: 'Linha do tempo' }).querySelectorAll('li')[1];
    expect(attached.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/Ana Souza anexou contrato\.pdf \(2 KB\)$/);
  });

  it('offers "Comentar" while the request runs, and shows the answer, so the timeline has the comment', async () => {
    await open(view());
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox', { name: 'Comentário' }), 'Cliente pediu urgência');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    const comment = backend.expectOne({ method: 'POST', url: '/api/instances/r-1/comments' });
    const timeline = [
      ...view().timeline,
      { type: 'comment.added', occurredAt: '2026-10-16T12:05:00Z', actor: ANA, actedAsGroup: null, taskId: null, details: { text: 'Cliente pediu urgência', fileIds: [] } },
    ];
    comment.flush(view({ timeline, version: 4 }));
    await new Promise((resolve) => setTimeout(resolve));

    expect(screen.getByText('Cliente pediu urgência', { selector: 'q' })).toBeTruthy();
  });

  it('shows why a comment was refused when the request stopped running, and loads it again without the section', async () => {
    await open(view());
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox', { name: 'Comentário' }), 'Tarde demais');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    backend
      .expectOne('/api/instances/r-1/comments')
      .flush({ type: 'about:blank', title: 'Erro', status: 409, code: 'instance_not_running' }, { status: 409, statusText: 'Conflict' });
    backend.expectOne('/api/instances/r-1').flush(view({ status: 'completed', endedAt: '2026-10-16T12:06:00Z' }));
    await new Promise((resolve) => setTimeout(resolve));

    expect(screen.queryByRole('heading', { name: 'Comentar' })).toBeNull();
    expect(screen.getByText('A solicitação não está mais em andamento.')).toBeTruthy();
  });

  it.each([
    ['completed', false],
    ['cancelled', false],
    ['faulted', true],
  ])('offers "Comentar" on a %s request: %s', async (status, offered) => {
    await open(view({ status }));

    expect(screen.queryByRole('heading', { name: 'Comentar' }) !== null).toBe(offered);
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe with the comment section and the file links', async () => {
      await open(view());
      expect(screen.getByRole('heading', { name: 'Comentar' })).toBeTruthy();
      await expectNoAxeViolations();
    });
  });
});
