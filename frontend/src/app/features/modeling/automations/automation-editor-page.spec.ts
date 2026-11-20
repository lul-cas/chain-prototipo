import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
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
import { AutomationEditorPage } from './automation-editor-page';

const DRAFT = {
  schemaVersion: 1,
  kind: 'http',
  inputs: [
    { key: 'cpf', type: 'text', required: true },
    { key: 'valor', type: 'number', required: false },
    { key: 'extra', type: 'list<list<text>>', required: false },
  ],
  request: {
    method: 'POST',
    destination: 'erp',
    path: '/v1/clientes/{cpf}/consultas',
    query: { origem: 'chain', valor: '{valor}' },
    headers: { 'X-Api.Key': '{{secret:erp_api_key}}', Accept: 'application/json' },
    auth: null,
    body: { type: 'json', keys: ['cpf', 'valor'] },
  },
  response: { type: 'json' },
  outputs: [
    { key: 'situacao', type: 'text', required: true, source: 'body', path: ['resultado', 'situacao'] },
    { key: 'nome', type: 'text', required: false, source: 'body', path: ['itens', 0, 'nome.completo'] },
    { key: 'httpStatus', type: 'number', required: true, source: 'status' },
  ],
  execution: { timeoutSeconds: 30, retry: { maxAttempts: 5, initialDelaySeconds: 5 }, idempotency: { mode: 'header', header: 'Idempotency-Key' }, redirects: { follow: false, max: 0 } },
};
const AUTOMATION = { id: 'a-1', name: 'Consulta CPF', description: 'No ERP', latestVersion: null, draftUpdatedAt: '2026-10-19T12:00:00Z', version: 4, draft: DRAFT };
const RESOURCES = { destinations: [{ name: 'erp', description: null, scheme: 'https', host: 'api.erp.example', port: null, pathPrefix: '/v1' }], secrets: [] };

