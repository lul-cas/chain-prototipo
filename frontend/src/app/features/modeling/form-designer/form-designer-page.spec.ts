import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { ToastService } from '../../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { provideJsdomInteractivity } from '../../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { leaveWhenSaved } from '../can-leave';
import { FormDesignerPage } from './form-designer-page';

@Component({ template: '<h1>Formulários</h1>' })
class List {}

const DRAFT = {
  schemaVersion: 1,
  components: [
    { type: 'heading', text: 'Dados do cliente' },
    { type: 'text', key: 'cpf', label: 'CPF', placeholder: '000.000.000-00', sensitive: true, validate: { required: true } },
    { type: 'select', key: 'tipo', label: 'Tipo', options: [{ value: 'pf', label: 'Pessoa física' }, { value: 'pj', label: 'Pessoa jurídica' }] },
    {
      type: 'group', key: 'endereco', label: 'Endereço',
      visibleWhen: { kind: 'compare', left: { kind: 'path', path: ['tipo'] }, operator: 'equals', right: { kind: 'literal', type: 'text', value: 'pf' } },
      components: [{ type: 'text', key: 'cep', label: 'CEP' }],
    },
    { type: 'dynamicList', key: 'socios', label: 'Sócios', components: [] },
  ],
};

const FORM = { id: 'f-1', name: 'Proposta', description: 'Dados da proposta', latestVersion: null, draftUpdatedAt: '2026-10-19T12:00:00Z', version: 4, draft: DRAFT };
const VALID = { ...FORM, draft: { schemaVersion: 1, components: [{ type: 'text', key: 'nome', label: 'Nome', validate: { required: true } }] } };

