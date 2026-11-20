import { DATE_PIPE_DEFAULT_OPTIONS } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { BotPage } from './bot-page';

const ACTIVE = { id: 't-1', label: 'produção', prefix: 'a1b2c3d4', createdAt: '2026-10-01T12:00:00Z', lastUsedAt: '2026-10-18T13:00:00Z', revokedAt: null };
const REVOKED = { id: 't-0', label: 'antigo', prefix: 'ffee0011', createdAt: '2026-09-01T12:00:00Z', lastUsedAt: null, revokedAt: '2026-09-30T12:00:00Z' };
const ERP = {
  id: 'b-erp',
  name: 'erp-sync',
  displayName: 'Sincronizador do ERP',
  isActive: true,
  mcpEnabled: false,
  mcpCallsPerMinute: null,
  ownerId: null,
  createdAt: '2026-10-01T12:00:00Z',
  version: 3,
  activeTokenCount: 1,
  tokens: [REVOKED, ACTIVE],
  groups: [{ id: 'g-1', name: 'Integrações' }],
};
const SECRET = 'chn_9f8e7d6c_valor-do-token-uma-vez';
const RATE_TEXT = 'Use um número de 1 a 600, ou o padrão do servidor.';
const NO_CONTENT = { status: 204, statusText: 'No Content' };
const problem = (status: number, code: string) => [{ type: 'about:blank', title: code, status, code }, { status, statusText: code }] as const;

@Component({ template: '' })
class Elsewhere {}

