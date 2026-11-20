import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { BotsPage } from './bots-page';

const BOT = { ownerId: null, createdAt: '2026-10-01T12:00:00Z', version: 1, tokens: [], groups: [] };
const ERP = { ...BOT, id: 'b-erp', name: 'erp-sync', displayName: 'Sincronizador do ERP', isActive: true, mcpEnabled: true, mcpCallsPerMinute: null, activeTokenCount: 2 };
const OCR = { ...BOT, id: 'b-ocr', name: 'ocr', displayName: 'Leitor', isActive: false, mcpEnabled: false, mcpCallsPerMinute: 30, activeTokenCount: 0 };
const NAME_TEXT = 'Use de 3 a 64 caracteres: letras minúsculas, dígitos, ponto, hífen ou sublinhado.';
const problem = (status: number, code: string) => [{ type: 'about:blank', title: code, status, code }, { status, statusText: code }] as const;

describe('BotsPage (admin-ui.md §6.1, A4)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);
  const dialog = (name: string) => within(screen.getByRole('dialog', { name }));

  async function open(bots: object[] = [ERP, OCR]) {
    await render(BotsPage, {
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideJsdomInteractivity()],
    });
    backend = TestBed.inject(HttpTestingController);
    await answer(bots);
    return userEvent.setup();
  }
  async function answer(bots: object[]) {
    backend.expectOne({ method: 'GET', url: '/api/admin/bots' }).flush(bots);
    await settle();
  }

  afterEach(() => backend.verify());

  it('lists the bots in a table: the name links to the bot, then the identifier, state, MCP and active tokens', async () => {
    await open();

    const table = screen.getByRole('table', { name: 'Bots' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual(['Nome', 'Identificador', 'Situação', 'MCP', 'Tokens']);
    const [, erp, ocr] = within(table).getAllByRole('row');
    expect(within(erp).getByRole('link', { name: 'Sincronizador do ERP' }).getAttribute('href')).toBe('/administracao/bots/b-erp');
    expect(within(erp).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual(['erp-sync', 'Ativo', 'Ligado', '2']);
    expect(within(ocr).getAllByRole('cell').map((cell) => cell.textContent?.trim())).toEqual(['ocr', 'Inativo', 'Desligado', '0']);
  });

  it('says when there is no bot yet', async () => {
    await open([]);

    expect(screen.getByText('Nenhum bot ainda. Crie o primeiro com “Novo bot”.')).toBeTruthy();
  });

  it('creates a bot, checking the identifier as typed, and lists it', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo bot' }));
    const form = dialog('Novo bot');
    const name = form.getByRole('textbox', { name: /^Identificador/ });

    await user.type(name, 'ERP');
    expect(form.getByText(NAME_TEXT)).toBeTruthy();
    await user.clear(name);
    await user.type(name, 'crm-sync');
    await user.type(form.getByRole('textbox', { name: /^Nome/ }), 'Sincronizador do CRM');
    await user.click(form.getByRole('button', { name: 'Criar' }));

    const request = backend.expectOne({ method: 'POST', url: '/api/admin/bots' });
    expect(request.request.body).toEqual({ name: 'crm-sync', displayName: 'Sincronizador do CRM' });
    request.flush({ ...ERP, id: 'b-crm', name: 'crm-sync', displayName: 'Sincronizador do CRM', activeTokenCount: 0 }, { status: 201, statusText: 'Created' });
    await settle();
    await answer([ERP, OCR]);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toasts()).toContain('Bot criado.');
  });

  it("shows the server's answer at its field: an identifier already used by a user or a bot", async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo bot' }));
    const form = dialog('Novo bot');
    await user.type(form.getByRole('textbox', { name: /^Identificador/ }), 'ana.souza');
    await user.type(form.getByRole('textbox', { name: /^Nome/ }), 'Ana');
    await user.click(form.getByRole('button', { name: 'Criar' }));

    backend.expectOne({ method: 'POST', url: '/api/admin/bots' }).flush(...problem(409, 'username_taken'));
    await settle();

    expect(form.getByText('Este identificador já está em uso.')).toBeTruthy();
  });

  it('after a lost answer, Tentar de novo sends it again; an identifier then in use may be the first attempt', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Novo bot' }));
    const form = dialog('Novo bot');
    await user.type(form.getByRole('textbox', { name: /^Identificador/ }), 'crm-sync');
    await user.type(form.getByRole('textbox', { name: /^Nome/ }), 'CRM');
    await user.click(form.getByRole('button', { name: 'Criar' }));
    backend.expectOne({ method: 'POST', url: '/api/admin/bots' }).error(new ProgressEvent('error'));
    await settle();

    await user.click(form.getByRole('button', { name: 'Tentar de novo' }));
    backend.expectOne({ method: 'POST', url: '/api/admin/bots' }).flush(...problem(409, 'username_taken'));
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Não foi possível confirmar a tentativa anterior. Se ela criou o bot, ele já está na lista.')).toBeTruthy();
    await answer([ERP, OCR]);
  });

  it.each(THEMES)('passes axe in the %s theme, with the list and the new bot dialog', async (theme) => {
    applyTheme(theme);
    const user = await open();
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: 'Novo bot' }));
    await user.click(dialog('Novo bot').getByRole('button', { name: 'Criar' }));
    await expectNoAxeViolations();
  });
});
