import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { DestinationsPage } from './destinations-page';

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
const SECRETS = [{ name: 'erp_key', description: null, allowedDestinations: ['erp'], version: 1, keyId: 'kek', createdAt: 'x', rotatedAt: null, updatedAt: 'x' }];
const INTERNO = { ...ERP, name: 'interno', description: null, scheme: 'http', host: 'erp.interno', port: null, pathPrefix: null, internal: true, maxResponseBytes: 1_048_576 };
const problem = (status: number, code: string, extra: object = {}) => [{ type: 'about:blank', title: code, status, code, ...extra }, { status, statusText: code }] as const;

describe('DestinationsPage (automation-ui.md §3, AS1)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);

  async function open(list: unknown[] = [ERP, INTERNO]) {
    await render(DestinationsPage, {
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideJsdomInteractivity()],
    });
    backend = TestBed.inject(HttpTestingController);
    await reloadList(list);
    return userEvent.setup();
  }
  const reloadList = async (list: unknown[] = [ERP, INTERNO]) => {
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/destinations' }).flush(list);
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/secrets' }).flush(SECRETS);
    await settle();
  };
  const panel = () => within(screen.getByRole('dialog'));
  const field = (name: RegExp) => panel().getByRole('textbox', { name });

  afterEach(() => backend.verify());

  it('lists each destination with its address, badges, description and update time (§3.1)', async () => {
    await open();

    const cards = screen.getAllByRole('listitem');
    expect(within(cards[0]).getByText('https://api.erp.example:8443/v1')).toBeTruthy();
    expect(within(cards[0]).getByText('Resposta até 2 MiB')).toBeTruthy();
    expect(within(cards[0]).getByText('O ERP da empresa')).toBeTruthy();
    expect(within(cards[0]).getByText('Credenciais que o permitem: erp_key')).toBeTruthy();
    expect(within(cards[1]).getByText('Credenciais que o permitem: nenhuma')).toBeTruthy();
    expect(within(cards[1]).getByText('http://erp.interno')).toBeTruthy();
    expect(within(cards[1]).getAllByText(/Interno|HTTP sem TLS/).map((badge) => badge.textContent)).toEqual(['Interno', 'HTTP sem TLS']);
  });

  it('filters by name or host, and says when there are none', async () => {
    const user = await open();

    await user.type(screen.getByRole('searchbox', { name: 'Filtrar por nome ou host' }), 'interno');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await user.clear(screen.getByRole('searchbox', { name: 'Filtrar por nome ou host' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filtrar por nome ou host' }), 'nada');
    expect(screen.getByText('Nenhum destino com esse nome ou host.')).toBeTruthy();
  });

  it('says so when there are no destinations yet', async () => {
    await open([]);

    expect(screen.getByText('Nenhum destino ainda. Crie o primeiro com “Novo destino”.')).toBeTruthy();
  });

  it('creates a destination with every field, refusing HTTP without Interno at the field first (§3.2)', async () => {
    const user = await open();

    await user.click(screen.getByRole('button', { name: 'Novo destino' }));
    await user.type(field(/^Nome/), 'novo');
    await user.type(field(/^Host/), 'API.Novo.Example');
    expect((field(/^Host/) as HTMLInputElement).value).toBe('api.novo.example'); // lowercased as typed
    await user.selectOptions(panel().getByRole('combobox', { name: 'Esquema' }), 'HTTP');
    expect(panel().getByText('HTTP só é permitido em destinos internos.')).toBeTruthy();
    await user.click(panel().getByRole('button', { name: 'Salvar' }));
    backend.expectNone('/api/admin/automation/destinations'); // refused before sending

    await user.click(panel().getByRole('checkbox', { name: 'Interno' }));
    await user.click(panel().getByRole('checkbox', { name: 'Aceitar credenciais por HTTP' }));
    await user.type(field(/^Porta/), '8080');
    await user.type(field(/^Prefixo do caminho/), '/api');
    await user.type(field(/^Tamanho máximo do envio/), '512');
    await user.selectOptions(panel().getByRole('combobox', { name: 'Tamanho máximo do envio: unidade' }), 'KiB');
    expect(panel().getByText('http://api.novo.example:8080/api')).toBeTruthy();
    await user.click(panel().getByRole('button', { name: 'Salvar' }));

    const create = backend.expectOne({ method: 'POST', url: '/api/admin/automation/destinations' });
    expect(create.request.body).toEqual({
      name: 'novo',
      description: null,
      scheme: 'http',
      host: 'api.novo.example',
      port: 8080,
      pathPrefix: '/api',
      internal: true,
      allowSecretsOverHttp: true,
      maxRequestBytes: 524_288,
      maxResponseBytes: null,
    });
    create.flush({ ...ERP, name: 'novo' }, { status: 201, statusText: 'Created', headers: { ETag: '"1"' } });
    await settle();
    await reloadList();
    expect(toasts()).toContain('Destino salvo.');
  });

  it("shows the server's codes at their fields", async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo destino' }));
    await user.type(field(/^Nome/), 'erp');
    await user.type(field(/^Host/), 'api.erp.example');
    await user.click(panel().getByRole('button', { name: 'Salvar' }));

    backend.expectOne({ method: 'POST', url: '/api/admin/automation/destinations' }).flush(...problem(409, 'destination_name_taken'));
    await settle();

    expect(panel().getByText('Já existe um destino com este nome.')).toBeTruthy();
  });

  it('edits every field with If-Match, and a stale one offers to reload, overwriting nothing (§3.4)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Editar o destino erp' }));
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/destinations/erp' }).flush(ERP, { headers: { ETag: '"3"' } });
    await settle();
    expect((field(/^Nome/) as HTMLInputElement).readOnly).toBe(true);
    expect((field(/^Tamanho máximo do envio/) as HTMLInputElement).value).toBe(''); // the default
    expect((field(/^Tamanho máximo da resposta/) as HTMLInputElement).value).toBe('2');

    await user.clear(field(/^Descrição/));
    await user.type(field(/^Descrição/), 'Novo texto');
    await user.click(panel().getByRole('button', { name: 'Salvar' }));
    const update = backend.expectOne({ method: 'PUT', url: '/api/admin/automation/destinations/erp' });
    expect(update.request.headers.get('If-Match')).toBe('"3"');
    expect(update.request.body).toEqual({
      description: 'Novo texto',
      scheme: 'https',
      host: 'api.erp.example',
      port: 8443,
      pathPrefix: '/v1',
      internal: false,
      allowSecretsOverHttp: false,
      maxRequestBytes: null,
      maxResponseBytes: 2_097_152,
    });
    update.flush(...problem(412, 'version_mismatch'));
    await settle();
    expect(panel().getByText('Este destino foi alterado depois que você o abriu.')).toBeTruthy();

    await user.click(panel().getByRole('button', { name: 'Recarregar' }));
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/destinations/erp' }).flush({ ...ERP, description: 'Do outro', version: 4 }, { headers: { ETag: '"4"' } });
    await settle();
    expect((field(/^Descrição/) as HTMLTextAreaElement).value).toBe('Do outro');
  });

  it('asks before forcing a change that would break published versions, listing them (Q-AS3 (a))', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Editar o destino erp' }));
    backend.expectOne('/api/admin/automation/destinations/erp').flush(ERP, { headers: { ETag: '"3"' } });
    await settle();

    await user.clear(field(/^Host/));
    await user.type(field(/^Host/), 'api.novo.example');
    await user.click(panel().getByRole('button', { name: 'Salvar' }));
    backend.expectOne({ method: 'PUT', url: '/api/admin/automation/destinations/erp' }).flush(
      ...problem(409, 'destination_in_use', {
        automations: ['consulta_cpf'],
        versions: [{ automation: 'consulta_cpf', version: 2, errors: [{ code: 'AU106', message: 'The host is not allowed.', path: 'call.url' }] }],
      }),
    );
    await settle();
    const inUse = within(screen.getByRole('dialog', { name: 'O destino erp está em uso' }));
    expect(inUse.getByText(/versão 2/)).toBeTruthy();
    await user.click(inUse.getByRole('button', { name: 'Salvar mesmo assim' }));

    backend.expectOne({ method: 'PUT', url: '/api/admin/automation/destinations/erp?force=true' }).flush({ ...ERP, host: 'api.novo.example', version: 4 }, { headers: { ETag: '"4"' } });
    await settle();
    await reloadList();
    expect(toasts()).toContain('Destino salvo.');
  });

  it('retries a save whose answer was lost, and says what it could not confirm (§8.1)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Editar o destino erp' }));
    backend.expectOne('/api/admin/automation/destinations/erp').flush(ERP, { headers: { ETag: '"3"' } });
    await settle();
    await user.click(panel().getByRole('button', { name: 'Salvar' }));
    backend.expectOne({ method: 'PUT', url: '/api/admin/automation/destinations/erp' }).error(new ProgressEvent('error'), { status: 0 });
    await settle();

    await user.click(panel().getByRole('button', { name: 'Tentar de novo' }));
    const retry: TestRequest = backend.expectOne({ method: 'PUT', url: '/api/admin/automation/destinations/erp' });
    expect(retry.request.headers.get('If-Match')).toBe('"3"');
    retry.flush(...problem(412, 'version_mismatch'));
    await settle();
    await reloadList();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.')).toBeTruthy();
  });

  it('deletes an unused destination after asking once (§3.3)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Excluir o destino interno' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Excluir o destino interno?' })).getByRole('button', { name: 'Excluir' }));

    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/destinations/interno' }).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await reloadList([ERP]);
    expect(toasts()).toContain('Destino excluído.');
  });

  it('shows what uses a destination, and deletes it only when forced', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Excluir o destino erp' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Excluir o destino erp?' })).getByRole('button', { name: 'Excluir' }));
    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/destinations/erp' }).flush(...problem(409, 'destination_in_use', { secrets: ['erp_key'], automations: ['consulta_cpf'] }));
    await settle();

    const inUse = within(screen.getByRole('dialog', { name: 'O destino erp está em uso' }));
    expect(inUse.getByText('erp_key')).toBeTruthy();
    expect(inUse.getByText('consulta_cpf')).toBeTruthy();
    expect(inUse.getByText('Rascunhos não contam.')).toBeTruthy();
    expect(document.activeElement?.textContent?.trim()).toBe('Cancelar');
    await user.click(inUse.getByRole('button', { name: 'Excluir mesmo assim' }));

    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/destinations/erp?force=true' }).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await reloadList([INTERNO]);
  });

  it('says when a destination was already deleted', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Excluir o destino erp' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Excluir o destino erp?' })).getByRole('button', { name: 'Excluir' }));
    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/destinations/erp' }).flush(...problem(404, 'not_found'));
    await settle();
    await reloadList([INTERNO]);

    expect(screen.getByText('Este destino já foi excluído.')).toBeTruthy();
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe, with the list and with the panel open', async () => {
      const user = await open();
      await expectNoAxeViolations();

      await user.click(screen.getByRole('button', { name: 'Novo destino' }));
      await expectNoAxeViolations();
    });
  });
});
