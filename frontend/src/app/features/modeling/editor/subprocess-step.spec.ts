import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { CatalogEntry } from './conditions';
import { SubprocessStep } from './subprocess-step';

const CATALOG: CatalogEntry[] = [{ path: ['cpf'], type: 'text', presence: 'definite', sources: ['start'] }];
const PROCESSES = [
  { id: 'w-3', name: 'Revisão livre', description: null, isActive: true, latestVersion: 1, draftUpdatedAt: '2026-10-17T12:00:00Z' },
  { id: 'w-4', name: 'Rascunho', description: null, isActive: true, latestVersion: null, draftUpdatedAt: '2026-10-17T12:00:00Z' },
];
const STORED = { workflowId: 'w-3', inputs: { cliente: { kind: 'path', path: ['cpf'] } } };

async function build(stored: unknown = STORED) {
  const view = await render(SubprocessStep, {
    inputs: { stored, catalog: CATALOG, exclude: 'w-1' },
    providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
  });
  return { view, backend: TestBed.inject(HttpTestingController) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('SubprocessStep (workflow-editor.md §10.10)', () => {
  it('shows the free keys of a process without a start form, and keeps them as stored when untouched', async () => {
    const { view, backend } = await build();
    backend.expectOne('/api/workflows').flush(PROCESSES);
    backend.expectOne('/api/workflows/w-3/versions/1/contract').flush({ versionNumber: 1, inputs: null, outputs: [] });
    await settle();
    view.fixture.detectChanges();

    const row = screen.getByRole('group', { name: 'Entrada 1' });
    expect((within(row).getByRole('textbox', { name: 'Chave' }) as HTMLInputElement).value).toBe('cliente');
    expect((within(row).getByRole('combobox', { name: 'Dado' }) as HTMLSelectElement).value).toBe('cpf');
    expect(view.fixture.componentInstance.result()).toEqual({ reference: STORED });
    backend.verify();
  });

  it('says when the chosen process was never published, and keeps only its id', async () => {
    const { view, backend } = await build();
    backend.expectOne('/api/workflows').flush(PROCESSES);
    backend.expectOne('/api/workflows/w-3/versions/1/contract').flush({ versionNumber: 1, inputs: null, outputs: [] });
    await settle();
    view.fixture.detectChanges();

    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Processo' }), 'w-4');
    expect(screen.getByText('Publique o processo para mapear as entradas e as saídas.')).toBeTruthy();
    expect(view.fixture.componentInstance.result()).toEqual({ reference: { workflowId: 'w-4' } });
  });

  it('names a process that no longer exists, and keeps its reference', async () => {
    const { view, backend } = await build({ workflowId: 'w-9' });
    backend.expectOne('/api/workflows').flush(PROCESSES);
    await settle();
    view.fixture.detectChanges();
    expect((screen.getByRole('combobox', { name: 'Processo' }) as HTMLSelectElement).selectedOptions[0].textContent!.trim()).toBe('Processo indisponível');
    expect(view.fixture.componentInstance.result()).toEqual({ reference: { workflowId: 'w-9' } });
  });

  describe("files, which a sub-workflow's inputs can't carry (WF206; card #202)", () => {
    const FILE_DATA: CatalogEntry[] = [
      { path: ['contato'], type: 'object', presence: 'definite', sources: ['start'] },
      { path: ['contato', 'email'], type: 'text', presence: 'definite', sources: ['start'] },
      { path: ['cpf'], type: 'text', presence: 'definite', sources: ['start'] },
      { path: ['docs'], type: 'list<file>', presence: 'definite', sources: ['start'] },
      { path: ['endereco'], type: 'object', presence: 'definite', sources: ['start'] },
      { path: ['endereco', 'comprovante'], type: 'list<file>', presence: 'definite', sources: ['start'] },
    ];
    const WITH_FILES = {
      versionNumber: 1,
      inputs: [
        { key: 'anexos', type: 'list<file>', required: true },
        { key: 'endereco', type: 'object', required: false },
      ],
      outputs: [],
    };
    const NO_FILES = 'Arquivos não passam para um subprocesso: publicar recusa esta entrada.';

    async function open(stored: unknown, contract: object) {
      const view = await render(SubprocessStep, {
        inputs: { stored, catalog: FILE_DATA, exclude: 'w-1' },
        providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
      });
      const backend = TestBed.inject(HttpTestingController);
      backend.expectOne('/api/workflows').flush(PROCESSES);
      backend.expectOne('/api/workflows/w-3/versions/1/contract').flush(contract);
      await settle();
      view.fixture.detectChanges();
      return view;
    }

    const options = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((option) => option.textContent!.trim());

    it('lists a file field of the start form with the reason in place of a value, and keeps its required warning', async () => {
      await open({ workflowId: 'w-3' }, WITH_FILES);

      const row = screen.getByRole('group', { name: 'anexos' });
      expect(within(row).getByText('Arquivos não passam para um subprocesso.')).toBeTruthy();
      expect(within(row).queryByRole('combobox', { name: 'Tipo do valor' })).toBeNull();
      expect(within(row).getByText('Campo obrigatório: sem ele, a subsolicitação é recusada.')).toBeTruthy();
    });

    it('leaves data that hold files out of Dado: a file field, or a group with one', async () => {
      await open({ workflowId: 'w-3' }, WITH_FILES);
      const user = userEvent.setup();

      const row = screen.getByRole('group', { name: 'endereco' });
      await user.selectOptions(within(row).getByRole('combobox', { name: 'Tipo do valor' }), 'path');
      expect(options(within(row).getByRole('combobox', { name: 'Dado' }))).toEqual(['Escolha o dado', 'contato (objeto)']);
    });

    it('leaves data that hold files out of Dado for a free input too', async () => {
      await open({ workflowId: 'w-3' }, { versionNumber: 1, inputs: null, outputs: [] });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: '+ entrada' }));

      const row = screen.getByRole('group', { name: 'Entrada 1' });
      await user.selectOptions(within(row).getByRole('combobox', { name: 'Tipo do valor' }), 'path');
      expect(options(within(row).getByRole('combobox', { name: 'Dado' }))).toEqual(['Escolha o dado', 'contato (objeto)', 'contato.email (texto)', 'cpf (texto)']);
    });

    it('shows a stored input that carries files as text, warns, keeps it as stored, and removes it on request', async () => {
      const stored = { workflowId: 'w-3', inputs: { anexos: { kind: 'path', path: ['docs'] }, endereco: { kind: 'path', path: ['endereco'] } } };
      const view = await open(stored, WITH_FILES);

      const anexos = screen.getByRole('group', { name: 'anexos' });
      expect(within(anexos).getByText('data.docs')).toBeTruthy();
      expect(within(anexos).getByText(NO_FILES)).toBeTruthy();
      const endereco = screen.getByRole('group', { name: 'endereco' });
      expect(within(endereco).getByText('data.endereco')).toBeTruthy();
      expect(within(endereco).getByText(NO_FILES)).toBeTruthy();
      expect(within(endereco).queryByRole('combobox', { name: 'Dado' })).toBeNull();
      expect(view.fixture.componentInstance.result()).toEqual({ reference: stored });

      await userEvent.setup().click(within(anexos).getByRole('button', { name: 'Remover' }));
      expect(within(anexos).getByText('Arquivos não passam para um subprocesso.')).toBeTruthy();
      expect(view.fixture.componentInstance.result()).toEqual({ reference: { workflowId: 'w-3', inputs: { endereco: { kind: 'path', path: ['endereco'] } } } });
    });

    it.each(THEMES)('passes axe in the %s theme', async (theme) => {
      applyTheme(theme);
      const view = await open({ workflowId: 'w-3', inputs: { endereco: { kind: 'path', path: ['endereco'] } } }, WITH_FILES);
      await expectNoAxeViolations(view.container);
    });
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      const { view, backend } = await build();
      backend.expectOne('/api/workflows').flush(PROCESSES);
      backend.expectOne('/api/workflows/w-3/versions/1/contract').flush({ versionNumber: 1, inputs: null, outputs: [] });
      await settle();
      view.fixture.detectChanges();
      await expectNoAxeViolations(view.container);
    });
  });
});