describe('BotPage (admin-ui.md §6.2, A4)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);
  const dialog = (name: string) => within(screen.getByRole('dialog', { name }));
  const mcp = () => screen.getByRole('checkbox', { name: 'Pode ser usado por agentes de IA pelo MCP' }) as HTMLInputElement;

  async function open(body: object = ERP, status = 200) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'administracao/bots/:id', component: BotPage },
            { path: '**', component: Elsewhere },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
        { provide: DATE_PIPE_DEFAULT_OPTIONS, useValue: { timezone: '-0300' } }, // as app.config.ts sets it
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/administracao/bots/b-erp');
    await read('b-erp', body, status);
    return userEvent.setup();
  }
  async function read(id: string, body: object, status = 200) {
    const request = backend.expectOne({ method: 'GET', url: `/api/admin/bots/${id}` });
    if (status >= 400) {
      request.flush(body, { status, statusText: 'Erro' });
    } else {
      request.flush(body, { headers: { ETag: `"${(body as { version: number }).version}"` } });
    }
    await settle();
  }
  async function done(url: string) {
    backend.expectOne({ method: 'POST', url }).flush(null, NO_CONTENT);
    await settle();
  }

  afterEach(() => backend.verify());

  it('shows the bot: name, identifier, state, groups, MCP, and the tokens with their dates', async () => {
    await open();

    expect(screen.getByRole('heading', { level: 1, name: 'Sincronizador do ERP' })).toBeTruthy();
    expect(screen.getByText('erp-sync').tagName).toBe('CODE');
    expect(screen.getByText('Ativo')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Integrações' }).getAttribute('href')).toBe('/administracao/grupos/g-1');
    expect(mcp().checked).toBe(false);
    expect(screen.getByText('Os tokens deste bot passam a funcionar em /mcp. Na API comum eles funcionam sempre.')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Padrão do servidor' }) as HTMLInputElement).checked).toBe(true);

    const table = screen.getByRole('table', { name: 'Tokens' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Rótulo',
      'Prefixo',
      'Criado em',
      'Último uso',
      'Revogado em',
      'Ações',
    ]);
    const [, antigo, producao] = within(table).getAllByRole('row');
    expect(within(producao).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual([
      'chn_a1b2c3d4_…',
      '01/10/2026 09:00',
      '18/10/2026 10:00',
      '',
      'Revogar',
    ]);
    expect(within(antigo).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual(['chn_ffee0011_…', '01/09/2026 09:00', '', '30/09/2026 09:00', '']);
    expect(screen.getByText('1 token ativo de 5.')).toBeTruthy();
  });

  it('renames the bot with If-Match', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Editar nome' }));
    const form = dialog('Editar Sincronizador do ERP');
    expect(form.queryByRole('textbox', { name: /^Identificador/ })).toBeNull();
    const name = form.getByRole('textbox', { name: /^Nome/ });
    await user.clear(name);
    await user.type(name, 'ERP');
    await user.click(form.getByRole('button', { name: 'Salvar' }));

    const call = backend.expectOne({ method: 'PATCH', url: '/api/admin/bots/b-erp' });
    expect([call.request.headers.get('If-Match'), call.request.body]).toEqual(['"3"', { displayName: 'ERP' }]);
    call.flush({ ...ERP, displayName: 'ERP', version: 4 }, { headers: { ETag: '"4"' } });
    await settle();

    expect(screen.getByRole('heading', { level: 1, name: 'ERP' })).toBeTruthy();
    expect(toasts()).toContain('Bot salvo.');
  });

  it('deactivates after asking, and Ativar brings it back', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    expect(dialog('Desativar Sincronizador do ERP?').getByText('Os tokens deste bot param de funcionar, na API e no MCP, até ele ser ativado de novo.')).toBeTruthy();
    await user.click(dialog('Desativar Sincronizador do ERP?').getByRole('button', { name: 'Desativar' }));
    await done('/api/admin/bots/b-erp/deactivate');
    await read('b-erp', { ...ERP, isActive: false, version: 4 });
    expect(screen.getByText('Inativo')).toBeTruthy();
    expect(toasts()).toContain('Bot desativado.');

    await user.click(screen.getByRole('button', { name: 'Ativar' }));
    await user.click(dialog('Ativar Sincronizador do ERP?').getByRole('button', { name: 'Ativar' }));
    await done('/api/admin/bots/b-erp/activate');
    await read('b-erp', { ...ERP, version: 5 });
    expect(toasts()).toContain('Bot ativado.');
  });

  it('switches MCP at once, and puts the box back on a refusal', async () => {
    const user = await open();

    await user.click(mcp());
    await done('/api/admin/bots/b-erp/mcp/enable');
    await read('b-erp', { ...ERP, mcpEnabled: true, version: 4 });
    expect(mcp().checked).toBe(true);
    expect(toasts()).toContain('MCP ligado.');

    await user.click(mcp());
    backend.expectOne({ method: 'POST', url: '/api/admin/bots/b-erp/mcp/disable' }).flush(...problem(403, 'forbidden'));
    await settle();
    expect(mcp().checked).toBe(true);
    expect(screen.getByText('Você não tem permissão para fazer isso.')).toBeTruthy();
  });

  it("sets the bot's own rate, checking it first, and goes back to the server's default", async () => {
    const user = await open();
    await user.click(screen.getByRole('radio', { name: 'Limite próprio' }));
    const rate = screen.getByRole('spinbutton', { name: 'Chamadas por minuto' });
    await user.type(rate, '601');
    await user.click(screen.getByRole('button', { name: 'Salvar limite' }));
    expect(screen.getByText(RATE_TEXT)).toBeTruthy();
    backend.expectNone({ method: 'PUT', url: '/api/admin/bots/b-erp/mcp/rate' });

    await user.clear(rate);
    await user.type(rate, '120');
    await user.click(screen.getByRole('button', { name: 'Salvar limite' }));
    const own = backend.expectOne({ method: 'PUT', url: '/api/admin/bots/b-erp/mcp/rate' });
    expect(own.request.body).toEqual({ callsPerMinute: 120 });
    own.flush({ ...ERP, mcpCallsPerMinute: 120, version: 4 });
    await settle();
    await read('b-erp', { ...ERP, mcpCallsPerMinute: 120, version: 4 });
    expect(toasts()).toContain('Limite salvo.');
    expect((screen.getByRole('spinbutton', { name: 'Chamadas por minuto' }) as HTMLInputElement).value).toBe('120');

    await user.click(screen.getByRole('radio', { name: 'Padrão do servidor' }));
    await user.click(screen.getByRole('button', { name: 'Salvar limite' }));
    const back = backend.expectOne({ method: 'PUT', url: '/api/admin/bots/b-erp/mcp/rate' });
    expect(back.request.body).toEqual({ callsPerMinute: null });
    back.flush({ ...ERP, version: 5 });
    await settle();
    await read('b-erp', { ...ERP, version: 5 });
  });

  it('makes a token and shows its value once (§4.3)', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo token' }));
    const form = dialog('Novo token');
    await user.click(form.getByRole('button', { name: 'Criar' }));
    expect(form.getByText('Use um rótulo de 1 a 100 caracteres.')).toBeTruthy();
    await user.type(form.getByRole('textbox', { name: /^Rótulo/ }), ' homologação ');
    await user.click(form.getByRole('button', { name: 'Criar' }));

    const call = backend.expectOne({ method: 'POST', url: '/api/admin/bots/b-erp/tokens' });
    expect(call.request.body).toEqual({ label: 'homologação' });
    call.flush({ token: { ...ACTIVE, id: 't-2', label: 'homologação' }, value: SECRET }, { status: 201, statusText: 'Created' });
    await settle();
    await read('b-erp', { ...ERP, activeTokenCount: 2, tokens: [REVOKED, ACTIVE, { ...ACTIVE, id: 't-2', label: 'homologação' }], version: 4 });

    const shown = dialog('Token homologação de erp-sync');
    expect((shown.getByRole('textbox', { name: 'Token' }) as HTMLInputElement).value).toBe(SECRET);
    expect(shown.getByText('Este token aparece só agora. Guarde-o no cofre da integração.')).toBeTruthy();
    await user.click(shown.getByRole('button', { name: 'Concluir' }));

    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(screen.getByText('2 tokens ativos de 5.')).toBeTruthy();
  });

  it('does not retry a token whose answer was lost: it reads the bot again and says what to do', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo token' }));
    await user.type(dialog('Novo token').getByRole('textbox', { name: /^Rótulo/ }), 'homologação');
    await user.click(dialog('Novo token').getByRole('button', { name: 'Criar' }));

    backend.expectOne({ method: 'POST', url: '/api/admin/bots/b-erp/tokens' }).error(new ProgressEvent('error'));
    await settle();
    await read('b-erp', ERP);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByText('Não foi possível confirmar se o token foi criado. Se ele aparece abaixo, o valor se perdeu: revogue-o e crie outro.'),
    ).toBeTruthy();
  });

  it('says why the sixth active token is refused', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo token' }));
    const form = dialog('Novo token');
    await user.type(form.getByRole('textbox', { name: /^Rótulo/ }), 'sexto');
    await user.click(form.getByRole('button', { name: 'Criar' }));

    backend.expectOne({ method: 'POST', url: '/api/admin/bots/b-erp/tokens' }).flush(...problem(409, 'token_limit_reached'));
    await settle();

    expect(form.getByText('Um bot pode ter até 5 tokens ativos. Revogue um antes.')).toBeTruthy();
  });

  it('revokes a token after asking', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Revogar o token produção' }));
    const asked = dialog('Revogar o token produção?');
    expect(asked.getByText('As integrações que usam este token param de funcionar na hora.')).toBeTruthy();
    await user.click(asked.getByRole('button', { name: 'Revogar' }));

    await done('/api/admin/bots/b-erp/tokens/t-1/revoke');
    await read('b-erp', { ...ERP, activeTokenCount: 0, tokens: [REVOKED, { ...ACTIVE, revokedAt: '2026-10-19T12:00:00Z' }], version: 4 });

    expect(toasts()).toContain('Token revogado.');
    expect(screen.queryByRole('button', { name: 'Revogar o token produção' })).toBeNull();
    expect(screen.getByText('Nenhum token ativo.')).toBeTruthy();
  });

  it('says when the bot does not exist, with the way back', async () => {
    await open(problem(404, 'not_found')[0], 404);

    expect(screen.getByText('Este bot não existe.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para Bots' }).getAttribute('href')).toBe('/administracao/bots');
  });

  it('starts afresh when the router keeps the page for another bot', async () => {
    const user = await open();
    await user.click(mcp());
    backend.expectOne({ method: 'POST', url: '/api/admin/bots/b-erp/mcp/enable' }).flush(...problem(403, 'forbidden'));
    await settle();

    await TestBed.inject(Router).navigateByUrl('/administracao/bots/b-ocr');
    await settle();
    await read('b-ocr', { ...ERP, id: 'b-ocr', displayName: 'Leitor', tokens: [], groups: [], activeTokenCount: 0 });

    expect(screen.getByRole('heading', { level: 1, name: 'Leitor' })).toBeTruthy();
    expect(screen.queryByText('Você não tem permissão para fazer isso.')).toBeNull();
    expect(screen.getByText('Nenhum token ainda.')).toBeTruthy();
  });

  it.each(THEMES)('passes axe in the %s theme', async (theme) => {
    applyTheme(theme);
    const user = await open({ ...ERP, mcpEnabled: true, mcpCallsPerMinute: 120 });
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: 'Novo token' }));
    await expectNoAxeViolations();
  });
});
