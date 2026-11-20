import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { PermissionsPanel, PermissionsPanelData, PermissionsResult } from './permissions-panel';

const GROUPS = [
  { id: 'g-cad', name: 'Cadastro' },
  { id: 'g-cred', name: 'Crédito' },
  { id: 'g-dir', name: 'Diretoria' },
];
const GRANTS = [
  { groupId: 'g-cred', groupName: 'Crédito', capabilities: ['start', 'view'] },
  { groupId: 'g-old', groupName: 'Antigo', capabilities: ['view'] },
];
const WARNING = 'Se um bot deste grupo for usado por um agente de IA, os valores sensíveis irão para o provedor do agente.';
const problem = (status: number, code: string) => [{ type: 'about:blank', title: code, status, code }, { status, statusText: code }] as const;

describe('PermissionsPanel (admin-ui.md §7, A3)', () => {
  let backend: HttpTestingController;
  let closed: PermissionsResult | undefined | null;
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const panel = () => within(screen.getByRole('dialog', { name: 'Permissões' }));
  const box = (capability: string, group: string) => panel().getByRole('checkbox', { name: `${capability} — ${group}` }) as HTMLInputElement;

  async function open(grants: object[] = GRANTS) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideJsdomInteractivity()],
    });
    backend = TestBed.inject(HttpTestingController);
    closed = null;
    const user = userEvent.setup();
    TestBed.inject(DialogService)
      .open<PermissionsResult, PermissionsPanelData>(PermissionsPanel, { data: { processId: 'w-1', etag: '"7"' }, size: 'side' })
      .closed.subscribe((result) => (closed = result));
    TestBed.tick();
    backend.expectOne({ method: 'GET', url: '/api/workflows/w-1/grants' }).flush(grants);
    backend.expectOne({ method: 'GET', url: '/api/workflows/groups' }).flush(GROUPS);
    await settle();
    return user;
  }

  afterEach(() => backend.verify());

  it('shows one row per group with a box per capability, and says what lane groups need', async () => {
    await open();

    const table = panel().getByRole('table', { name: 'Permissões por grupo' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Grupo',
      'Iniciar',
      'Ver',
      'Encerrar',
      'Comentar',
      'Ver dados sensíveis',
      'Ações',
    ]);
    expect([box('Iniciar', 'Crédito').checked, box('Ver', 'Crédito').checked, box('Encerrar', 'Crédito').checked]).toEqual([true, true, false]);
    expect(panel().getByText('Os grupos das áreas não precisam de permissão para executar as tarefas da própria área.')).toBeTruthy();
    expect(within(panel().getAllByRole('row')[2]).getByText('Arquivado ou removido')).toBeTruthy(); // not among the active groups
    expect(panel().queryByText(WARNING, { exact: false })).toBeNull();
  });

  it("applies the whole list with If-Match, drops rows without a capability, and closes with the process's new ETag", async () => {
    const user = await open();
    await user.click(box('Encerrar', 'Crédito'));
    await user.click(panel().getByRole('button', { name: 'Remover Antigo das permissões' }));
    await user.selectOptions(panel().getByRole('combobox', { name: 'Grupo a adicionar' }), 'Diretoria');
    await user.click(panel().getByRole('button', { name: 'Adicionar grupo' }));
    await user.click(box('Ver', 'Diretoria'));
    await user.selectOptions(panel().getByRole('combobox', { name: 'Grupo a adicionar' }), 'Cadastro');
    await user.click(panel().getByRole('button', { name: 'Adicionar grupo' }));
    await user.click(panel().getByRole('button', { name: 'Aplicar' }));

    const call = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/grants' });
    expect(call.request.headers.get('If-Match')).toBe('"7"');
    expect(call.request.body).toEqual([
      { groupId: 'g-cred', capabilities: ['start', 'view', 'close'] },
      { groupId: 'g-dir', capabilities: ['view'] },
    ]);
    call.flush([], { headers: { ETag: '"8"' } });
    await settle();

    expect(closed).toEqual({ etag: '"8"' });
  });

  it('offers only the active groups not listed yet', async () => {
    await open();

    const options = within(panel().getByRole('combobox', { name: 'Grupo a adicionar' })).getAllByRole('option');
    expect(options.map((option) => option.textContent?.trim())).toEqual(['Cadastro', 'Diretoria']);
  });

  it('warns when Ver dados sensíveis is checked, naming the group (sensitive-data.md §3; Q-AD4)', async () => {
    const user = await open();

    await user.click(box('Ver dados sensíveis', 'Crédito'));

    expect(panel().getByText(WARNING, { exact: false }).textContent).toContain(`Crédito: ${WARNING}`);
    await user.click(box('Ver dados sensíveis', 'Crédito'));
    expect(panel().queryByText(WARNING, { exact: false })).toBeNull();
  });

  it('says why the server refused an archived or removed group', async () => {
    const user = await open();
    await user.click(panel().getByRole('button', { name: 'Aplicar' }));

    backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/grants' }).flush(...problem(422, 'invalid_grants'));
    await settle();

    expect(panel().getByText('Um dos grupos foi arquivado ou removido. Remova-o e aplique de novo.')).toBeTruthy();
    expect(closed).toBeNull();
  });

  it('after a lost answer, Tentar de novo sends the same list; a 412 then may be the first attempt', async () => {
    const user = await open();
    await user.click(panel().getByRole('button', { name: 'Aplicar' }));
    backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/grants' }).error(new ProgressEvent('error'));
    await settle();
    expect(panel().getByText('Não foi possível confirmar a aplicação.')).toBeTruthy();

    await user.click(panel().getByRole('button', { name: 'Tentar de novo' }));
    const again = backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/grants' });
    expect(again.request.headers.get('If-Match')).toBe('"7"');
    again.flush(...problem(412, 'version_mismatch'));
    await settle();

    expect(closed).toEqual({ uncertain: 'Não foi possível confirmar se as permissões foram aplicadas. Abra Permissões de novo para conferir.' });
  });

  it('says that the process changed when the ETag is stale', async () => {
    const user = await open();
    await user.click(panel().getByRole('button', { name: 'Aplicar' }));

    backend.expectOne({ method: 'PUT', url: '/api/workflows/w-1/grants' }).flush(...problem(412, 'version_mismatch'));
    await settle();

    expect(panel().getByText('Este item mudou desde que você o abriu. Carregue a página de novo.')).toBeTruthy();
  });

  it.each(THEMES)('passes axe in the %s theme, with the warning shown', async (theme) => {
    applyTheme(theme);
    const user = await open();
    await user.click(box('Ver dados sensíveis', 'Crédito'));

    await expectNoAxeViolations(screen.getByRole('dialog'));
  });
});
