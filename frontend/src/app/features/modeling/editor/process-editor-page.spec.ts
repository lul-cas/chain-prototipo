import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { leaveWhenSaved } from '../can-leave';
import { place } from '../../../diagram/placement';
import { ProcessEditorPage } from './process-editor-page';

@Component({ template: '<h1>Processos</h1>' })
class ProcessList {}

const DRAFT = {
  schemaVersion: 1,
  lanes: [{ id: 'lane_an', title: 'Análise', group: { kind: 'requesters' } }],
  nodes: [
    { id: 'start', type: 'start', label: 'Início', laneId: 'lane_an' },
    { id: 'analyse', type: 'task', taskKind: 'human', label: 'Analisar proposta', laneId: 'lane_an' },
    { id: 'docs_ok', type: 'gateway', label: 'Docs ok?', laneId: 'lane_an', decisionMode: 'human', question: 'Docs ok?' },
    { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_an' },
  ],
  flows: [
    { id: 'f1', source: 'start', target: 'analyse' },
    { id: 'f2', source: 'analyse', target: 'docs_ok' },
    { id: 'f3', source: 'docs_ok', target: 'end', branch: 'true' },
  ],
};

const definition = (changes: Record<string, unknown> = {}) => ({
  id: 'w-1',
  name: 'Concessão de Crédito',
  description: 'Crédito para clientes',
  isActive: true,
  latestVersion: 2,
  draftUpdatedAt: '2026-10-17T12:00:00Z',
  version: 7,
  draft: DRAFT,
  ...changes,
});

const problem = (status: number, code: string, errors: unknown[] = []) => ({ status, title: 'x', code, errors });

/** Two findings as the server reports them (workflow-definition.md §2): one on an element, one on the whole process. */
const PROBLEMS = [
  { code: 'WF006', message: "A gateway needs exactly one 'true' and one 'false' outgoing flow.", elementId: 'docs_ok' },
  { code: 'WF002', message: 'The workflow needs at least one end node.', elementId: null },
];

describe('ProcessEditorPage (workflow-editor.md §10.1, §10.2)', () => {
  let backend: HttpTestingController;

  async function open(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'processos', component: ProcessList },
          { path: 'processos/:id', component: ProcessEditorPage, canDeactivate: [leaveWhenSaved] },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/processos/w-1');
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const load = async (body = definition(), etag = '"7"') => {
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1' }).flush(body, { headers: { ETag: etag } });
    await settle();
  };
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);

  afterEach(() => backend.verify());

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('draws the draft under its name, with the latest version in the footer, and passes axe', async () => {
      await open();
      await load();

      expect(await screen.findByRole('heading', { level: 1, name: 'Concessão de Crédito' })).toBeTruthy();
      expect(screen.getByText('Crédito para clientes')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Etapa: Analisar proposta' })).toBeTruthy();
      expect(screen.getByText('Versão publicada: 2')).toBeTruthy();
      expect(screen.getByRole('toolbar', { name: 'Ações do processo' })).toBeTruthy();
      await expectNoAxeViolations(document.body);
    });

    it('lists the problems in pt-BR, each with its code, and passes axe', async () => {
      await open();
      await load();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Validar' }));
      backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/validate' }).flush({ valid: false, errors: PROBLEMS });
      await settle();

      expect(within(screen.getByRole('region', { name: '2 problemas' })).getByText('O processo precisa de pelo menos um fim.')).toBeTruthy();
      await expectNoAxeViolations(document.body);
    });
  });

  it('validates, lists the problems in pt-BR and outlines their elements; choosing a problem centers its element', async () => {
    await open();
    await load();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Validar' }));
    backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/validate' }).flush({ valid: false, errors: PROBLEMS });
    await settle();

    const problems = screen.getByRole('region', { name: '2 problemas' });
    expect(within(problems).getAllByRole('listitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Uma condicional precisa de exatamente uma saída verdadeira e uma falsa. WF006',
      'O processo precisa de pelo menos um fim. WF002',
    ]);
    const gateway = screen.getByRole('button', { name: 'Condicional: Docs ok? (com problema)' });
    expect(gateway.classList).toContain('chain-canvas__element--problem');

    await user.click(within(problems).getByRole('button', { name: /WF006/ }));
    expect(gateway.classList).toContain('chain-canvas__element--selected');
    expect(within(problems).queryByRole('button', { name: /WF002/ })).toBeNull(); // no element to show

    await user.click(screen.getByRole('button', { name: 'Validar' }));
    backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/validate' }).flush({ valid: true, errors: [] });
    await settle();
    expect(screen.queryByRole('region', { name: /problema/ })).toBeNull();
    expect(screen.getByText('Nenhum problema encontrado.')).toBeTruthy();
  });

  it('publishes with the ETag: a new version, then nothing changed; the footer and ETag follow', async () => {
    await open();
    await load();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    const first = backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/publish' });
    expect(first.request.headers.get('If-Match')).toBe('"7"');
    first.flush({ versionNumber: 3, contentHash: 'sha256:a', created: true }, { status: 201, statusText: 'Created' });
    await settle();
    await load(definition({ latestVersion: 3, version: 8 }), '"8"');
    expect(toasts()).toContain('Versão 3 publicada.');
    expect(screen.getByText('Versão publicada: 3')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    const second = backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/publish' });
    expect(second.request.headers.get('If-Match')).toBe('"8"');
    second.flush({ versionNumber: 3, contentHash: 'sha256:a', created: false });
    await settle();
    await load(definition({ latestVersion: 3, version: 8 }), '"8"');
    expect(toasts()).toContain('Nada mudou desde a versão 3.');
  });

  it('shows the problems of a refused publish, and asks to reload when the process changed elsewhere', async () => {
    await open();
    await load();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/workflows/w-1/publish' })
      .flush(problem(422, 'publish_validation_failed', [{ code: 'WF012', message: 'The gateway needs both flows.', elementId: 'docs_ok' }]), {
        status: 422,
        statusText: 'Unprocessable Entity',
      });
    await settle();
    expect(screen.getByRole('region', { name: '1 problema' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Condicional: Docs ok? (com problema)' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/workflows/w-1/publish' })
      .flush(problem(412, 'version_mismatch'), { status: 412, statusText: 'Precondition Failed' });
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('O processo mudou desde que você o abriu. Carregue a página de novo.');
  });

  it('renames the process and edits its description with the ETag; a taken name is said next to the field', async () => {
    await open();
    await load();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Editar nome e descrição' }));
    const name = screen.getByRole('textbox', { name: 'Nome' });
    await user.clear(name);
    await user.type(name, 'Crédito Imobiliário');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    backend
      .expectOne({ method: 'PATCH', url: '/api/workflows/w-1' })
      .flush(problem(409, 'workflow_name_taken'), { status: 409, statusText: 'Conflict' });
    await settle();
    expect(screen.getByText('Já existe um processo com este nome.')).toBeTruthy();

    await user.clear(name);
    await user.type(name, 'Crédito Rural');
    const description = screen.getByRole('textbox', { name: 'Descrição' });
    await user.clear(description);
    await user.type(description, 'Para produtores');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    const call = backend.expectOne({ method: 'PATCH', url: '/api/workflows/w-1' });
    expect(call.request.headers.get('If-Match')).toBe('"7"');
    expect(call.request.body).toEqual({ name: 'Crédito Rural', description: 'Para produtores' });
    call.flush(definition({ name: 'Crédito Rural', description: 'Para produtores', version: 9 }), { headers: { ETag: '"9"' } });
    await settle();

    expect(screen.getByRole('heading', { level: 1, name: 'Crédito Rural' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Nome' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    expect(backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/publish' }).request.headers.get('If-Match')).toBe('"9"');
  });

  it('says what is wrong with a name the server cannot store (card #172)', async () => {
    await open();
    await load();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Editar nome e descrição' }));

    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    backend
      .expectOne({ method: 'PATCH', url: '/api/workflows/w-1' })
      .flush(problem(400, 'validation_failed', ['invalid_name']), { status: 400, statusText: 'Bad Request' });
    await settle();

    expect(screen.getByRole('textbox', { name: 'Nome' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('O nome tem caracteres que não podem ser guardados.')).toBeTruthy();
  });

  it('says at the description when the server cannot store it (card #155), until the user types in it (card #172)', async () => {
    await open();
    await load();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Editar nome e descrição' }));

    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    backend
      .expectOne({ method: 'PATCH', url: '/api/workflows/w-1' })
      .flush(problem(400, 'validation_failed', ['invalid_description']), { status: 400, statusText: 'Bad Request' });
    await settle();

    const description = screen.getByRole('textbox', { name: 'Descrição' });
    expect(description.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('A descrição tem caracteres que não podem ser guardados.')).toBeTruthy();

    await user.type(description, ' e produtores');
    expect(description.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('A descrição tem caracteres que não podem ser guardados.')).toBeNull();
  });

  it('names the process when the header is saved over a newer version (card #166)', async () => {
    await open();
    await load();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Editar nome e descrição' }));

    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    backend
      .expectOne({ method: 'PATCH', url: '/api/workflows/w-1' })
      .flush(problem(412, 'version_mismatch'), { status: 412, statusText: 'Precondition Failed' });
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('O processo mudou desde que você o abriu. Carregue a página de novo.');
  });

  it('shows the draft as JSON, and downloads it named after the process', async () => {
    await open();
    await load();
    const user = userEvent.setup();
    const created: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob);
      return 'blob:draft';
    };
    URL.revokeObjectURL = () => undefined;
    const clicks: string[] = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };

    await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));
    const dialog = await screen.findByRole('dialog', { name: 'JSON do rascunho' });
    expect(JSON.parse(within(dialog).getByTestId('draft-json').textContent!)).toEqual(DRAFT);
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));

    await user.click(screen.getByRole('button', { name: 'Baixar JSON' }));
    expect(clicks).toEqual(['Concessão de Crédito.json']);
    expect(JSON.parse(await created[0].text())).toEqual(DRAFT);
  });

  it('says so when the process does not exist, as the request page does, and offers the list', async () => {
    await open();
    backend
      .expectOne({ method: 'GET', url: '/api/workflows/w-1' })
      .flush(problem(404, 'not_found'), { status: 404, statusText: 'Not Found' });
    await settle();

    expect(screen.getByRole('heading', { level: 1, name: 'Processo não encontrado' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver os processos' }).getAttribute('href')).toBe('/processos');
  });

  it('offers to try again when loading fails for another reason', async () => {
    await open();
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1' }).error(new ProgressEvent('error'));
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('Não foi possível falar com o servidor.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await load();
    expect(screen.getByRole('heading', { level: 1, name: 'Concessão de Crédito' })).toBeTruthy();
  });

  describe('editing (§10.2)', () => {
    const element = (name: string) => screen.getByRole('button', { name });
    const status = () => screen.getByRole('status', { name: 'Situação da edição' }).textContent!.trim();
    const shape = (name: string) => element(name).querySelector('.chain-canvas__shape')!;
    const saveButton = () => screen.getByRole('button', { name: 'Salvar rascunho' }) as HTMLButtonElement;
    const PLACED = place(DRAFT as never);

    it('adds nodes and lanes from the palette at the middle of the view, selected and focused; + Início is off with a start', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      expect((screen.getByRole('button', { name: '+ Início' }) as HTMLButtonElement).disabled).toBe(true);
      expect(saveButton().disabled).toBe(true);
      expect(screen.queryByText('Alterações não salvas')).toBeNull();

      await user.click(screen.getByRole('button', { name: '+ Etapa' }));
      await settle();
      const added = element('Etapa: Nova etapa');
      expect(added.getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(added);
      expect(status()).toBe('Selecionado: Nova etapa (Etapa)');
      expect(screen.getByText('Alterações não salvas')).toBeTruthy();
      expect(saveButton().disabled).toBe(false);

      const x = Number(shape('Etapa: Nova etapa').getAttribute('x'));
      await user.keyboard('{ArrowRight}{Shift>}{ArrowRight}{/Shift}');
      expect(Number(shape('Etapa: Nova etapa').getAttribute('x'))).toBe(x + 60);

      await user.click(screen.getByRole('button', { name: '+ Área' }));
      await settle();
      expect(element('Área: Nova área').getAttribute('aria-pressed')).toBe('true');
      expect(status()).toBe('Selecionado: Nova área (Área) — Alt e as setas mudam o tamanho.'); // the keyboard way (§10.3)
    });

    it('connects with the Ligar buttons, says what to do and why it cannot, and Esc cancels', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      await user.click(element('Etapa: Analisar proposta'));
      expect(status()).toBe('Selecionado: Analisar proposta (Etapa)');
      await user.click(screen.getByRole('button', { name: 'Ligar a…' }));
      expect(status()).toBe('“Analisar proposta” já tem uma saída. Exclua o fluxo atual para ligar outro.');

      await user.click(element('Condicional: Docs ok?'));
      expect(screen.queryByRole('button', { name: 'Ligar a…' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Ligar se falso…' }));
      await settle();
      expect(status()).toBe('Escolha o destino do fluxo que sai de “Docs ok?”, se falso. Esc cancela.');
      expect(document.activeElement).toBe(element('Condicional: Docs ok?')); // the Ligar buttons are gone; Tab goes on from here
      await user.click(element('Etapa: Analisar proposta'));
      expect(element('Fluxo de Docs ok? para Analisar proposta, se falso').getAttribute('aria-pressed')).toBe('true');
      expect(status()).toBe('Selecionado: fluxo de Docs ok? para Analisar proposta — as setas movem a dobra.');

      await user.click(element('Condicional: Docs ok?'));
      await user.click(screen.getByRole('button', { name: 'Ligar se verdadeiro…' }));
      await settle();
      await user.keyboard('{Escape}');
      expect(status()).toBe('Selecionado: Docs ok? (Condicional)');

      await user.click(element('Fim: Fim'));
      expect(screen.queryByRole('button', { name: /^Ligar/ })).toBeNull(); // an end has no exit
    });

    it('switches the routing of the one selected flow with Alternar rota, as one change (§10.4)', async () => {
      await open();
      await load();
      const user = userEvent.setup();
      const flow = 'Fluxo de Analisar proposta para Docs ok?';
      const path = () => element(flow).querySelector('.chain-canvas__flow-line')!.getAttribute('d');

      expect(screen.queryByRole('button', { name: 'Alternar rota' })).toBeNull();
      await user.click(element(flow));
      expect(status()).toBe('Selecionado: fluxo de Analisar proposta para Docs ok? — as setas movem a dobra.');
      const before = path();
      await user.click(screen.getByRole('button', { name: 'Alternar rota' }));
      expect(path()).not.toBe(before);
      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      expect(path()).toBe(before);

      await user.click(element('Início: Início'));
      expect(screen.queryByRole('button', { name: 'Alternar rota' })).toBeNull(); // only for one flow
    });

    it('deletes the selection with Delete, Backspace or Excluir seleção, undoes and redoes, and leaves text fields alone', async () => {
      await open();
      await load();
      const user = userEvent.setup();
      const flow = 'Fluxo de Início para Analisar proposta';

      await user.click(element(flow));
      await user.keyboard('{Delete}');
      expect(screen.queryByRole('button', { name: flow })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Diagrama do processo' }));
      await user.keyboard('{Control>}z{/Control}');
      expect(element(flow)).toBeTruthy();
      await user.keyboard('{Control>}{Shift>}Z{/Shift}{/Control}');
      expect(screen.queryByRole('button', { name: flow })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      expect(element(flow)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Refazer' }));
      expect(screen.queryByRole('button', { name: flow })).toBeNull();

      await user.click(element('Condicional: Docs ok?'));
      await user.click(screen.getByRole('button', { name: 'Excluir seleção' }));
      expect(screen.queryByRole('button', { name: /^Condicional/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Fluxo/ })).toBeNull(); // its flows went with it

      await user.click(element('Fim: Fim'));
      await user.keyboard('{Backspace}');
      expect(screen.queryByRole('button', { name: 'Fim: Fim' })).toBeNull();
      await user.keyboard('{Control>}z{/Control}');

      element('Fim: Fim').focus();
      await user.keyboard('{Control>}a{/Control}');
      expect(status()).toBe('3 elementos selecionados');
      await user.keyboard('{Escape}');
      expect(status()).toBe('');

      await user.click(element('Etapa: Analisar proposta'));
      await user.click(screen.getByRole('button', { name: 'Editar nome e descrição' }));
      await user.type(screen.getByRole('textbox', { name: 'Nome' }), '{Backspace}');
      expect(element('Etapa: Analisar proposta')).toBeTruthy(); // Backspace edited the name, not the draft
      await user.type(screen.getByRole('textbox', { name: 'Nome' }), '{Control>}z{/Control}');
      expect(screen.queryByRole('button', { name: /^Condicional/ })).toBeNull(); // and Ctrl+Z undid typing, not the deletion
    });

    it('saves the draft with the ETag and a layout for every lane and node; with nothing to save, the button is off', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      await user.click(element('Etapa: Analisar proposta'));
      await user.keyboard('{ArrowDown}');
      await user.click(saveButton());
      const call = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/draft' });
      expect(call.request.headers.get('If-Match')).toBe('"7"');
      const saved = call.request.body.document;
      expect(saved.lanes.map((lane: { layout: unknown }) => lane.layout)).toEqual([PLACED.lanes.get('lane_an')]);
      expect(saved.nodes.map((node: { id: string; layout: unknown }) => [node.id, node.layout])).toEqual([
        ['start', PLACED.nodes.get('start')],
        ['analyse', { ...PLACED.nodes.get('analyse')!, y: PLACED.nodes.get('analyse')!.y + 10 }],
        ['docs_ok', PLACED.nodes.get('docs_ok')],
        ['end', PLACED.nodes.get('end')],
      ]);
      call.flush(definition({ draft: saved, draftUpdatedAt: '2026-10-17T15:30:00Z', version: 8 }), { headers: { ETag: '"8"' } });
      await settle();

      expect(toasts()).toContain('Rascunho salvo.');
      expect(screen.getByText(/Rascunho salvo em/).textContent).toContain('17/10/2026');
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
      expect(saveButton().disabled).toBe(true);

      await user.click(screen.getByRole('button', { name: 'Publicar' }));
      expect(backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/publish' }).request.headers.get('If-Match')).toBe('"8"');
    });

    it('lays out every element when saving the draft as it was loaded, after undoing back to it', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      await user.click(element('Etapa: Analisar proposta'));
      await user.keyboard('{ArrowDown}');
      await user.click(saveButton());
      const first = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/draft' });
      first.flush(definition({ draft: first.request.body.document, version: 8 }), { headers: { ETag: '"8"' } });
      await settle();

      await user.click(screen.getByRole('button', { name: 'Desfazer' })); // back to the draft without layouts
      await user.click(saveButton());
      const second = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/draft' });
      expect(second.request.headers.get('If-Match')).toBe('"8"');
      expect(second.request.body.document.nodes.map((node: { id: string; layout: unknown }) => [node.id, node.layout])).toEqual(
        ['start', 'analyse', 'docs_ok', 'end'].map((id) => [id, PLACED.nodes.get(id)]),
      );
      second.flush(definition({ version: 9 }), { headers: { ETag: '"9"' } });
      await settle();
    });

    it('saves unsaved changes before validating and before publishing', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      await user.click(element('Etapa: Analisar proposta'));
      await user.keyboard('{ArrowDown}');
      await user.click(screen.getByRole('button', { name: 'Validar' }));
      const first = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/draft' });
      expect(first.request.headers.get('If-Match')).toBe('"7"');
      first.flush(definition({ version: 8 }), { headers: { ETag: '"8"' } });
      await settle();
      backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/validate' }).flush({ valid: true, errors: [] });
      await settle();
      expect(screen.getByText('Nenhum problema encontrado.')).toBeTruthy();

      await user.click(element('Etapa: Analisar proposta'));
      await user.keyboard('{ArrowDown}');
      await user.click(screen.getByRole('button', { name: 'Publicar' }));
      const second = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/draft' });
      expect(second.request.headers.get('If-Match')).toBe('"8"');
      second.flush(definition({ version: 9 }), { headers: { ETag: '"9"' } });
      await settle();
      const publish = backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/publish' });
      expect(publish.request.headers.get('If-Match')).toBe('"9"');
      publish.flush({ versionNumber: 3, contentHash: 'sha256:b', created: true }, { status: 201, statusText: 'Created' });
      await settle();
      await load(definition({ latestVersion: 3, version: 10 }), '"10"');
      expect(toasts()).toContain('Versão 3 publicada.');
      expect(element('Etapa: Analisar proposta')).toBeTruthy(); // the edited draft stays
    });

    it('lists the problems of a draft the server cannot read, and keeps the changes', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: '+ Fim' }));
      await user.click(saveButton());
      backend
        .expectOne({ method: 'PUT', url: '/api/workflows/w-1/draft' })
        .flush(problem(400, 'invalid_document', [{ code: 'WF000', message: 'The document is malformed.', elementId: null }]), {
          status: 400,
          statusText: 'Bad Request',
        });
      await settle();

      expect(within(screen.getByRole('region', { name: '1 problema' })).getByText(/WF000/)).toBeTruthy();
      expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    });

    it('empties the draft after asking, and can undo it', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'Novo (vazio)' }));
      let dialog = await screen.findByRole('dialog', { name: 'Esvaziar o rascunho?' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
      expect(element('Início: Início')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Novo (vazio)' }));
      dialog = await screen.findByRole('dialog', { name: 'Esvaziar o rascunho?' });
      await user.click(within(dialog).getByRole('button', { name: 'Esvaziar' }));
      await settle();
      expect(screen.queryByRole('button', { name: /^(Início|Etapa|Condicional|Fim|Área|Fluxo)/ })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      expect(element('Início: Início')).toBeTruthy();
    });

    it('asks before leaving or closing the page with unsaved changes', async () => {
      await open();
      await load();
      const user = userEvent.setup();
      const router = TestBed.inject(Router);
      const closing = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };

      expect(closing()).toBe(false);
      await user.click(screen.getByRole('button', { name: '+ Etapa' }));
      expect(closing()).toBe(true);

      const staying = router.navigateByUrl('/processos');
      let dialog = await screen.findByRole('dialog', { name: 'Sair sem salvar?' });
      await user.click(within(dialog).getByRole('button', { name: 'Continuar editando' }));
      expect(await staying).toBe(false);
      expect(element('Etapa: Nova etapa')).toBeTruthy();

      const leaving = router.navigateByUrl('/processos');
      dialog = await screen.findByRole('dialog', { name: 'Sair sem salvar?' });
      await user.click(within(dialog).getByRole('button', { name: 'Sair sem salvar' }));
      expect(await leaving).toBe(true);
      expect(screen.getByRole('heading', { level: 1, name: 'Processos' })).toBeTruthy();
    });

    it('leaves without asking when everything is saved', async () => {
      await open();
      await load();

      expect(await TestBed.inject(Router).navigateByUrl('/processos')).toBe(true);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('versions (§10.11)', () => {
    const element = (name: string) => screen.getByRole('button', { name });
    const VERSION_ONE = {
      schemaVersion: 1,
      lanes: [{ id: 'lane_an', title: 'Análise', group: { kind: 'requesters' } }],
      nodes: [
        { id: 'start', type: 'start', label: 'Início', laneId: 'lane_an' },
        { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_an' },
      ],
      flows: [{ id: 'f1', source: 'start', target: 'end' }],
    };
    const VERSIONS = [
      { versionNumber: 1, contentHash: 'sha256:a', publishedAt: '2026-10-16T12:00:00Z', publishedBy: 'u-1' },
      { versionNumber: 2, contentHash: 'sha256:b', publishedAt: '2026-10-17T12:00:00Z', publishedBy: 'u-1' },
    ];
    const versionOne = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Versões' }));
      const panel = await screen.findByRole('dialog', { name: 'Versões' });
      backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/versions' }).flush(VERSIONS);
      await settle();
      expect(within(panel).getAllByRole('listitem').map((item) => item.textContent!.match(/Versão \d/)![0])).toEqual(['Versão 2', 'Versão 1']);
      await user.click(within(panel).getByRole('button', { name: 'Ver a versão 1' }));
      const dialog = await screen.findByRole('dialog', { name: 'Versão 1' });
      backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/versions/1' }).flush({ versionNumber: 1, contentHash: 'sha256:a', document: VERSION_ONE });
      await settle();
      return dialog;
    };

    it('shows a published version read-only, and restores it into the draft after asking', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      const dialog = await versionOne(user);
      expect(within(dialog).getByRole('img', { name: 'Fim: Fim' })).toBeTruthy(); // drawn read-only: no buttons
      await expectNoAxeViolations(dialog);
      expect(within(dialog).queryByRole('button', { name: 'Fim: Fim' })).toBeNull();
      await user.click(within(dialog).getByRole('button', { name: 'Restaurar no rascunho' }));
      const confirm = await screen.findByRole('dialog', { name: 'Restaurar a versão 1?' });
      expect(within(confirm).queryByText(/alterações não salvas/)).toBeNull();
      await user.click(within(confirm).getByRole('button', { name: 'Restaurar' }));
      const restore = backend.expectOne({ method: 'POST', url: '/api/workflows/w-1/versions/1/restore' });
      expect(restore.request.headers.get('If-Match')).toBe('"7"');
      restore.flush(definition({ draft: VERSION_ONE, version: 8 }), { headers: { ETag: '"8"' } });
      await settle();

      expect(toasts()).toContain('Versão 1 restaurada no rascunho.');
      expect(element('Fim: Fim')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Etapa: Analisar proposta' })).toBeNull();
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });

    it('warns that unsaved changes are lost, and says when the draft changed meanwhile', async () => {
      await open();
      await load();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: '+ Etapa' }));

      const dialog = await versionOne(user);
      await user.click(within(dialog).getByRole('button', { name: 'Restaurar no rascunho' }));
      const confirm = await screen.findByRole('dialog', { name: 'Restaurar a versão 1?' });
      expect(within(confirm).getByText(/As alterações não salvas serão perdidas\./)).toBeTruthy();
      await user.click(within(confirm).getByRole('button', { name: 'Restaurar' }));
      backend
        .expectOne({ method: 'POST', url: '/api/workflows/w-1/versions/1/restore' })
        .flush(problem(412, 'version_mismatch'), { status: 412, statusText: 'Precondition Failed' });
      await settle();

      expect(screen.getByText('O processo mudou desde que você o abriu. Carregue a página de novo.')).toBeTruthy(); // the editor's own text (#166)
      expect(screen.getByText('Alterações não salvas')).toBeTruthy(); // nothing restored
    });

    it('says when the process was never published', async () => {
      await open();
      await load(definition({ latestVersion: null }));
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'Versões' }));
      const panel = await screen.findByRole('dialog', { name: 'Versões' });
      backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/versions' }).flush([]);
      await settle();
      expect(within(panel).getByText('O processo ainda não foi publicado.')).toBeTruthy();
    });
  });

  describe('the node panel (§10.5)', () => {
    const FORMS = [
      { id: 'f-1', name: 'Proposta', description: null, latestVersion: 2, draftUpdatedAt: '2026-10-17T12:00:00Z' },
      { id: 'f-2', name: 'Cadastro', description: null, latestVersion: null, draftUpdatedAt: '2026-10-17T12:00:00Z' },
    ];
    const element = (name: string) => screen.getByRole('button', { name });
    const forms = async () => {
      backend.expectOne({ method: 'GET', url: '/api/forms' }).flush(FORMS);
      await settle();
    };
    const optionsOf = (select: HTMLElement) => within(select).getAllByRole('option').map((option) => option.textContent!.trim());
    const panelFor = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
      await user.click(element(name));
      await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
      const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
      await forms();
      return panel;
    };

    it('edits a node as one change, says what is missing, and changes nothing on Cancelar', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      let panel = await panelFor(user, 'Etapa: Analisar proposta');
      const type = within(panel).getByRole('combobox', { name: 'Tipo' }) as HTMLSelectElement;
      expect(type.value).toBe('task');
      expect(optionsOf(type)).toEqual(['Etapa', 'Etapa automática', 'Subprocesso', 'Condicional', 'Fim']); // no Início: there is one
      expect(optionsOf(within(panel).getByRole('combobox', { name: 'Formulário' }))).toEqual(['Nenhum', 'Cadastro (nunca publicado)', 'Proposta']);

      const label = within(panel).getByRole('textbox', { name: 'Rótulo' });
      await user.clear(label);
      await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
      expect(within(panel).getByText('Informe o rótulo.')).toBeTruthy();

      await user.type(label, 'Analisar crédito');
      await user.selectOptions(within(panel).getByRole('combobox', { name: 'Formulário' }), 'f-1');
      await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
      await settle();
      expect(screen.queryByRole('dialog', { name: 'Propriedades' })).toBeNull();
      expect(element('Etapa: Analisar crédito')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));
      const json = await screen.findByRole('dialog', { name: 'JSON do rascunho' });
      const draft = JSON.parse(within(json).getByTestId('draft-json').textContent!);
      expect(draft.nodes.find((node: { id: string }) => node.id === 'analyse').form).toEqual({ formId: 'f-1' });
      await user.click(within(json).getByRole('button', { name: 'Fechar' }));

      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      expect(element('Etapa: Analisar proposta')).toBeTruthy(); // one change

      await user.click(element('Fluxo de Início para Analisar proposta'));
      expect(screen.queryByRole('button', { name: 'Propriedades…' })).toBeNull(); // a node's, not a flow's

      panel = await panelFor(user, 'Etapa: Analisar proposta');
      await user.type(within(panel).getByRole('textbox', { name: 'Rótulo' }), ' de novo');
      await user.click(within(panel).getByRole('button', { name: 'Cancelar' }));
      await settle();
      expect(element('Etapa: Analisar proposta')).toBeTruthy();
    });

    it('previews the chosen form read-only, when it has a version', async () => {
      await open();
      await load();
      const user = userEvent.setup();
      const panel = await panelFor(user, 'Etapa: Analisar proposta');
      const form = within(panel).getByRole('combobox', { name: 'Formulário' });

      expect((within(panel).getByRole('button', { name: 'Visualizar' }) as HTMLButtonElement).disabled).toBe(true); // none chosen
      await user.selectOptions(form, 'f-2');
      expect((within(panel).getByRole('button', { name: 'Visualizar' }) as HTMLButtonElement).disabled).toBe(true); // never published
      await user.selectOptions(form, 'f-1');
      await user.click(within(panel).getByRole('button', { name: 'Visualizar' }));
      backend
        .expectOne({ method: 'GET', url: '/api/forms/f-1/versions/2' })
        .flush({ versionNumber: 2, contentHash: 'sha256:x', publishedAt: '2026-10-17T12:00:00Z', document: { schemaVersion: 1, components: [{ type: 'text', key: 'cpf', label: 'CPF' }] } });
      const preview = await screen.findByRole('dialog', { name: 'Proposta' });
      expect(within(preview).getByRole('textbox', { name: 'CPF' }).closest('fieldset')?.disabled).toBe(true); // read-only, as the renderer does it
    });

    it('asks before a type change removes flows, saying how many (E8)', async () => {
      await open();
      await load();
      const user = userEvent.setup();
      const panel = await panelFor(user, 'Etapa: Analisar proposta');

      await user.selectOptions(within(panel).getByRole('combobox', { name: 'Tipo' }), 'end');
      await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
      let confirm = await screen.findByRole('dialog', { name: 'Mudar o tipo?' });
      expect(confirm.textContent).toContain('1 fluxo deixa de valer para o novo tipo e será removido.');
      await user.click(within(confirm).getByRole('button', { name: 'Voltar' }));
      await settle();
      expect(screen.getByRole('dialog', { name: 'Propriedades' })).toBeTruthy();

      await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
      confirm = await screen.findByRole('dialog', { name: 'Mudar o tipo?' });
      await user.click(within(confirm).getByRole('button', { name: 'Mudar o tipo' }));
      await settle();
      expect(screen.queryByRole('dialog', { name: 'Propriedades' })).toBeNull();
      expect(element('Fim: Analisar proposta')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Fluxo de Analisar proposta para Docs ok?' })).toBeNull();
    });

    it('opens a gateway on a double click, with its question and its true and false steps', async () => {
      await open();
      await load();
      const user = userEvent.setup();

      element('Condicional: Docs ok?').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
      await forms();
      expect((within(panel).getByRole('textbox', { name: 'Pergunta' }) as HTMLInputElement).value).toBe('Docs ok?');
      const whenTrue = within(panel).getByRole('combobox', { name: 'Etapa se verdadeiro' }) as HTMLSelectElement;
      const whenFalse = within(panel).getByRole('combobox', { name: 'Etapa se falso' }) as HTMLSelectElement;
      expect([whenTrue.value, whenFalse.value]).toEqual(['end', '']);
      expect(optionsOf(whenFalse)).toEqual(['Nenhuma', 'Início', 'Analisar proposta', 'Fim']);
      expect(within(panel).queryByRole('combobox', { name: 'Formulário' })).toBeNull();

      const question = within(panel).getByRole('textbox', { name: 'Pergunta' });
      await user.clear(question);
      await user.type(question, 'Os documentos estão corretos?');
      await user.selectOptions(whenFalse, 'analyse');
      await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
      await settle();
      expect(element('Fluxo de Docs ok? para Analisar proposta, se falso')).toBeTruthy();
    });

    describe('an automatic step (§10.9)', () => {
      const CATALOG = {
        nodes: [
          { nodeId: 'start', entries: [] },
          {
            nodeId: 'analyse',
            entries: [
              { path: ['cpf'], type: 'text', presence: 'definite', sources: ['start'] },
              { path: ['valor'], type: 'number', presence: 'definite', sources: ['start'] },
            ],
          },
        ],
      };
      const AUTOMATIONS = [
        { id: 'a-2', name: 'Rascunho', description: null, latestVersion: null, draftUpdatedAt: '2026-10-17T12:00:00Z' },
        { id: 'a-1', name: 'Consultar CPF', description: null, latestVersion: 2, draftUpdatedAt: '2026-10-17T12:00:00Z' },
      ];
      const VERSION = {
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
            { key: 'situacao', type: 'text', required: true, source: 'body', path: ['s'] },
            { key: 'score', type: 'number', required: false, source: 'body', path: ['p'] },
          ],
        },
      };
      const catalog = async () => {
        backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/data-catalog' }).flush(CATALOG);
        await settle();
      };
      const automations = async () => {
        backend.expectOne({ method: 'GET', url: '/api/automations' }).flush(AUTOMATIONS);
        await settle();
      };
      const contract = async () => {
        backend.expectOne({ method: 'GET', url: '/api/automations/a-1/versions/2' }).flush(VERSION);
        await settle();
      };
      const stepPanel = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(element('Etapa: Analisar proposta'));
        await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
        const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
        await forms();
        return panel;
      };
      const automatic = async (user: ReturnType<typeof userEvent.setup>, panel: HTMLElement) => {
        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Tipo' }), 'automatic');
        await catalog();
        await automations();
        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Automação' }), 'a-1');
        await contract();
      };
      const savedNode = async (user: ReturnType<typeof userEvent.setup>, id: string) => {
        await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));
        const json = await screen.findByRole('dialog', { name: 'JSON do rascunho' });
        return JSON.parse(within(json).getByTestId('draft-json').textContent!).nodes.find((node: { id: string }) => node.id === id);
      };
      const optionsOf = (select: HTMLElement) => within(select).getAllByRole('option').map((option) => option.textContent!.trim());

      it("makes a step automatic: the automation, its inputs from the step's data, and the outputs kept as keys", async () => {
        await open();
        await load();
        const user = userEvent.setup();
        const panel = await stepPanel(user);

        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Tipo' }), 'automatic');
        await catalog();
        await automations();
        expect(within(panel).queryByRole('combobox', { name: 'Formulário' })).toBeNull();
        const automation = within(panel).getByRole('combobox', { name: 'Automação' });
        expect(optionsOf(automation)).toEqual(['Nenhuma', 'Consultar CPF', 'Rascunho (nunca publicada)']);
        await user.selectOptions(automation, 'a-1');
        await contract();
        expect(within(panel).getByText('Versão 2')).toBeTruthy();

        const cpf = within(panel).getByRole('group', { name: 'cpf' });
        expect(within(cpf).getByText('Entrada obrigatória: publicar exige um valor.')).toBeTruthy();
        expect(optionsOf(within(cpf).getByRole('combobox', { name: 'Tipo do valor' }))).toEqual(['Não enviar', 'Valor', 'Dado']);
        await user.selectOptions(within(cpf).getByRole('combobox', { name: 'Tipo do valor' }), 'path');
        expect(optionsOf(within(cpf).getByRole('combobox', { name: 'Dado' }))).toEqual(['Escolha o dado', 'cpf (texto)']);
        await user.selectOptions(within(cpf).getByRole('combobox', { name: 'Dado' }), 'cpf');
        expect(within(cpf).queryByText('Entrada obrigatória: publicar exige um valor.')).toBeNull();
        await user.type(within(within(panel).getByRole('group', { name: 'situacao' })).getByRole('textbox', { name: 'Guardar como' }), 'situacaoCpf');
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        await settle();
        expect(screen.queryByRole('dialog', { name: 'Propriedades' })).toBeNull();

        const node = await savedNode(user, 'analyse');
        expect(node).toMatchObject({
          type: 'task',
          taskKind: 'automation',
          automation: { automationId: 'a-1', inputs: { cpf: { kind: 'path', path: ['cpf'] } }, outputs: { situacaoCpf: { kind: 'path', path: ['situacao'] } } },
        });
        expect('form' in node).toBe(false);
      });

      it('waits on Aplicar for an output key that is not valid, or that another output already writes', async () => {
        await open();
        await load();
        const user = userEvent.setup();
        const panel = await stepPanel(user);
        await automatic(user, panel);

        const situacao = within(within(panel).getByRole('group', { name: 'situacao' })).getByRole('textbox', { name: 'Guardar como' });
        await user.type(situacao, '1x');
        expect(within(panel).getByText('Use uma letra e depois letras sem acento, dígitos ou _, até 64 caracteres.')).toBeTruthy();
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        expect(within(panel).getByText('Corrija as entradas e as saídas da automação.')).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'Propriedades' })).toBeTruthy();

        await user.clear(situacao);
        await user.type(situacao, 'nota');
        await user.type(within(within(panel).getByRole('group', { name: 'score' })).getByRole('textbox', { name: 'Guardar como' }), 'nota');
        expect(within(within(panel).getByRole('group', { name: 'score' })).getByText('Outra saída já é guardada com esta chave.')).toBeTruthy();
      });

      it('says when the automation was never published, and keeps only its id', async () => {
        await open();
        await load();
        const user = userEvent.setup();
        const panel = await stepPanel(user);

        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Tipo' }), 'automatic');
        await catalog();
        await automations();
        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Automação' }), 'a-2');
        expect(within(panel).getByText('Publique a automação para mapear as entradas e as saídas.')).toBeTruthy();
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        await settle();

        expect((await savedNode(user, 'analyse')).automation).toEqual({ automationId: 'a-2' });
      });

      it('opens an automatic step with its mappings, shows an input the version lacks as text, and keeps them as stored', async () => {
        const automation = {
          automationId: 'a-1',
          outputs: { situacaoCpf: { kind: 'path', path: ['situacao'] } },
          inputs: { cpf: { kind: 'path', path: ['cpf'] }, antigo: { kind: 'path', path: ['valor'] } },
        };
        const nodes = DRAFT.nodes.map((node) => (node.id === 'analyse' ? { ...node, taskKind: 'automation', automation } : node));
        await open();
        await load(definition({ draft: { ...DRAFT, nodes } }));
        const user = userEvent.setup();

        await user.click(element('Etapa automática: Analisar proposta'));
        await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
        const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
        await catalog();
        await automations();
        await contract();
        await forms();

        expect((within(panel).getByRole('combobox', { name: 'Tipo' }) as HTMLSelectElement).value).toBe('automatic');
        expect((within(panel).getByRole('combobox', { name: 'Automação' }) as HTMLSelectElement).value).toBe('a-1');
        expect((within(within(panel).getByRole('group', { name: 'cpf' })).getByRole('combobox', { name: 'Dado' }) as HTMLSelectElement).value).toBe('cpf');
        const antigo = within(panel).getByRole('group', { name: 'antigo' });
        expect(within(antigo).getByText('antigo ← data.valor')).toBeTruthy();
        expect(within(antigo).getByText('A automação não declara esta entrada.')).toBeTruthy();
        const kept = within(within(panel).getByRole('group', { name: 'situacao' })).getByRole('textbox', { name: 'Guardar como' }) as HTMLInputElement;
        expect(kept.value).toBe('situacaoCpf');

        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        await settle();
        expect(screen.queryByRole('dialog', { name: 'Propriedades' })).toBeNull();
        expect(screen.queryByText('Alterações não salvas')).toBeNull(); // untouched, so kept as stored
      });
    });

    describe('a sub-workflow step (§10.10)', () => {
      const CATALOG = {
        nodes: [
          { nodeId: 'start', entries: [] },
          {
            nodeId: 'analyse',
            entries: [
              { path: ['cpf'], type: 'text', presence: 'definite', sources: ['start'] },
              { path: ['valor'], type: 'number', presence: 'definite', sources: ['start'] },
            ],
          },
        ],
      };
      const PROCESSES = [
        { id: 'w-1', name: 'Concessão de Crédito', description: null, isActive: true, latestVersion: 2, draftUpdatedAt: '2026-10-17T12:00:00Z' },
        { id: 'w-3', name: 'Revisão livre', description: null, isActive: true, latestVersion: 1, draftUpdatedAt: '2026-10-17T12:00:00Z' },
        { id: 'w-2', name: 'Análise de risco', description: null, isActive: true, latestVersion: 3, draftUpdatedAt: '2026-10-17T12:00:00Z' },
      ];
      const RISK = {
        versionNumber: 3,
        inputs: [{ key: 'valor', type: 'number', required: true }],
        outputs: [
          { path: ['nota'], type: 'text', presence: 'optional', sources: ['risk'] },
          { path: ['score'], type: 'number', presence: 'definite', sources: ['risk'] },
        ],
      };
      const settleAll = async () => {
        await settle();
        await settle();
      };
      const subprocess = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(element('Etapa: Analisar proposta'));
        await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
        const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
        await forms();
        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Tipo' }), 'subworkflow');
        backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/data-catalog' }).flush(CATALOG);
        await settleAll();
        backend.expectOne({ method: 'GET', url: '/api/workflows' }).flush(PROCESSES);
        await settleAll();
        return panel;
      };
      const savedNode = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));
        const json = await screen.findByRole('dialog', { name: 'JSON do rascunho' });
        return JSON.parse(within(json).getByTestId('draft-json').textContent!).nodes.find((node: { id: string }) => node.id === 'analyse');
      };
      const optionsOf = (select: HTMLElement) => within(select).getAllByRole('option').map((option) => option.textContent!.trim());

      it("makes a step a sub-workflow: the process, its start form's fields from the step's data, and its data kept", async () => {
        await open();
        await load();
        const user = userEvent.setup();
        const panel = await subprocess(user);

        const process = within(panel).getByRole('combobox', { name: 'Processo' });
        expect(optionsOf(process)).toEqual(['Nenhum', 'Análise de risco', 'Revisão livre']); // not the process being edited (WF106)
        await user.selectOptions(process, 'w-2');
        backend.expectOne({ method: 'GET', url: '/api/workflows/w-2/versions/3/contract' }).flush(RISK);
        await settleAll();
        expect(within(panel).getByText('Versão 3')).toBeTruthy();

        const valor = within(panel).getByRole('group', { name: 'valor' });
        expect(within(valor).getByText('Campo obrigatório: sem ele, a subsolicitação é recusada.')).toBeTruthy();
        await user.selectOptions(within(valor).getByRole('combobox', { name: 'Tipo do valor' }), 'path');
        await user.selectOptions(within(valor).getByRole('combobox', { name: 'Dado' }), 'valor');
        expect(within(within(panel).getByRole('group', { name: 'nota' })).getByText('(texto, pode faltar)')).toBeTruthy();
        await user.type(within(within(panel).getByRole('group', { name: 'score' })).getByRole('textbox', { name: 'Guardar como' }), 'scoreRisco');
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        await settle();
        expect(screen.queryByRole('dialog', { name: 'Propriedades' })).toBeNull();

        const node = await savedNode(user);
        expect(node).toMatchObject({
          type: 'task',
          taskKind: 'subprocess',
          workflow: { workflowId: 'w-2', inputs: { valor: { kind: 'path', path: ['valor'] } }, outputs: { scoreRisco: { kind: 'path', path: ['score'] } } },
        });
        expect('form' in node).toBe(false);
      });

      it('takes any keys from a process without a start form, and waits on Aplicar for a key that is not valid', async () => {
        await open();
        await load();
        const user = userEvent.setup();
        const panel = await subprocess(user);

        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Processo' }), 'w-3');
        backend.expectOne({ method: 'GET', url: '/api/workflows/w-3/versions/1/contract' }).flush({ versionNumber: 1, inputs: null, outputs: [] });
        await settleAll();
        expect(within(panel).getByText('O processo não tem formulário inicial: ele recebe as chaves que você enviar.')).toBeTruthy();

        await user.click(within(panel).getByRole('button', { name: '+ entrada' }));
        const row = within(panel).getByRole('group', { name: 'Entrada 1' });
        await user.type(within(row).getByRole('textbox', { name: 'Chave' }), '1x');
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        expect(within(panel).getByText('Corrija as entradas e as saídas do subprocesso.')).toBeTruthy();

        await user.clear(within(row).getByRole('textbox', { name: 'Chave' }));
        await user.type(within(row).getByRole('textbox', { name: 'Chave' }), 'cliente');
        await user.selectOptions(within(row).getByRole('combobox', { name: 'Tipo do valor' }), 'path');
        await user.selectOptions(within(row).getByRole('combobox', { name: 'Dado' }), 'cpf');
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        await settle();

        expect((await savedNode(user)).workflow).toEqual({ workflowId: 'w-3', inputs: { cliente: { kind: 'path', path: ['cpf'] } } });
      });
    });

    describe('a gateway decided automatically (§10.7)', () => {
      const CATALOG = {
        nodes: [
          { nodeId: 'start', entries: [] },
          {
            nodeId: 'docs_ok',
            entries: [
              { path: ['aprovado'], type: 'boolean', presence: 'optional', sources: ['analyse'] },
              { path: ['valor'], type: 'number', presence: 'definite', sources: ['start'] },
            ],
          },
        ],
      };
      const catalog = async (body: object = CATALOG) => {
        backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/data-catalog' }).flush(body);
        await settle();
      };
      const gatewayPanel = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(element('Condicional: Docs ok?'));
        await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
        const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
        await forms();
        return panel;
      };

      it('builds a condition from the saved draft\'s data, and keeps it instead of the question', async () => {
        await open();
        await load();
        const user = userEvent.setup();
        const panel = await gatewayPanel(user);

        const mode = within(panel).getByRole('combobox', { name: 'Modo de decisão' }) as HTMLSelectElement;
        expect(mode.value).toBe('human');
        await user.selectOptions(mode, 'automatic');
        await catalog();
        expect(within(panel).queryByRole('textbox', { name: 'Pergunta' })).toBeNull();

        await user.click(within(panel).getByRole('button', { name: '+ condição' }));
        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Dado' }), 'valor');
        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Operador' }), 'greaterThan');
        await user.type(within(panel).getByRole('textbox', { name: 'Valor' }), '1000');
        expect(within(panel).getByTestId('condition-preview').textContent).toBe('data.valor > 1000');
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        await settle();
        expect(screen.queryByRole('dialog', { name: 'Propriedades' })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));
        const json = await screen.findByRole('dialog', { name: 'JSON do rascunho' });
        const gateway = JSON.parse(within(json).getByTestId('draft-json').textContent!).nodes.find((node: { id: string }) => node.id === 'docs_ok');
        expect(gateway.decisionMode).toBe('automatic');
        expect(gateway.condition).toEqual({
          kind: 'group',
          op: 'and',
          items: [{ kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'greaterThan', right: { kind: 'literal', type: 'number', value: '1000' } }],
        });
        expect('question' in gateway).toBe(false);
      });

      it('reads the data at once for a gateway already decided automatically, and shows its condition', async () => {
        const condition = { kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'isNotEmpty' };
        const nodes = DRAFT.nodes.map((node) => (node.id === 'docs_ok' ? { id: node.id, type: node.type, label: node.label, laneId: node.laneId, decisionMode: 'automatic', condition } : node));
        await open();
        await load(definition({ draft: { ...DRAFT, nodes } }));
        const user = userEvent.setup();

        await user.click(element('Condicional: Docs ok?'));
        await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
        const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
        await catalog(); // asked for on opening, not only on switching
        await forms();
        expect((within(panel).getByRole('combobox', { name: 'Modo de decisão' }) as HTMLSelectElement).value).toBe('automatic');
        expect(within(panel).getByTestId('condition-preview').textContent).toBe('data.valor não está vazio');
      });

      it('keeps the condition as it is when the data cannot be read, showing it as text', async () => {
        const condition = { kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'isNotEmpty' };
        const nodes = DRAFT.nodes.map((node) => (node.id === 'docs_ok' ? { id: node.id, type: node.type, label: node.label, laneId: node.laneId, decisionMode: 'automatic', condition } : node));
        await open();
        await load(definition({ draft: { ...DRAFT, nodes } }));
        const user = userEvent.setup();

        await user.click(element('Condicional: Docs ok?'));
        await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
        const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
        expect(within(panel).getByText('Carregando os dados…')).toBeTruthy();
        backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/data-catalog' }).flush({ code: 'internal' }, { status: 500, statusText: 'Erro' });
        await settle();
        await forms();

        expect(within(panel).getByText('Não foi possível ler os dados desta condicional.')).toBeTruthy();
        expect(within(within(panel).getByRole('group', { name: 'Condição 1' })).getByText('data.valor não está vazio')).toBeTruthy();
        expect(within(panel).queryByRole('combobox', { name: 'Dado' })).toBeNull();
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        await settle();
        expect(screen.queryByRole('dialog', { name: 'Propriedades' })).toBeNull();
        expect(screen.queryByText('Alterações não salvas')).toBeNull(); // untouched, so kept as it was: not wrapped in a group
      });

      it('waits on Aplicar while a row is incomplete, and asks for the question again when a person decides', async () => {
        await open();
        await load();
        const user = userEvent.setup();
        const panel = await gatewayPanel(user);

        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Modo de decisão' }), 'automatic');
        await catalog();
        await user.click(within(panel).getByRole('button', { name: '+ condição' }));
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        expect(within(panel).getByText('Complete ou remova as condições incompletas.')).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'Propriedades' })).toBeTruthy();

        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Modo de decisão' }), 'human');
        await user.clear(within(panel).getByRole('textbox', { name: 'Pergunta' }));
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        expect(within(panel).getByText('Informe a pergunta.')).toBeTruthy();

        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Modo de decisão' }), 'automatic');
        expect(within(panel).getAllByRole('group', { name: /^Condição \d/ })).toHaveLength(1); // the rows stay, and the data are read once
      });

      it('says the data come from the saved draft while there are unsaved changes, and asks to save a gateway it lacks', async () => {
        await open();
        await load();
        const user = userEvent.setup();

        await user.click(screen.getByRole('button', { name: '+ Condicional' }));
        await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
        const panel = await screen.findByRole('dialog', { name: 'Propriedades' });
        await forms();
        await user.selectOptions(within(panel).getByRole('combobox', { name: 'Modo de decisão' }), 'automatic');
        await catalog();

        expect(within(panel).getByText('Há alterações não salvas: os dados vêm do rascunho salvo.')).toBeTruthy();
        expect(within(panel).getByText('Salve o rascunho para escolher os dados desta condicional.')).toBeTruthy();

        expect(within(panel).getByText('Grupo vazio.')).toBeTruthy(); // only a warning: publishing reports it
        await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
        await settle();
        await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));
        const json = await screen.findByRole('dialog', { name: 'JSON do rascunho' });
        const nodes = JSON.parse(within(json).getByTestId('draft-json').textContent!).nodes as { type: string; decisionMode?: string; condition?: unknown }[];
        expect(nodes.find((node) => node.type === 'gateway' && node.decisionMode === 'automatic')?.condition).toEqual({ kind: 'group', op: 'and', items: [] });
      });
    });

    it('fills a new gateway\'s question with its label', async () => {
      await open();
      await load();
      const user = userEvent.setup();
      const panel = await panelFor(user, 'Etapa: Analisar proposta');

      await user.selectOptions(within(panel).getByRole('combobox', { name: 'Tipo' }), 'gateway');
      expect((within(panel).getByRole('textbox', { name: 'Pergunta' }) as HTMLInputElement).value).toBe('Analisar proposta');
    });

    describe.each(THEMES)('in the %s theme', (theme) => {
      beforeEach(() => applyTheme(theme));

      it('passes axe with the panel open', async () => {
        await open();
        await load();
        await panelFor(userEvent.setup(), 'Etapa: Analisar proposta');
        await expectNoAxeViolations(document.body);
      });
    });
  });

  describe('the lane panel (§10.6)', () => {
    const GROUPS = [
      { id: 'g-1', name: 'Análise de Crédito' },
      { id: 'g-2', name: 'Cadastro' },
    ];
    const element = (name: string) => screen.getByRole('button', { name });
    const optionsOf = (select: HTMLElement) => within(select).getAllByRole('option').map((option) => option.textContent!.trim());
    const lanePanel = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
      await user.click(element(name));
      await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
      const panel = await screen.findByRole('dialog', { name: 'Propriedades da Área' });
      backend.expectOne({ method: 'GET', url: '/api/workflows/groups' }).flush(GROUPS);
      await settle();
      return panel;
    };

    it('edits a lane\'s title and group as one change, and says what is missing', async () => {
      await open();
      await load();
      const user = userEvent.setup();
      const panel = await lanePanel(user, 'Área: Análise');

      const group = within(panel).getByRole('combobox', { name: 'Grupo' }) as HTMLSelectElement;
      expect(group.value).toBe('requesters');
      expect(optionsOf(group)).toEqual(['Solicitantes', 'Análise de Crédito', 'Cadastro']);
      expect(within(panel).getByText('Grupo responsável pelas etapas nesta área.')).toBeTruthy();

      const title = within(panel).getByRole('textbox', { name: 'Rótulo' });
      await user.clear(title);
      await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
      expect(within(panel).getByText('Informe o rótulo.')).toBeTruthy();
      await user.type(title, 'Crédito');
      await user.selectOptions(group, 'g-1');
      await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
      await settle();

      expect(screen.queryByRole('dialog', { name: 'Propriedades da Área' })).toBeNull();
      expect(element('Área: Crédito')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));
      const json = await screen.findByRole('dialog', { name: 'JSON do rascunho' });
      expect(JSON.parse(within(json).getByTestId('draft-json').textContent!).lanes[0].group).toEqual({ kind: 'group', groupId: 'g-1' });
      await user.click(within(json).getByRole('button', { name: 'Fechar' }));
      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      expect(element('Área: Análise')).toBeTruthy(); // one change
    });

    it('shows a group that is no longer active as unavailable', async () => {
      await open();
      await load(definition({ draft: { ...DRAFT, lanes: [{ ...DRAFT.lanes[0], group: { kind: 'group', groupId: 'g-9' } }] } }));
      const panel = await lanePanel(userEvent.setup(), 'Área: Análise');

      const group = within(panel).getByRole('combobox', { name: 'Grupo' }) as HTMLSelectElement;
      expect(group.value).toBe('g-9');
      expect(optionsOf(group)).toEqual(['Grupo indisponível', 'Solicitantes', 'Análise de Crédito', 'Cadastro']);
    });

    describe.each(THEMES)('in the %s theme', (theme) => {
      beforeEach(() => applyTheme(theme));

      it('passes axe with the lane panel open', async () => {
        await open();
        await load();
        await lanePanel(userEvent.setup(), 'Área: Análise');
        await expectNoAxeViolations(document.body);
      });
    });
  });
});