describe('FormDesignerPage (form-designer.md §12.1, N3a)', () => {
  let backend: HttpTestingController;
  const settle = () => new Promise((resolve) => setTimeout(resolve));

  async function open(form: object = FORM, status = 200): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'formularios', component: List },
            { path: 'formularios/:id', component: FormDesignerPage, canDeactivate: [leaveWhenSaved] },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideJsdomInteractivity(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/formularios/f-1');
    const request = backend.expectOne({ method: 'GET', url: '/api/forms/f-1' });
    if (status === 200) {
      request.flush(form, { headers: { ETag: '"4"' } });
    } else {
      request.flush({ type: 'about:blank', title: 'Not found', status, code: 'not_found' }, { status, statusText: 'Not Found' });
    }
    await settle();
  }

  afterEach(() => backend.verify());

  it('draws the saved draft: labels, keys, badges, the condition, options and children', async () => {
    await open();

    expect(screen.getByRole('heading', { level: 1, name: 'Proposta' })).toBeTruthy();
    expect(screen.getByText('Dados da proposta')).toBeTruthy();
    const drawn = within(screen.getByRole('tree', { name: 'Formulário' }));
    expect(drawn.getByText('Dados do cliente')).toBeTruthy();
    expect(drawn.getByText('cpf')).toBeTruthy();
    expect(drawn.getByText('sensível')).toBeTruthy();
    expect(drawn.getByText('000.000.000-00')).toBeTruthy();
    expect(drawn.getByText('Pessoa jurídica')).toBeTruthy();
    expect(drawn.getByText('Mostra quando: data.tipo = "pf"')).toBeTruthy();
    expect(drawn.getByText('cep')).toBeTruthy();
    expect(drawn.getByText('Adicione componentes aqui')).toBeTruthy();
    expect(screen.getByText('Nunca publicado')).toBeTruthy();
  });

  it('says when the form does not exist', async () => {
    await open(FORM, 404);

    expect(screen.getByRole('heading', { name: 'Formulário não encontrado' })).toBeTruthy();
  });

  it('renames the form with If-Match, and offers to reload when it changed meanwhile (§9.1, ADR-0010 D4)', async () => {
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Editar nome e descrição' }));
    await user.clear(screen.getByRole('textbox', { name: /Nome/ }));
    await user.type(screen.getByRole('textbox', { name: /Nome/ }), 'Proposta PJ');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    const first = backend.expectOne({ method: 'PATCH', url: '/api/forms/f-1' });
    expect(first.request.headers.get('If-Match')).toBe('"4"');
    first.flush({ type: 'about:blank', title: 'Changed', status: 412, code: 'version_mismatch' }, { status: 412, statusText: 'Precondition Failed' });
    await settle();
    expect(screen.getByText('O formulário mudou desde que você o abriu.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    backend.expectOne({ method: 'GET', url: '/api/forms/f-1' }).flush({ ...FORM, version: 5 }, { headers: { ETag: '"5"' } });
    await settle();
    expect(screen.queryByText('O formulário mudou desde que você o abriu.')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Salvar' })); // what was typed is kept
    const second = backend.expectOne({ method: 'PATCH', url: '/api/forms/f-1' });
    expect(second.request.headers.get('If-Match')).toBe('"5"');
    expect(second.request.body).toEqual({ name: 'Proposta PJ', description: 'Dados da proposta' });
    second.flush({ ...FORM, name: 'Proposta PJ', version: 6 }, { headers: { ETag: '"6"' } });
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Proposta PJ' })).toBeTruthy();
    expect(TestBed.inject(ToastService).toasts().map((toast) => toast.message)).toContain('Formulário atualizado.');
  });

  it('outlines the components that fail a local check, and says so to screen readers (§9.2)', async () => {
    await open();

    const list = document.querySelector('[data-path="socios"]')!;
    expect(list.querySelector('.chain-draft-card')!.classList).toContain('chain-draft-card--problem'); // an empty list: FM004
    expect(list.getAttribute('aria-label')).toContain('com problema');
    expect(document.querySelector('[data-path="cpf"] > .chain-draft-card')!.classList).not.toContain('chain-draft-card--problem');
  });

  it('validates on the server, lists the problems in Portuguese, outlines their components and goes to one chosen', async () => {
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Validar' }));
    backend.expectOne({ method: 'POST', url: '/api/forms/f-1/validate' }).flush({
      valid: false,
      errors: [
        { code: 'FM005', message: 'Lookbehind is not supported.', path: 'cpf' },
        { code: 'FM006', message: 'Too many components.', path: null },
      ],
    });
    await settle();

    const cpf = document.querySelector<HTMLElement>('[data-path="cpf"]')!;
    expect(cpf.querySelector('.chain-draft-card')!.classList).toContain('chain-draft-card--problem'); // the regex subset is the server's check
    expect(screen.getByText(/O formulário passa de 200 componentes/).closest('button')).toBeNull(); // no component to go to
    await user.click(screen.getByRole('button', { name: /O padrão não pode ser usado.* FM005/ }));
    await settle();
    expect(document.activeElement).toBe(cpf);
    expect(cpf.getAttribute('aria-selected')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Validar' }));
    backend.expectOne({ method: 'POST', url: '/api/forms/f-1/validate' }).flush({ valid: true, errors: [] });
    await settle();
    expect(screen.getByText('Nenhum problema encontrado.')).toBeTruthy();
  });

  it('publishes: a new version, nothing new, or the problems', async () => {
    await open(VALID);
    const user = userEvent.setup();
    const toasts = () => TestBed.inject(ToastService).toasts().map((toast) => toast.message);

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    const publish = backend.expectOne({ method: 'POST', url: '/api/forms/f-1/publish' });
    expect(publish.request.headers.get('If-Match')).toBe('"4"');
    publish.flush({ versionNumber: 1, contentHash: 'sha256:x', created: true }, { status: 201, statusText: 'Created' });
    await settle();
    backend.expectOne({ method: 'GET', url: '/api/forms/f-1' }).flush({ ...VALID, latestVersion: 1, version: 5 }, { headers: { ETag: '"5"' } });
    await settle();
    expect(toasts()).toContain('Versão 1 publicada.');
    expect(screen.getByText('Versão publicada: 1')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    backend.expectOne({ method: 'POST', url: '/api/forms/f-1/publish' }).flush({ versionNumber: 1, contentHash: 'sha256:x', created: false });
    await settle();
    backend.expectOne({ method: 'GET', url: '/api/forms/f-1' }).flush({ ...VALID, latestVersion: 1, version: 5 }, { headers: { ETag: '"5"' } });
    await settle();
    expect(toasts()).toContain('Nada mudou desde a versão 1.');

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    backend
      .expectOne({ method: 'POST', url: '/api/forms/f-1/publish' })
      .flush(
        { type: 'about:blank', title: 'No', status: 422, code: 'form_validation_failed', errors: [{ code: 'FM002', message: 'Repeated.', path: 'nome' }] },
        { status: 422, statusText: 'Unprocessable' },
      );
    await settle();
    expect(screen.getByRole('button', { name: /Esta chave se repete no mesmo nível. FM002/ })).toBeTruthy();
  });

  it('previews a valid draft with the renderer, and shows what a valid fill would send', async () => {
    await open(VALID);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Pré-visualizar' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByRole('textbox', { name: /Nome/ }), 'Ana');
    await user.click(dialog.getByRole('button', { name: 'Validar preenchimento' }));

    expect(dialog.getByText('Enviaria:')).toBeTruthy();
    expect(dialog.getByLabelText('Dados enviados').textContent).toBe('{"nome":"Ana"}');
  });

  it('lists the local problems instead of previewing a draft that fails them', async () => {
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Pré-visualizar' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/Uma regra deste componente não combina com o tipo dele/)).toBeTruthy(); // the empty list: FM004
    expect(dialog.queryByRole('button', { name: 'Validar preenchimento' })).toBeNull();
  });

  it('shows the draft as JSON', async () => {
    await open(VALID);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Visualizar JSON' }));

    expect(JSON.parse(screen.getByTestId('draft-json').textContent ?? '')).toEqual(VALID.draft);
  });

  describe('editing (§12.2, N3b)', () => {
    const toolbar = () => within(screen.getByRole('toolbar', { name: 'Ações do formulário' }));
    const status = () => screen.getByRole('status', { name: 'Situação da edição' }).textContent?.trim();
    const confirmIn = async (user: ReturnType<typeof userEvent.setup>, label: string) =>
      user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: label }));

    it('adds from the palette: the new component is selected, focused and unsaved', async () => {
      await open(VALID);
      const user = userEvent.setup();
      expect(status()).toBe('Nenhum componente selecionado.');
      expect(toolbar().getByRole('button', { name: 'Salvar rascunho' }).hasAttribute('disabled')).toBe(true);

      await user.click(screen.getByRole('button', { name: 'Número' }));
      await settle();

      const added = screen.getByRole('treeitem', { name: 'Número, número, chave numero' });
      expect(added.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(added);
      expect(status()).toBe('Adicionado: Número.');
      expect(screen.getByText('Alterações não salvas')).toBeTruthy();
      expect(toolbar().getByRole('button', { name: 'Salvar rascunho' }).hasAttribute('disabled')).toBe(false);
    });

    it('saves the draft with If-Match and without the designer ids', async () => {
      await open(VALID);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Caixa de seleção' }));

      await user.click(toolbar().getByRole('button', { name: 'Salvar rascunho' }));
      const save = backend.expectOne({ method: 'PUT', url: '/api/forms/f-1/draft' });
      expect(save.request.headers.get('If-Match')).toBe('"4"');
      const sent = { schemaVersion: 1, components: [...VALID.draft.components, { type: 'checkbox', key: 'caixa_de_selecao', label: 'Caixa de seleção' }] };
      expect(save.request.body).toEqual({ document: sent });
      save.flush({ ...VALID, version: 5, draft: sent, draftUpdatedAt: '2026-10-19T13:00:00Z' }, { headers: { ETag: '"5"' } });
      await settle();

      expect(TestBed.inject(ToastService).toasts().map((toast) => toast.message)).toContain('Rascunho salvo.');
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });

    it('saves unsaved changes before validating and publishing (§9.1)', async () => {
      await open(VALID);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Título' }));

      await user.click(toolbar().getByRole('button', { name: 'Validar' }));
      backend.expectOne({ method: 'PUT', url: '/api/forms/f-1/draft' }).flush({ ...VALID, version: 5 }, { headers: { ETag: '"5"' } });
      await settle();
      backend.expectOne({ method: 'POST', url: '/api/forms/f-1/validate' }).flush({ valid: true, errors: [] });
      await settle();
      expect(screen.getByText('Nenhum problema encontrado.')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Parágrafo' }));
      await user.click(toolbar().getByRole('button', { name: 'Publicar' }));
      backend.expectOne({ method: 'PUT', url: '/api/forms/f-1/draft' }).flush({ ...VALID, version: 6 }, { headers: { ETag: '"6"' } });
      await settle();
      const publish = backend.expectOne({ method: 'POST', url: '/api/forms/f-1/publish' });
      expect(publish.request.headers.get('If-Match')).toBe('"6"');
      publish.flush({ versionNumber: 1, contentHash: 'sha256:x', created: true }, { status: 201, statusText: 'Created' });
      await settle();
      backend.expectOne({ method: 'GET', url: '/api/forms/f-1' }).flush({ ...VALID, latestVersion: 1, version: 7 }, { headers: { ETag: '"7"' } });
      await settle();
      expect(screen.getAllByRole('treeitem')).toHaveLength(3); // the editor kept its document
    });

    it('offers to reload after a 412 on save, asking first since the changes would be lost', async () => {
      await open(VALID);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Título' }));

      await user.click(toolbar().getByRole('button', { name: 'Salvar rascunho' }));
      backend
        .expectOne({ method: 'PUT', url: '/api/forms/f-1/draft' })
        .flush({ type: 'about:blank', title: 'Changed', status: 412, code: 'version_mismatch' }, { status: 412, statusText: 'Precondition Failed' });
      await settle();
      await user.click(screen.getByRole('button', { name: 'Recarregar' }));
      await confirmIn(user, 'Recarregar');
      backend.expectOne({ method: 'GET', url: '/api/forms/f-1' }).flush({ ...VALID, version: 9 }, { headers: { ETag: '"9"' } });
      await settle();

      expect(screen.getAllByRole('treeitem')).toHaveLength(1);
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
    });

    it('discards the changes after asking, and undoes and redoes them', async () => {
      await open(VALID);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Separador' }));

      await user.click(toolbar().getByRole('button', { name: 'Desfazer' }));
      expect(screen.getAllByRole('treeitem')).toHaveLength(1);
      await user.click(toolbar().getByRole('button', { name: 'Refazer' }));
      expect(screen.getAllByRole('treeitem')).toHaveLength(2);

      await user.click(toolbar().getByRole('button', { name: 'Descartar alterações' }));
      await confirmIn(user, 'Descartar');
      expect(screen.getAllByRole('treeitem')).toHaveLength(1);
    });

    it('deletes, moves and moves to a chosen place the selected component', async () => {
      await open();
      const user = userEvent.setup();
      const order = () => screen.getAllByRole('treeitem', { name: /chave/ }).map((element) => element.dataset['path']);

      await user.click(within(screen.getByRole('treeitem', { name: /^CPF/ })).getByText('CPF'));
      expect(status()).toBe('Selecionado: CPF (campo de texto).');
      await user.click(screen.getByRole('button', { name: 'Mover para baixo' }));
      expect(order()).toEqual(['tipo', 'cpf', 'endereco', 'endereco.cep', 'socios']);

      await user.click(screen.getByRole('button', { name: 'Mover para…' }));
      const dialog = within(screen.getByRole('dialog'));
      await user.selectOptions(dialog.getByRole('combobox', { name: 'Para' }), '— Endereço');
      await user.click(dialog.getByRole('button', { name: 'Mover' }));
      expect(order()).toEqual(['tipo', 'endereco', 'endereco.cep', 'endereco.cpf', 'socios']);

      await user.click(toolbar().getByRole('button', { name: 'Excluir' }));
      expect(order()).toEqual(['tipo', 'endereco', 'endereco.cep', 'socios']);
      expect(status()).toBe('Excluído: CPF.');
    });

    it('opens the properties in the side panel from Propriedades… and from Enter, and applies changes at once (§8)', async () => {
      await open(VALID);
      const user = userEvent.setup();
      await user.click(within(screen.getByRole('treeitem', { name: /^Nome/ })).getByText('Nome'));

      await user.click(screen.getByRole('button', { name: 'Propriedades…' }));
      const panel = within(await screen.findByRole('dialog', { name: 'Campo de texto: Nome' }));
      await user.click(panel.getByRole('checkbox', { name: 'Obrigatório' }));
      await user.click(panel.getByRole('button', { name: 'Fechar' }));
      expect(screen.getByRole('treeitem', { name: 'Nome, campo de texto, chave nome' })).toBeTruthy(); // no longer required

      screen.getByRole('treeitem', { name: /^Nome/ }).focus();
      await user.keyboard('{Enter}');
      expect(await screen.findByRole('dialog', { name: 'Campo de texto: Nome' })).toBeTruthy();
    });

    it('adds from Adicionar componente, the palette on narrow screens (§5)', async () => {
      await open(VALID);
      const user = userEvent.setup();

      // Shown only below 64rem; jsdom applies the stylesheet but not the media query, so the button is hidden here.
      within(screen.getByRole('toolbar', { name: 'Ações do formulário' })).getByText('Adicionar componente').click();
      const dialog = within(await screen.findByRole('dialog', { name: 'Adicionar componente' }));
      await user.click(dialog.getByRole('button', { name: 'Área de texto' }));
      await settle();

      expect(screen.queryByRole('dialog', { name: 'Adicionar componente' })).toBeNull();
      expect(screen.getByRole('treeitem', { name: 'Área de texto, área de texto, chave area_de_texto' })).toBeTruthy();
    });

    it('restores a version into the draft after asking, and publishes nothing (§9.7, N3g)', async () => {
      await open({ ...VALID, latestVersion: 2 });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Título' })); // an unsaved change, which restoring loses

      await user.click(toolbar().getByRole('button', { name: 'Versões' }));
      backend.expectOne({ method: 'GET', url: '/api/forms/f-1/versions' }).flush([{ versionNumber: 2, contentHash: 'b', publishedAt: '2026-10-02T12:00:00Z', publishedBy: 'u' }]);
      await settle();
      await user.click(screen.getByRole('button', { name: 'Restaurar a versão 2 no rascunho' }));
      const question = within(await screen.findByRole('dialog', { name: 'Restaurar a versão 2?' }));
      expect(question.getByText(/As alterações não salvas serão perdidas./)).toBeTruthy();
      await user.click(question.getByRole('button', { name: 'Restaurar' }));

      const restore = backend.expectOne({ method: 'POST', url: '/api/forms/f-1/versions/2/restore' });
      expect(restore.request.headers.get('If-Match')).toBe('"4"');
      const restored = { schemaVersion: 1, components: [{ type: 'text', key: 'antigo', label: 'Antigo' }] };
      restore.flush({ ...VALID, latestVersion: 2, version: 6, draft: restored }, { headers: { ETag: '"6"' } });
      await settle();

      expect(screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))).toEqual(['Antigo, campo de texto, chave antigo']);
      expect(screen.queryByText('Alterações não salvas')).toBeNull();
      expect(TestBed.inject(ToastService).toasts().map((toast) => toast.message)).toContain('Versão 2 restaurada no rascunho.');
    });

    it('asks before closing or reloading the page with unsaved changes (§9.1; card #256)', async () => {
      await open(VALID);
      const user = userEvent.setup();
      const closing = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };

      expect(closing()).toBe(false);
      await user.click(screen.getByRole('button', { name: 'Título' }));
      expect(closing()).toBe(true);
    });

    it('asks before leaving with unsaved changes', async () => {
      await open(VALID);
      const user = userEvent.setup();
      const page = () => TestBed.inject(Router).routerState.root.firstChild!.component;
      expect(page()).toBe(FormDesignerPage);

      await user.click(screen.getByRole('button', { name: 'Título' }));
      const leaving = TestBed.inject(Router).navigateByUrl('/formularios');
      await settle();
      await confirmIn(user, 'Continuar editando');

      expect(await leaving).toBe(false);
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
