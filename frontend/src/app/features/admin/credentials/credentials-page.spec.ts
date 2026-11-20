import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { CredentialsPage } from './credentials-page';

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
const SOLTA = { ...KEY, name: 'solta', description: null, allowedDestinations: [], version: 1, rotatedAt: null };
const ERP = {
  name: 'erp',
  description: null,
  scheme: 'https',
  host: 'api.erp.example',
  port: null,
  pathPrefix: null,
  internal: false,
  allowSecretsOverHttp: false,
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 1_048_576,
  createdAt: 'x',
  updatedAt: 'x',
  version: 1,
};
const CANARY = 'canario-7f3a-segredo';
const problem = (status: number, code: string, extra: object = {}) => [{ type: 'about:blank', title: code, status, code, ...extra }, { status, statusText: code }] as const;

describe('CredentialsPage (automation-ui.md §4, AS2)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);

  async function open(secrets: unknown[] = [KEY, SOLTA]) {
    await render(CredentialsPage, {
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideJsdomInteractivity()],
    });
    backend = TestBed.inject(HttpTestingController);
    await reload(secrets);
    return userEvent.setup();
  }
  const reload = async (secrets: unknown[] = [KEY, SOLTA]) => {
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/secrets' }).flush(secrets);
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/destinations' }).flush([ERP]);
    await settle();
  };
  const dialog = () => within(screen.getByRole('dialog'));

  afterEach(() => backend.verify());

  it('lists metadata only: the destinations, the value version and the key (§4.1)', async () => {
    await open();

    const [key, solta] = screen.getAllByRole('listitem');
    expect(within(key).getByText('Destinos permitidos: erp')).toBeTruthy();
    expect(within(key).getByText(/Valor: versão 3, trocado em/)).toBeTruthy();
    expect(within(key).getByText('Chave de criptografia: kek-2026')).toBeTruthy();
    expect(within(solta).getByText('Nenhum destino: ainda não pode ser usada.')).toBeTruthy();
    expect(within(solta).getByText(/Valor: versão 1, definido em/)).toBeTruthy();
  });

  it('creates a credential, sending its value once, with the warnings that do not block, and clears it (§4.2, §4.6)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Nova credencial' }));
    await user.type(dialog().getByRole('textbox', { name: /^Nome/ }), 'nova_chave');
    await user.click(dialog().getByRole('checkbox', { name: /erp/ }));
    const value = dialog().getByLabelText(/^Valor/) as HTMLInputElement;
    expect([value.type, value.autocomplete, value.getAttribute('spellcheck'), value.getAttribute('autocapitalize')]).toEqual(['password', 'off', 'false', 'off']);
    expect(dialog().getByRole('button', { name: 'Mostrar valor' })).toBeTruthy();

    await user.type(value, ` ${CANARY}ção`);
    expect(dialog().getByText('O valor começa ou termina com espaço. Ele será enviado assim.')).toBeTruthy();
    expect(dialog().getByText(/Este valor tem caracteres que um cabeçalho HTTP não aceita/)).toBeTruthy();
    await user.click(dialog().getByRole('button', { name: 'Salvar' }));

    const create = backend.expectOne({ method: 'POST', url: '/api/admin/automation/secrets' });
    expect(create.request.body).toEqual({ name: 'nova_chave', description: null, value: ` ${CANARY}ção`, allowedDestinations: ['erp'] });
    expect(value.value).toBe(` ${CANARY}ção`); // kept until the answer
    create.flush({ ...KEY, name: 'nova_chave', version: 1, rotatedAt: null }, { status: 201, statusText: 'Created', headers: { ETag: '"1"' } });
    await settle();
    await reload([KEY, SOLTA, { ...KEY, name: 'nova_chave', version: 1, rotatedAt: null }]);

    expect(toasts()).toContain('Credencial criada.');
    expect(value.value).toBe('');
    expect(document.body.innerHTML).not.toContain(CANARY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CANARY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CANARY);
  });

  it('keeps the value after a failure, says why without a KEK (503), and the name taken at its field', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Nova credencial' }));
    await user.type(dialog().getByRole('textbox', { name: /^Nome/ }), 'erp_key');
    await user.type(dialog().getByLabelText(/^Valor/), CANARY);

    await user.click(dialog().getByRole('button', { name: 'Salvar' }));
    backend.expectOne({ method: 'POST', url: '/api/admin/automation/secrets' }).flush(...problem(503, 'secrets_unavailable'));
    await settle();
    expect(dialog().getByText(/O servidor não tem uma chave de criptografia ativa/)).toBeTruthy();
    expect((dialog().getByLabelText(/^Valor/) as HTMLInputElement).value).toBe(CANARY);
    expect(screen.getByRole('dialog').textContent).not.toContain(CANARY);

    await user.click(dialog().getByRole('button', { name: 'Salvar' }));
    backend.expectOne({ method: 'POST', url: '/api/admin/automation/secrets' }).flush(...problem(409, 'secret_name_taken'));
    await settle();
    expect(dialog().getByText('Já existe uma credencial com este nome.')).toBeTruthy();
  });

  it('edits the description and destinations with PATCH and If-Match, never a value, and warns when a destination is removed (§4.3)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Editar a credencial erp_key' }));
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/secrets/erp_key' }).flush(KEY, { headers: { ETag: '"7"' } });
    await settle();
    expect(dialog().queryByLabelText(/^Valor/)).toBeNull();

    await user.click(dialog().getByRole('checkbox', { name: /erp/ }));
    expect(dialog().getByText('Automações publicadas que usam esta credencial com esse destino falham na próxima chamada.')).toBeTruthy();
    await user.click(dialog().getByRole('button', { name: 'Salvar' }));
    const patch = backend.expectOne({ method: 'PATCH', url: '/api/admin/automation/secrets/erp_key' });
    expect(patch.request.headers.get('If-Match')).toBe('"7"');
    expect(patch.request.body).toEqual({ description: 'Token do ERP', allowedDestinations: [] });

    patch.flush(
      ...problem(409, 'secret_in_use', {
        automations: ['consulta_cpf'],
        versions: [{ automation: 'consulta_cpf', version: 2, errors: [{ code: 'AU103', message: 'Not allowed.', path: 'call.auth' }] }],
      }),
    );
    await settle();
    await user.click(within(screen.getByRole('dialog', { name: 'A credencial erp_key está em uso' })).getByRole('button', { name: 'Salvar mesmo assim' }));
    backend.expectOne({ method: 'PATCH', url: '/api/admin/automation/secrets/erp_key?force=true' }).flush({ ...KEY, allowedDestinations: [] }, { headers: { ETag: '"8"' } });
    await settle();
    await reload();
    expect(toasts()).toContain('Credencial salva.');
  });

  it('changes the value, which raises the version shown (§4.4)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Trocar o valor de erp_key' }));
    backend.expectOne({ method: 'GET', url: '/api/admin/automation/secrets/erp_key' }).flush(KEY, { headers: { ETag: '"7"' } });
    await settle();

    await user.type(dialog().getByLabelText(/^Novo valor/), 'novo-valor');
    await user.click(dialog().getByRole('button', { name: 'Trocar' }));
    const put = backend.expectOne({ method: 'PUT', url: '/api/admin/automation/secrets/erp_key/value' });
    expect(put.request.headers.get('If-Match')).toBe('"7"');
    expect(put.request.body).toEqual({ value: 'novo-valor' });
    put.flush({ ...KEY, version: 4 }, { headers: { ETag: '"8"' } });
    await settle();
    await reload([{ ...KEY, version: 4 }, SOLTA]);

    expect(toasts()).toContain('Valor trocado. Versão 4.');
    expect(screen.getByText(/Valor: versão 4/)).toBeTruthy();
  });

  it('deletes one in use only when forced, listing the automations (§4.5)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Excluir a credencial erp_key' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Excluir a credencial erp_key?' })).getByRole('button', { name: 'Excluir' }));
    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/secrets/erp_key' }).flush(...problem(409, 'secret_in_use', { automations: ['consulta_cpf'] }));
    await settle();

    const inUse = within(screen.getByRole('dialog', { name: 'A credencial erp_key está em uso' }));
    expect(inUse.getByText('consulta_cpf')).toBeTruthy();
    await user.click(inUse.getByRole('button', { name: 'Excluir mesmo assim' }));
    backend.expectOne({ method: 'DELETE', url: '/api/admin/automation/secrets/erp_key?force=true' }).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await reload([SOLTA]);
    expect(toasts()).toContain('Credencial excluída.');
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe, with the list and the new-credential panel', async () => {
      const user = await open();
      await expectNoAxeViolations();

      await user.click(screen.getByRole('button', { name: 'Nova credencial' }));
      await expectNoAxeViolations();
    });
  });
});