describe('AutomationEditorPage (automation-ui.md §7, §12.3 AS3)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);

  async function open(automation: object = AUTOMATION, status = 200, resources: object = RESOURCES) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'automacoes/:id', component: AutomationEditorPage, canDeactivate: [leaveWhenSaved] },
          { path: 'automacoes', children: [] },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/automacoes/a-1');
    const request = backend.expectOne({ method: 'GET', url: '/api/automations/a-1' });
    if (status === 200) {
      request.flush(automation, { headers: { ETag: '"4"' } });
    } else {
      request.flush({ type: 'about:blank', title: 'Not found', status, code: 'not_found' }, { status, statusText: 'Not Found' });
    }
    backend.expectOne({ method: 'GET', url: '/api/automations/resources' }).flush(resources);
    await settle();
    return userEvent.setup();
  }

  afterEach(() => backend.verify());

  /** An input's row (§7.2): its group, and its key, type and Obrigatória controls. */
  const group = (n: number) => within(within(screen.getByRole('region', { name: 'Entradas' })).getByRole('group', { name: `Entrada ${n}` }));
  const keyOf = (n: number) => group(n).getByRole('textbox', { name: 'Chave' }) as HTMLInputElement;
  const typeOf = (n: number) => group(n).getByRole('combobox', { name: 'Tipo' }) as HTMLSelectElement;
  const requiredOf = (n: number) => group(n).getByRole('checkbox', { name: 'Obrigatória' }) as HTMLInputElement;
  const inputRow = (n: number) => [keyOf(n).value, typeOf(n).selectedOptions[0].textContent?.trim(), requiredOf(n).checked, group(n).getByText(/^Uso:/).textContent?.trim()];

  it('draws every value in its section, and flags what no control offers (§7.2–§7.7)', async () => {
    await open();

    expect([1, 2, 3].map(inputRow)).toEqual([
      ['cpf', 'Texto', true, 'Uso: no caminho, no corpo'],
      ['valor', 'Número', false, 'Uso: na consulta, no corpo'],
      ['extra', 'list<list<text>> (não editável)', false, 'Uso: não usada na chamada'],
    ]);
    const call = within(screen.getByRole('region', { name: 'Chamada' }));
    expect((call.getByRole('combobox', { name: 'Destino' }) as HTMLSelectElement).selectedOptions[0].textContent?.trim()).toBe('erp: https://api.erp.example');
    expect(call.getByText('Depois de https://api.erp.example')).toBeTruthy();
    const header = within(call.getByRole('group', { name: 'Cabeçalho 1' }));
    expect((header.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement).value).toBe('X-Api.Key');
    expect((header.getByRole('textbox', { name: 'Valor' }) as HTMLInputElement).value).toBe('{{secret:erp_api_key}}');
    expect(call.getByText('Idempotency-Key: (chave desta execução)')).toBeTruthy();
    const outputs = within(screen.getByRole('region', { name: 'Resposta e saídas' }));
    const output = (n: number) => within(outputs.getByRole('group', { name: `Saída ${n}` }));
    const value = (n: number, name: string) => (output(n).queryByRole(name === 'Origem' ? 'combobox' : 'textbox', { name }) as HTMLInputElement | null)?.value ?? null;
    expect([1, 2, 3].map((n) => [value(n, 'Chave'), value(n, 'Origem'), value(n, 'Caminho')])).toEqual([
      ['situacao', 'body', 'resultado.situacao'],
      ['nome', 'body', 'itens[0]["nome.completo"]'],
      ['httpStatus', 'status', null], // a status output has no path
    ]);
    expect(output(3).getByText('Tipo: número')).toBeTruthy();
    expect(screen.getByText('Sem resultado em 16 min 30 s, a etapa falha (sem resultado no prazo).')).toBeTruthy();
    expect(screen.getByLabelText('Prévia da chamada', { selector: 'pre' }).textContent).toBe(
      [
        'POST https://api.erp.example/v1/clientes/{cpf}/consultas?origem=chain&valor={valor}',
        'Accept: application/json',
        'Content-Type: application/json',
        'X-Api.Key: {{secret:erp_api_key}}',
        'Idempotency-Key: (chave desta execução)',
        '',
        '{"cpf": {cpf}, "valor": {valor}}',
      ].join('\n'),
    );
    expect(screen.getByText('Nunca publicada')).toBeTruthy();
  });

  it('says when the automation does not exist', async () => {
    await open(AUTOMATION, 404);

    expect(screen.getByRole('heading', { name: 'Automação não encontrada' })).toBeTruthy();
  });

  it('lists the problems in pt-BR, outlines and focuses their controls, a header with a dot included (§8.2, §8.3)', async () => {
    const user = await open();

    await user.click(screen.getByRole('button', { name: 'Validar' }));
    backend.expectOne({ method: 'POST', url: '/api/automations/a-1/validate' }).flush({
      valid: false,
      errors: [
        { code: 'AU004', message: 'Bad path.', path: 'request.path' },
        { code: 'AU005', message: 'Bad query.', path: 'request.query.origem' },
        { code: 'AU103', message: 'Not allowed.', path: 'request.headers.X-Api.Key' },
        { code: 'AU000', message: 'Unreadable.', path: null },
      ],
    });
    await settle();

    const header = document.querySelector<HTMLElement>('[data-control="request.headers.X-Api.Key"]')!;
    expect(header.classList).toContain('chain-section__outlined');
    await user.click(screen.getByRole('button', { name: /Uma credencial usada na chamada não permite o destino escolhido. AU103/ }));
    expect(document.activeElement).toBe(header);
    await user.click(screen.getByRole('button', { name: /O caminho começa com \/.* AU004/ }));
    expect(document.activeElement?.getAttribute('data-control')).toBe('request.path');
    expect(screen.getByText(/O rascunho não pôde ser lido como automação/).closest('button')).toBeNull();
  });

  it('publishes: a new version, nothing new, or the problems', async () => {
    const user = await open();

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    const publish = backend.expectOne({ method: 'POST', url: '/api/automations/a-1/publish' });
    expect(publish.request.headers.get('If-Match')).toBe('"4"');
    publish.flush({ versionNumber: 1, contentHash: 'x', created: true }, { status: 201, statusText: 'Created' });
    await settle();
    backend.expectOne({ method: 'GET', url: '/api/automations/a-1' }).flush({ ...AUTOMATION, latestVersion: 1, version: 5 }, { headers: { ETag: '"5"' } });
    await settle();
    backend.expectOne({ method: 'GET', url: '/api/automations/a-1/versions/1' }).flush({ versionNumber: 1, document: DRAFT }); // its inputs, once (§7.2)
    await settle();
    expect(toasts()).toContain('Versão 1 publicada.');
    expect(screen.getByText('Versão publicada: 1')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    backend.expectOne({ method: 'POST', url: '/api/automations/a-1/publish' }).flush({ versionNumber: 1, contentHash: 'x', created: false });
    await settle();
    backend.expectOne({ method: 'GET', url: '/api/automations/a-1' }).flush({ ...AUTOMATION, latestVersion: 1, version: 5 }, { headers: { ETag: '"5"' } });
    await settle();
    expect(toasts()).toContain('Nada mudou desde a versão 1.');

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/automations/a-1/publish' })
      .flush(
        { type: 'about:blank', title: 'No', status: 422, code: 'automation_validation_failed', errors: [{ code: 'AU101', message: 'No destination.', path: 'request.destination' }] },
        { status: 422, statusText: 'Unprocessable' },
      );
    await settle();
    expect(screen.getByRole('button', { name: /Escolha um destino que exista. AU101/ })).toBeTruthy();
  });

  it('renames with If-Match, and offers to reload after a 412', async () => {
    const user = await open();

    await user.click(screen.getByRole('button', { name: 'Editar nome e descrição' }));
    const name = screen.getByDisplayValue('Consulta CPF'); // the header's Nome; the query rows have theirs
    await user.clear(name);
    await user.type(name, 'Consulta de CPF');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    const rename = backend.expectOne({ method: 'PATCH', url: '/api/automations/a-1' });
    expect(rename.request.headers.get('If-Match')).toBe('"4"');
    rename.flush({ type: 'about:blank', title: 'Changed', status: 412, code: 'version_mismatch' }, { status: 412, statusText: 'Precondition Failed' });
    await settle();

    expect(screen.getByText('A automação mudou desde que você a abriu.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    backend.expectOne({ method: 'GET', url: '/api/automations/a-1' }).flush({ ...AUTOMATION, version: 5 }, { headers: { ETag: '"5"' } });
    await settle();
    expect(screen.queryByText('A automação mudou desde que você a abriu.')).toBeNull();
  });

  it('shows the draft as JSON', async () => {
    const user = await open();

    await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));

    expect(JSON.parse(screen.getByTestId('draft-json').textContent ?? '')).toEqual(DRAFT);
  });

  describe('editing the inputs (§7.2, §12.4 AS4a)', () => {
    /** Saves, and returns the document the PUT sent, answering with the next ETag. */
    async function saved(user: ReturnType<typeof userEvent.setup>, etag = '"4"'): Promise<Record<string, unknown>> {
      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      const put = backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' });
      expect(put.request.headers.get('If-Match')).toBe(etag);
      const document = (put.request.body as { document: Record<string, unknown> }).document;
      put.flush({ ...AUTOMATION, version: 5, draft: document }, { headers: { ETag: '"5"' } });
      await settle();
      return document;
    }
    const status = () => screen.getByRole('status', { name: 'Situação da edição' }).textContent?.trim();

    it('writes each change to its field and nothing else, and saves the draft with If-Match (AC1)', async () => {
      const user = await open();
      expect((screen.getByRole('button', { name: 'Salvar rascunho' }) as HTMLButtonElement).disabled).toBe(true);

      await user.click(screen.getByRole('button', { name: 'Adicionar entrada' }));
      expect(document.activeElement).toBe(keyOf(4));
      await user.type(keyOf(4), 'datas');
      await user.tab();
      await user.selectOptions(typeOf(4), 'list');
      await user.selectOptions(group(4).getByRole('combobox', { name: 'Itens da lista' }), 'date');
      await user.click(requiredOf(4));
      await user.click(requiredOf(1));
      await user.selectOptions(typeOf(3), 'object'); // a type no control offered is replaced by a choice
      expect(status()).toBe('Tipo de extra: objeto.');
      expect(screen.getByText('Alterações não salvas')).toBeTruthy();

      const sent = await saved(user);
      expect(sent).toEqual({
        ...DRAFT,
        inputs: [
          { key: 'cpf', type: 'text', required: false },
          { key: 'valor', type: 'number', required: false },
          { key: 'extra', type: 'object', required: false },
          { key: 'datas', type: 'list<date>', required: true },
        ],
      });
      expect(toasts()).toContain('Rascunho salvo.');
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });

    it('renames a key in the path, the query and the body (AC2)', async () => {
      const user = await open();

      await user.clear(keyOf(2));
      await user.type(keyOf(2), 'quantia');
      await user.tab();

      expect(status()).toBe('Chave alterada para quantia, também na consulta e no corpo.');
      const request = (await saved(user))['request'] as Record<string, unknown>;
      expect(request['query']).toEqual({ origem: 'chain', valor: '{quantia}' });
      expect(request['body']).toEqual({ type: 'json', keys: ['cpf', 'quantia'] });
      expect(request['path']).toBe(DRAFT.request.path);
    });

    it('moves and removes rows, keeping the focus in the section, and undoes and redoes each change (AC3)', async () => {
      const user = await open();

      await user.click(group(2).getByRole('button', { name: 'Mover a entrada valor para cima' }));
      expect([1, 2].map((n) => keyOf(n).value)).toEqual(['valor', 'cpf']);
      expect(document.activeElement).toBe(group(1).getByRole('button', { name: 'Mover a entrada valor para baixo' })); // up is now disabled
      await user.click(group(3).getByRole('button', { name: 'Mover a entrada extra para cima' }));
      expect(document.activeElement).toBe(group(2).getByRole('button', { name: 'Mover a entrada extra para cima' })); // still enabled
      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      await user.click(group(2).getByRole('button', { name: 'Remover a entrada cpf' }));
      expect(document.activeElement).toBe(keyOf(2)); // the next row, extra
      expect(status()).toBe('Entrada removida: cpf.');

      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      expect([1, 2, 3].map((n) => keyOf(n).value)).toEqual(['valor', 'cpf', 'extra']);
      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      expect([1, 2, 3].map((n) => keyOf(n).value)).toEqual(['cpf', 'valor', 'extra']);
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Refazer' }));
      expect(keyOf(1).value).toBe('valor');
      expect(status()).toBe('Alteração refeita.');
    });

    it('builds an input with the keyboard alone (AC3)', async () => {
      const user = await open();

      screen.getByRole('button', { name: 'Adicionar entrada' }).focus();
      await user.keyboard('{Enter}');
      await user.keyboard('protocolo');
      await user.tab(); // to Tipo: the key is one change
      await user.selectOptions(document.activeElement as HTMLSelectElement, 'number');
      await user.tab();
      await user.keyboard(' '); // Obrigatória

      expect(inputRow(4)).toEqual(['protocolo', 'Número', true, 'Uso: não usada na chamada']); // the body lists only cpf and valor
      expect(status()).toBe('Entrada protocolo obrigatória.');
    });

    it('shows AU001 and AU002 at their controls, with their cause (AC4)', async () => {
      const user = await open({ ...AUTOMATION, draft: { ...DRAFT, inputs: [...DRAFT.inputs, { key: 'cpf', type: 'texto', required: false }] } });

      expect(keyOf(4).getAttribute('aria-invalid')).toBe('true');
      expect(group(4).getByText('A chave cpf já é usada por outra entrada.')).toBeTruthy();
      expect(group(4).getByText('O tipo texto não existe: escolha um da lista.')).toBeTruthy();
      expect(typeOf(4).selectedOptions[0].textContent?.trim()).toBe('texto (não editável)');

      await user.clear(keyOf(4));
      await user.type(keyOf(4), '1cpf');
      await user.tab();
      expect(group(4).getByText('A chave começa com uma letra, seguida de até 63 letras, dígitos ou _.')).toBeTruthy();
      await user.clear(keyOf(4));
      await user.tab();
      expect(group(4).getByText('Informe a chave.')).toBeTruthy();
      expect(status()).toBe('Chave apagada.');
    });

    it('flags a key the API cannot store, and does not write it (§7.7)', async () => {
      const user = await open();

      await user.clear(keyOf(1));
      await user.type(keyOf(1), 'c\u0000pf');
      await user.tab();

      expect(group(1).getByText('A chave tem caracteres que não podem ser guardados, e não foi gravada.')).toBeTruthy();
      expect(status()).toBe('A chave não foi gravada: ela tem caracteres que não podem ser guardados.');
      expect(screen.queryByText('Alterações não salvas')).toBeNull();

      await user.clear(keyOf(1));
      await user.type(keyOf(1), 'documento');
      await user.tab();
      expect(group(1).queryByText(/não podem ser guardados/)).toBeNull();
      expect(status()).toBe('Chave alterada para documento, também no caminho e no corpo.');
    });

    it('warns at a published key renamed since the draft was opened (§7.2)', async () => {
      const user = await open({ ...AUTOMATION, latestVersion: 2 });
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1/versions/2' }).flush({ versionNumber: 2, document: { inputs: [{ key: 'cpf', type: 'text', required: true }] } });
      await settle();
      const warning = /os mapeamentos com a chave antiga deixam de valer \(WF110\)/;

      await user.click(screen.getByRole('button', { name: 'Adicionar entrada' }));
      await user.type(keyOf(4), 'novo');
      await user.clear(keyOf(2));
      await user.type(keyOf(2), 'quantia'); // not a published key
      await user.tab();
      expect(screen.queryByText(warning)).toBeNull();

      await user.clear(keyOf(1));
      await user.type(keyOf(1), 'documento');
      await user.tab();
      expect(group(1).getByText(warning)).toBeTruthy();
    });

    it('validates and publishes the saved draft, saving it first', async () => {
      const user = await open();
      await user.click(requiredOf(2));

      await user.click(screen.getByRole('button', { name: 'Validar' }));
      backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' }).flush({ ...AUTOMATION, version: 5 }, { headers: { ETag: '"5"' } });
      await settle();
      backend.expectOne({ method: 'POST', url: '/api/automations/a-1/validate' }).flush({ valid: true, errors: [] });
      await settle();
      expect(screen.getByText('Nenhum problema encontrado.')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Publicar' }));
      expect(backend.expectOne({ method: 'POST', url: '/api/automations/a-1/publish' }).request.headers.get('If-Match')).toBe('"5"');
    });

    it('discards back to the saved draft after asking', async () => {
      const user = await open();
      await user.click(requiredOf(1));

      await user.click(screen.getByRole('button', { name: 'Descartar alterações' }));
      const dialog = await screen.findByRole('dialog', { name: 'Descartar as alterações?' });
      await user.click(within(dialog).getByRole('button', { name: 'Descartar' }));
      await settle();

      expect(requiredOf(1).checked).toBe(true);
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
      expect((screen.getByRole('button', { name: 'Desfazer' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('asks before leaving or closing the page with unsaved changes (AC5)', async () => {
      const user = await open();
      const closing = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const page = TestBed.inject(Router);

      expect(closing()).toBe(false);
      await user.click(requiredOf(1));
      expect(closing()).toBe(true);

      const staying = page.navigateByUrl('/automacoes');
      const dialog = await screen.findByRole('dialog', { name: 'Sair sem salvar?' });
      await user.click(within(dialog).getByRole('button', { name: 'Continuar editando' }));
      expect(await staying).toBe(false);
      expect(requiredOf(1).checked).toBe(false);
    });

    it('offers to reload after a 412, asking first since there are unsaved changes (AC5)', async () => {
      const user = await open();
      await user.click(requiredOf(1));

      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      backend
        .expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' })
        .flush({ type: 'about:blank', title: 'Changed', status: 412, code: 'version_mismatch' }, { status: 412, statusText: 'Precondition Failed' });
      await settle();
      expect(screen.getByText('A automação mudou desde que você a abriu.')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Recarregar' }));
      const dialog = await screen.findByRole('dialog', { name: 'Recarregar a automação?' });
      await user.click(within(dialog).getByRole('button', { name: 'Recarregar' }));
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1' }).flush({ ...AUTOMATION, version: 6 }, { headers: { ETag: '"6"' } });
      await settle();
      expect(requiredOf(1).checked).toBe(true);
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });

    it('offers Tentar de novo when the answer is unknown, and a retry that meets 412 reloads and says so (AC5, §8.1)', async () => {
      const user = await open();
      await user.click(requiredOf(1));

      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' }).flush(null, { status: 504, statusText: 'Gateway Timeout' });
      await settle();
      expect(screen.getByText('Não foi possível confirmar o envio.')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
      const retry = backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' });
      expect(retry.request.headers.get('If-Match')).toBe('"4"');
      expect((retry.request.body as { document: { inputs: { required: boolean }[] } }).document.inputs[0].required).toBe(false);
      retry.flush({ type: 'about:blank', title: 'Changed', status: 412, code: 'version_mismatch' }, { status: 412, statusText: 'Precondition Failed' });
      await settle();
      // Nothing was edited after the first attempt, so reloading loses nothing: it doesn't ask.
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1' }).flush({ ...AUTOMATION, version: 5, draft: { ...DRAFT, inputs: [{ ...DRAFT.inputs[0], required: false }, ...DRAFT.inputs.slice(1)] } }, { headers: { ETag: '"5"' } });
      await settle();

      expect(screen.getByText('Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.')).toBeTruthy();
      expect(requiredOf(1).checked).toBe(false);
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });
  });

  describe('editing the call (§7.3, §12.4 AS4b-1)', () => {
    const call = () => within(screen.getByRole('region', { name: 'Chamada' }));
    const field = (name: string) => call().getByRole(/^(Destino|Método|Corpo)$/.test(name) ? 'combobox' : 'textbox', { name }) as HTMLInputElement & HTMLSelectElement;
    const parameter = (n: number) => within(call().getByRole('group', { name: `Parâmetro ${n}` }));
    const status = () => screen.getByRole('status', { name: 'Situação da edição' }).textContent?.trim();
    const WILDCARD = { name: 'lojas', description: 'As lojas', scheme: 'https', host: '*.lojas.example', port: 8443, pathPrefix: null };
    const blank = { ...AUTOMATION, draft: { schemaVersion: 1, kind: 'http', inputs: DRAFT.inputs, request: { method: 'GET', destination: '', path: '/' }, response: { type: 'none' } } };

    async function sent(user: ReturnType<typeof userEvent.setup>): Promise<Record<string, unknown>> {
      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      const put = backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' });
      const document = (put.request.body as { document: Record<string, unknown> }).document;
      put.flush({ ...AUTOMATION, version: 5, draft: document }, { headers: { ETag: '"5"' } });
      await settle();
      return document['request'] as Record<string, unknown>;
    }

    it("writes the destination, the method, the host and the path, setting the path to the destination's prefix while it is / (AC1, AC2)", async () => {
      const user = await open(blank, 200, { ...RESOURCES, destinations: [...RESOURCES.destinations, WILDCARD] });

      await user.selectOptions(field('Destino'), 'erp');
      expect(field('Caminho').value).toBe('/v1');
      expect(status()).toBe('Destino: erp. O caminho passou a ser /v1, o prefixo do destino.');
      await user.selectOptions(field('Método'), 'POST');
      await user.clear(field('Caminho'));
      await user.type(field('Caminho'), '/v1/consultas');
      await user.tab();
      expect(call().queryByRole('textbox', { name: 'Host' })).toBeNull(); // an exact destination takes its own host

      expect(await sent(user)).toEqual({ method: 'POST', destination: 'erp', path: '/v1/consultas' });

      await user.selectOptions(field('Destino'), 'lojas');
      expect(call().getByText('Um subdomínio de *.lojas.example, como api.lojas.example')).toBeTruthy();
      expect(field('Host').getAttribute('aria-invalid')).toBe('true'); // AU106 until a subdomain is named
      await user.type(field('Host'), 'centro.lojas.example');
      await user.tab();
      expect(call().getByText('Depois de https://centro.lojas.example:8443')).toBeTruthy();
      expect(field('Host').getAttribute('aria-invalid')).toBeNull();
      expect(await sent(user)).toEqual({ method: 'POST', destination: 'lojas', host: 'centro.lojas.example', path: '/v1/consultas' });
    });

    it('offers only the inputs that fit a path, and inserts one at the caret as one change (AC3)', async () => {
      const user = await open(blank);
      await user.selectOptions(field('Destino'), 'erp');
      const path = field('Caminho');
      await user.click(path);
      await user.keyboard('/clientes/x');
      path.setSelectionRange(path.value.length - 1, path.value.length); // the x is selected

      await user.click(call().getByRole('button', { name: 'Inserir entrada em Caminho' }));
      expect(screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['{cpf}, texto', '{valor}, número']); // not extra, a list of lists
      await user.click(screen.getByRole('menuitem', { name: /^\{cpf\}/ }));

      expect(path.value).toBe('/v1/clientes/{cpf}');
      expect(document.activeElement).toBe(path);
      expect(path.selectionStart).toBe(path.value.length);
      expect(status()).toBe('Caminho: /v1/clientes/{cpf}.');
      expect(group(1).getByText('Uso: no caminho')).toBeTruthy();
    });

    it('edits query rows as fixed text or an input, and waits to save while two share a name (AC1, AC4)', async () => {
      const user = await open();
      expect([1, 2].map((n) => (parameter(n).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement).value)).toEqual(['origem', 'valor']);
      expect((parameter(2).getByRole('combobox', { name: 'Entrada' }) as HTMLSelectElement).value).toBe('{valor}');

      await user.click(call().getByRole('button', { name: 'Adicionar parâmetro' }));
      expect(document.activeElement).toBe(parameter(3).getByRole('textbox', { name: 'Nome' }));
      await user.keyboard('origem');
      await user.tab();
      expect(parameter(3).getByText('Outro parâmetro já tem este nome.')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      expect(status()).toBe('Dois parâmetros da consulta se chamam origem: renomeie ou remova um.'); // and nothing was sent

      await user.clear(parameter(3).getByRole('textbox', { name: 'Nome' }));
      await user.type(parameter(3).getByRole('textbox', { name: 'Nome' }), 'doc');
      await user.tab();
      await user.selectOptions(parameter(3).getByRole('combobox', { name: 'Valor é' }), 'input');
      await user.selectOptions(parameter(3).getByRole('combobox', { name: 'Entrada' }), '{valor}');
      await user.selectOptions(parameter(2).getByRole('combobox', { name: 'Valor é' }), 'literal');
      await user.type(parameter(2).getByRole('textbox', { name: 'Valor' }), '10');
      await user.tab();
      await user.click(parameter(1).getByRole('button', { name: 'Remover o parâmetro origem' }));
      expect(document.activeElement).toBe(parameter(1).getByRole('textbox', { name: 'Nome' }));

      expect((await sent(user))['query']).toEqual({ valor: '10', doc: '{valor}' });
    });

    it('writes the body: none, every input, or only some, checked in input order (AC1)', async () => {
      const user = await open();
      expect(field('Corpo').value).toBe('some');
      const keys = () => within(call().getByRole('group', { name: 'Entradas no corpo' }));
      expect((keys().getByRole('checkbox', { name: 'extra' }) as HTMLInputElement).checked).toBe(false);

      await user.click(keys().getByRole('checkbox', { name: 'cpf' }));
      await user.click(keys().getByRole('checkbox', { name: 'extra' }));
      await user.click(keys().getByRole('checkbox', { name: 'cpf' }));
      expect(status()).toBe('Entrada cpf no corpo.');
      expect((await sent(user))['body']).toEqual({ type: 'json', keys: ['valor', 'extra', 'cpf'] });

      await user.selectOptions(field('Corpo'), 'all');
      expect(call().queryByRole('group', { name: 'Entradas no corpo' })).toBeNull();
      expect((await sent(user))['body']).toEqual({ type: 'json' });
      await user.selectOptions(field('Corpo'), 'none');
      expect((await sent(user))['body']).toBeNull();
    });

    it("shows the call's local checks at their controls, with their cause (AC5)", async () => {
      const draft = {
        ...DRAFT,
        request: { ...DRAFT.request, method: 'GET', destination: 'sumiu', path: '/v2/{nope}', query: { q: '{extra}' }, body: { type: 'json', keys: ['cpf', 'nope'] } },
      };
      const user = await open({ ...AUTOMATION, draft });

      expect(field('Destino').selectedOptions[0].textContent?.trim()).toBe('sumiu (não existe mais)');
      expect(call().getByText('O destino sumiu não existe mais.')).toBeTruthy();
      expect(call().getByText('{nope} não é uma entrada.')).toBeTruthy();
      expect(parameter(1).getByText('{extra} é uma entrada do tipo lista de listas de textos: na consulta só cabem entradas de texto, número, sim ou não, data, data e hora ou hora.')).toBeTruthy();
      expect(call().getByText('GET e DELETE não têm corpo.')).toBeTruthy();
      expect(call().getByText('nope não é uma entrada.')).toBeTruthy();

      await user.selectOptions(field('Destino'), 'erp');
      expect(field('Caminho').getAttribute('aria-invalid')).toBe('true');
      expect(call().getByText('{nope} não é uma entrada. O caminho precisa ficar dentro de /v1, o prefixo do destino.')).toBeTruthy(); // the server's order
    });

    it('flags text the API cannot store, and does not write it (§7.7)', async () => {
      const user = await open();

      await user.clear(field('Caminho'));
      await user.type(field('Caminho'), '/v1/a\u0000');
      await user.tab();

      expect(call().getByText(/O texto tem caracteres que não podem ser guardados, e não foi gravado./)).toBeTruthy();
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });
  });

  describe('credentials in the call (§7.3, §7.8, §12.4 AS4b-2)', () => {
    const call = () => within(screen.getByRole('region', { name: 'Chamada' }));
    const header = (n: number) => within(call().getByRole('group', { name: `Cabeçalho ${n}` }));
    const status = () => screen.getByRole('status', { name: 'Situação da edição' }).textContent?.trim();
    const WITH_SECRETS = {
      ...RESOURCES,
      secrets: [
        { name: 'erp_api_key', description: 'Chave do ERP', allowedDestinations: ['erp'] },
        { name: 'crm_key', description: null, allowedDestinations: ['crm'] },
      ],
    };
    const blank = { ...AUTOMATION, draft: { schemaVersion: 1, kind: 'http', inputs: DRAFT.inputs, request: { method: 'GET', destination: 'erp', path: '/v1' }, response: { type: 'none' } } };

    async function sent(user: ReturnType<typeof userEvent.setup>): Promise<Record<string, unknown>> {
      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      const put = backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' });
      const document = (put.request.body as { document: Record<string, unknown> }).document;
      put.flush({ ...AUTOMATION, version: 5, draft: document }, { headers: { ETag: '"5"' } });
      await settle();
      return document['request'] as Record<string, unknown>;
    }

    it('inserts a credential at the caret of a header value, names it below, and refuses one the destination does not allow (AC1, AC2)', async () => {
      const user = await open(blank, 200, WITH_SECRETS);

      await user.click(call().getByRole('button', { name: 'Adicionar cabeçalho' }));
      expect(document.activeElement).toBe(header(1).getByRole('textbox', { name: 'Nome' }));
      await user.keyboard('Authorization');
      await user.tab();
      await user.keyboard('Bearer ');
      await user.click(header(1).getByRole('button', { name: 'Inserir credencial em Valor de Authorization' }));
      const refused = screen.getByRole('menuitem', { name: /^crm_key/ });
      expect(refused.textContent?.trim()).toBe('crm_key. Não permite o destino erp. Peça a um administrador.');
      await user.click(refused);
      expect(header(1).getByRole('textbox', { name: 'Valor' })).toHaveProperty('value', 'Bearer ');
      expect(header(1).getByRole('button', { name: 'Inserir credencial em Valor de Authorization' }).getAttribute('aria-expanded')).toBe('true'); // still open, with the reason
      await user.click(screen.getByRole('menuitem', { name: /^erp_api_key/ }));

      const value = header(1).getByRole('textbox', { name: 'Valor' }) as HTMLInputElement;
      expect(value.value).toBe('Bearer {{secret:erp_api_key}}');
      expect(document.activeElement).toBe(value);
      expect(header(1).getByText('Credencial erp_api_key: Chave do ERP')).toBeTruthy();
      expect(status()).toBe('Valor de Authorization alterado.');
      expect((await sent(user))['headers']).toEqual({ Authorization: 'Bearer {{secret:erp_api_key}}' });
    });

    it('says to choose a destination first, and warns at a literal credential (§7.8)', async () => {
      const user = await open({ ...blank, draft: { ...blank.draft, request: { method: 'GET', destination: '', path: '/' } } }, 200, WITH_SECRETS);

      await user.click(call().getByRole('button', { name: 'Adicionar cabeçalho' }));
      await user.keyboard('X-Api-Key');
      await user.tab();
      await user.keyboard('abc123');
      await user.tab();
      expect(header(1).getByText(/Este valor fica visível para quem modela/)).toBeTruthy();

      await user.click(header(1).getByRole('button', { name: 'Inserir credencial em Valor de X-Api-Key' }));
      expect(screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['Escolha o destino primeiro.']);
    });

    it('flags header names as they are typed (AU006), and refuses a 31st header', async () => {
      const headers = Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`X-${i}`, 'v']));
      const user = await open({ ...blank, draft: { ...blank.draft, request: { ...blank.draft.request, headers } } }, 200, WITH_SECRETS);

      await user.click(call().getByRole('button', { name: 'Adicionar cabeçalho' }));
      await user.keyboard('Host');
      await user.tab();
      expect(header(30).getByText('O cliente HTTP define Host; uma automação não pode.')).toBeTruthy();

      await user.click(call().getByRole('button', { name: 'Adicionar cabeçalho' }));
      expect(status()).toBe('Uma automação envia no máximo 30 cabeçalhos.');
      await user.click(header(30).getByRole('button', { name: 'Remover o cabeçalho Host' }));
      expect(document.activeElement).toBe(header(29).getByRole('textbox', { name: 'Nome' }));
    });

    it('writes basic authentication with credentials, warns at a literal password, and flags it beside an Authorization header (AC1, AC3)', async () => {
      const user = await open(blank, 200, WITH_SECRETS);
      const auth = () => call().getByRole('combobox', { name: 'Autenticação' }) as HTMLSelectElement;

      await user.selectOptions(auth(), 'basic');
      expect(call().getByText('A autenticação básica tem usuário e senha.')).toBeTruthy();
      await user.type(call().getByRole('textbox', { name: 'Usuário' }), 'chain');
      await user.type(call().getByRole('textbox', { name: 'Senha' }), 'hunter2');
      await user.tab();
      expect(call().getByText(/Este valor fica visível para quem modela/)).toBeTruthy();
      expect(status()).toBe('Senha alterada.');

      await user.clear(call().getByRole('textbox', { name: 'Senha' }));
      await user.click(call().getByRole('button', { name: 'Inserir credencial em Senha' }));
      await user.click(screen.getByRole('menuitem', { name: /^erp_api_key/ }));
      expect(call().queryByText(/Este valor fica visível para quem modela/)).toBeNull();
      expect((await sent(user))['auth']).toEqual({ type: 'basic', username: 'chain', password: '{{secret:erp_api_key}}' });

      await user.click(call().getByRole('button', { name: 'Adicionar cabeçalho' }));
      await user.keyboard('authorization');
      await user.tab();
      expect(call().getByText('Use a autenticação básica ou um cabeçalho Authorization, não os dois.')).toBeTruthy();
      await user.selectOptions(auth(), 'none');
      expect(call().queryByRole('textbox', { name: 'Usuário' })).toBeNull();
    });

    it('builds a call with the keyboard: an input in the path and in the query, a credential in a header, a body; and undoes and redoes each change (AC4)', async () => {
      const user = await open(blank, 200, WITH_SECRETS);
      const press = async (name: string | RegExp) => {
        call().getByRole('button', { name }).focus();
        await user.keyboard('{Enter}');
      };

      await press('Inserir entrada em Caminho');
      await user.keyboard('{Enter}'); // the first input that fits, {cpf}
      await press('Adicionar parâmetro');
      await user.keyboard('doc');
      await user.tab();
      await user.selectOptions(document.activeElement as HTMLSelectElement, 'input');
      await press('Adicionar cabeçalho');
      await user.keyboard('X-Api-Key');
      await user.tab();
      await press('Inserir credencial em Valor de X-Api-Key');
      await user.keyboard('{Enter}'); // erp_api_key, the first that the destination allows
      await user.selectOptions(call().getByRole('combobox', { name: 'Método' }), 'POST');
      await user.selectOptions(call().getByRole('combobox', { name: 'Corpo' }), 'all');

      const built = { method: 'POST', destination: 'erp', path: '/v1{cpf}', query: { doc: '{cpf}' }, headers: { 'X-Api-Key': '{{secret:erp_api_key}}' }, body: { type: 'json' } };
      const changes = 8; // the path, a row, its name, its value, a header, its name, its value, the method; and the body
      const undo = screen.getByRole('button', { name: 'Desfazer' });
      for (let n = 0; n <= changes; n++) {
        undo.focus();
        await user.keyboard('{Enter}');
      }
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
      const redo = screen.getByRole('button', { name: 'Refazer' });
      for (let n = 0; n <= changes; n++) {
        redo.focus();
        await user.keyboard('{Enter}');
      }
      expect(await sent(user)).toEqual(built);
    });
  });

  describe('editing the response and the outputs (§7.4, §12.5 AS5a)', () => {
    const section = () => within(screen.getByRole('region', { name: 'Resposta e saídas' }));
    const output = (n: number) => within(section().getByRole('group', { name: `Saída ${n}` }));
    const field = (n: number, name: string) => output(n).getByRole(/^(Origem|Tipo)$/.test(name) ? 'combobox' : 'textbox', { name }) as HTMLInputElement & HTMLSelectElement;
    const status = () => screen.getByRole('status', { name: 'Situação da edição' }).textContent?.trim();

    async function sent(user: ReturnType<typeof userEvent.setup>): Promise<Record<string, unknown>> {
      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      const put = backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' });
      const document = (put.request.body as { document: Record<string, unknown> }).document;
      put.flush({ ...AUTOMATION, version: 5, draft: document }, { headers: { ETag: '"5"' } });
      await settle();
      return document;
    }

    it('writes each output field and nothing else; a status output is a number without a path (AC2, AC3)', async () => {
      const user = await open();

      await user.click(section().getByRole('button', { name: 'Adicionar saída' }));
      expect(document.activeElement).toBe(field(4, 'Chave'));
      await user.keyboard('protocolo');
      await user.tab();
      await user.type(field(4, 'Caminho'), 'dados.protocolo');
      await user.tab();
      await user.selectOptions(field(4, 'Tipo'), 'number');
      await user.click(output(4).getByRole('checkbox', { name: 'Obrigatória' }));
      await user.selectOptions(field(1, 'Origem'), 'status');
      expect(output(1).queryByRole('textbox', { name: 'Caminho' })).toBeNull();
      expect(status()).toBe('Origem de situacao: status HTTP.');

      const outputs = (await sent(user))['outputs'];
      expect(outputs).toEqual([
        { key: 'situacao', type: 'number', required: true, source: 'status' },
        DRAFT.outputs[1],
        DRAFT.outputs[2],
        { key: 'protocolo', type: 'number', required: true, source: 'body', path: ['dados', 'protocolo'] },
      ]);
    });

    it("reads and writes the path's text form, and does not write a text that isn't a path (AC1)", async () => {
      const user = await open();

      await user.clear(field(1, 'Caminho'));
      await user.type(field(1, 'Caminho'), 'a b');
      await user.tab();
      expect(output(1).getByText('Um nome com ponto, colchete, aspas ou espaço vai entre colchetes e aspas, como ["nome completo"].')).toBeTruthy();
      expect(screen.queryByText('Alterações não salvas')).toBeNull();

      await user.clear(field(1, 'Caminho'));
      await user.type(field(1, 'Caminho'), 'itens[[0].a.0[[""]'); // user-event types a [ as [[
      await user.tab();
      expect(output(1).queryByText(/vai entre colchetes/)).toBeNull();
      expect(((await sent(user))['outputs'] as { path?: unknown[] }[])[0].path).toEqual(['itens', 0, 'a', '0', '']);
    });

    it('sets the response, and shows the local checks at their controls (AC4)', async () => {
      const outputs = [
        { key: 'a', type: 'text', required: true, source: 'body', path: Array.from({ length: 21 }, (_, i) => `p${i}`) },
        { key: 'a', type: 'number', required: false, source: 'status', path: ['x'] },
      ];
      const user = await open({ ...AUTOMATION, draft: { ...DRAFT, outputs } });

      expect(output(1).getByText('Uma saída do corpo lê um caminho de 1 a 20 nomes ou posições.')).toBeTruthy();
      expect(output(2).getByText('A chave a já é usada por outra saída.')).toBeTruthy();
      expect(output(2).getByText('Uma saída do status HTTP não tem caminho.')).toBeTruthy();

      await user.selectOptions(section().getByRole('combobox', { name: 'Resposta' }), 'none');
      expect(status()).toBe('Resposta: nenhuma.');
      expect(output(1).getByText('Saídas lidas do corpo pedem a resposta JSON.')).toBeTruthy();
    });

    it('moves and removes outputs, keeping the focus in the section', async () => {
      const user = await open();

      await user.click(output(3).getByRole('button', { name: 'Mover a saída httpStatus para cima' }));
      expect(document.activeElement).toBe(output(2).getByRole('button', { name: 'Mover a saída httpStatus para cima' }));
      await user.click(output(2).getByRole('button', { name: 'Remover a saída httpStatus' }));
      expect(document.activeElement).toBe(field(2, 'Chave'));
      expect(status()).toBe('Saída removida: httpStatus.');
    });
  });

  describe('editing the execution (§7.5, §12.5 AS5b)', () => {
    const section = () => within(screen.getByRole('region', { name: 'Execução' }));
    const field = (name: string) => section().getByRole(/^(Chave de idempotência|Redirecionamentos)$/.test(name) ? 'combobox' : 'textbox', { name }) as HTMLInputElement & HTMLSelectElement;
    const status = () => screen.getByRole('status', { name: 'Situação da edição' }).textContent?.trim();
    const noExecution = { ...AUTOMATION, draft: { ...DRAFT, execution: undefined } };

    async function sent(user: ReturnType<typeof userEvent.setup>): Promise<unknown> {
      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      const put = backend.expectOne({ method: 'PUT', url: '/api/automations/a-1/draft' });
      const document = (put.request.body as { document: Record<string, unknown> }).document;
      put.flush({ ...AUTOMATION, version: 5, draft: document }, { headers: { ETag: '"5"' } });
      await settle();
      return document['execution'];
    }

    it('writes the whole execution object, every value explicit, and the deadline follows the numbers (AC2)', async () => {
      const user = await open(noExecution);
      expect(section().getByText('Sem resultado em 16 min 30 s, a etapa falha (sem resultado no prazo).')).toBeTruthy();

      await user.clear(field('Tentativas'));
      await user.type(field('Tentativas'), '1');
      await user.tab();
      await user.clear(field('Tempo limite por tentativa'));
      await user.type(field('Tempo limite por tentativa'), '10');
      await user.tab();

      expect(status()).toBe('Tempo limite por tentativa: 10 s.');
      expect(section().getByText('Sem resultado em 10 min 10 s, a etapa falha (sem resultado no prazo).')).toBeTruthy();
      expect(await sent(user)).toEqual({
        timeoutSeconds: 10,
        retry: { maxAttempts: 1, initialDelaySeconds: 5 },
        idempotency: { mode: 'header', header: 'Idempotency-Key' },
        redirects: { follow: false, max: 0 },
      });
    });

    it('warns without the idempotency key, and leaves no header in the document (AC1)', async () => {
      const user = await open();

      await user.selectOptions(field('Chave de idempotência'), 'none');

      expect(section().queryByRole('textbox', { name: 'Cabeçalho da chave' })).toBeNull();
      expect(section().getByText(/Sem a chave, o sistema de destino não reconhece repetições\..* Considere usar uma tentativa só\.$/)).toBeTruthy();
      expect(screen.getByLabelText('Prévia da chamada', { selector: 'pre' }).textContent).not.toContain('Idempotency-Key');
      expect(((await sent(user)) as { idempotency: object }).idempotency).toEqual({ mode: 'none' });

      await user.selectOptions(field('Chave de idempotência'), 'header');
      await user.clear(field('Cabeçalho da chave'));
      await user.type(field('Cabeçalho da chave'), 'X-Chave');
      await user.tab();
      expect(status()).toBe('Chave de idempotência no cabeçalho X-Chave.');
      expect(((await sent(user)) as { idempotency: object }).idempotency).toEqual({ mode: 'header', header: 'X-Chave' });
    });

    it('does not write a number that is not whole, and writes one out of range, flagged (AC3)', async () => {
      const user = await open();

      await user.clear(field('Tentativas'));
      await user.type(field('Tentativas'), '2,5');
      await user.tab();
      expect(section().getByText('Informe um número inteiro. O valor anterior continua valendo.')).toBeTruthy();
      expect(screen.queryByText('Alterações não salvas')).toBeNull();

      await user.clear(field('Tentativas'));
      await user.type(field('Tentativas'), '11');
      await user.tab();
      expect(section().getByText('As tentativas vão de 1 a 10.')).toBeTruthy();
      expect(((await sent(user)) as { retry: { maxAttempts: number } }).retry.maxAttempts).toBe(11);
    });

    it('follows redirects up to a maximum, and not following is a maximum of 0', async () => {
      const user = await open();

      await user.selectOptions(field('Redirecionamentos'), 'yes');
      expect(field('Até quantos redirecionamentos').value).toBe('1');
      await user.clear(field('Até quantos redirecionamentos'));
      await user.type(field('Até quantos redirecionamentos'), '3');
      await user.tab();
      expect(status()).toBe('Redirecionamentos: seguir até 3.');
      expect(((await sent(user)) as { redirects: object }).redirects).toEqual({ follow: true, max: 3 });

      await user.selectOptions(field('Redirecionamentos'), 'no');
      expect(section().queryByRole('textbox', { name: 'Até quantos redirecionamentos' })).toBeNull();
      expect(((await sent(user)) as { redirects: object }).redirects).toEqual({ follow: false, max: 0 });
    });
  });

  describe('versions (§8.4, §12.6 AS6)', () => {
    const VERSIONS = [
      { versionNumber: 1, contentHash: 'h1', publishedAt: '2026-10-18T12:00:00Z', publishedBy: 'u-1' },
      { versionNumber: 2, contentHash: 'h2', publishedAt: '2026-10-19T12:00:00Z', publishedBy: 'u-1' },
    ];
    const V1 = { ...DRAFT, inputs: [DRAFT.inputs[0]], outputs: [DRAFT.outputs[2]] };

    async function panel(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: 'Versões' }));
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1/versions' }).flush(VERSIONS);
      await settle();
      return within(await screen.findByRole('dialog', { name: 'Versões' }));
    }

    it('lists every version, newest first, and shows one read-only with its call and JSON (AC1)', async () => {
      const user = await open({ ...AUTOMATION, latestVersion: 2 });
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1/versions/2' }).flush({ versionNumber: 2, document: DRAFT });
      const versions = await panel(user);

      expect(versions.getAllByText(/^Versão \d$/).map((item) => item.textContent)).toEqual(['Versão 2', 'Versão 1']);
      await user.click(versions.getByRole('button', { name: 'Visualizar a versão 1' }));
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1/versions/1' }).flush({ versionNumber: 1, contentHash: 'h1', publishedAt: '2026-10-18T12:00:00Z', document: V1 });
      await settle();

      const version = within(await screen.findByRole('dialog', { name: 'Versão 1' }));
      expect(version.getByLabelText('Chamada desta versão', { selector: 'pre' }).textContent).toContain('POST https://api.erp.example/v1/clientes/{cpf}/consultas');
      expect(version.getByText('cpf').closest('li')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('cpf: texto, obrigatória');
      expect(version.getByText('httpStatus').closest('li')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('httpStatus: número, obrigatória, status HTTP');
      expect(JSON.parse(version.getByTestId('version-json').textContent ?? '')).toEqual(V1);
      await expectNoAxeViolations(); // two dialogs open, which #263 made landmark-free
    });

    it('restores after asking, saying unsaved changes are lost; the draft is replaced and nothing is published (AC2)', async () => {
      const user = await open({ ...AUTOMATION, latestVersion: 2 });
      backend.expectOne({ method: 'GET', url: '/api/automations/a-1/versions/2' }).flush({ versionNumber: 2, document: DRAFT });
      await user.click(requiredOf(2)); // an unsaved change
      const versions = await panel(user);

      await user.click(versions.getByRole('button', { name: 'Restaurar a versão 1 no rascunho' }));
      const confirm = within(await screen.findByRole('dialog', { name: 'Restaurar a versão 1?' }));
      expect(confirm.getByText('O rascunho passa a ser uma cópia da versão 1. Nada é publicado. As alterações não salvas serão perdidas.')).toBeTruthy();
      await user.click(confirm.getByRole('button', { name: 'Restaurar' }));
      const restore = backend.expectOne({ method: 'POST', url: '/api/automations/a-1/versions/1/restore' });
      expect(restore.request.headers.get('If-Match')).toBe('"4"');
      restore.flush({ ...AUTOMATION, latestVersion: 2, version: 5, draft: V1 }, { headers: { ETag: '"5"' } });
      await settle();

      expect(toasts()).toContain('Versão 1 restaurada no rascunho.');
      expect([1].map(inputRow)).toEqual([['cpf', 'Texto', true, 'Uso: no caminho, no corpo']]);
      expect(screen.queryByRole('group', { name: 'Entrada 2' })).toBeNull();
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
      expect(screen.getByText('Versão publicada: 2')).toBeTruthy(); // nothing was published
    });

    it('offers to reload when the automation changed meanwhile (AC2)', async () => {
      const user = await open();
      const versions = await panel(user);

      await user.click(versions.getByRole('button', { name: 'Restaurar a versão 2 no rascunho' }));
      await user.click(within(await screen.findByRole('dialog', { name: 'Restaurar a versão 2?' })).getByRole('button', { name: 'Restaurar' }));
      backend
        .expectOne({ method: 'POST', url: '/api/automations/a-1/versions/2/restore' })
        .flush({ type: 'about:blank', title: 'Changed', status: 412, code: 'version_mismatch' }, { status: 412, statusText: 'Precondition Failed' });
      await settle();

      expect(screen.getByText('A automação mudou desde que você a abriu.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
    });
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      await open();
      await expectNoAxeViolations();
    });
  });
});
