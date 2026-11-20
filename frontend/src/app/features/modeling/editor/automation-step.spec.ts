import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { AutomationStep } from './automation-step';
import { CatalogEntry } from './conditions';

const CATALOG: CatalogEntry[] = [{ path: ['cpf'], type: 'text', presence: 'definite', sources: ['start'] }];
const AUTOMATIONS = [
  { id: 'a-1', name: 'Consultar CPF', description: null, latestVersion: 2, draftUpdatedAt: '2026-10-17T12:00:00Z' },
  { id: 'a-3', name: 'Consultar CPF v2', description: null, latestVersion: 1, draftUpdatedAt: '2026-10-17T12:00:00Z' },
];
const VERSION = {
  versionNumber: 2,
  contentHash: 'sha256:x',
  publishedAt: '2026-10-17T12:00:00Z',
  document: { inputs: [{ key: 'cpf', type: 'text', required: true }], outputs: [{ key: 'situacao', type: 'text', required: true }] },
};
const STORED = {
  automationId: 'a-1',
  inputs: { cpf: { kind: 'path', path: ['cpf'] } },
  outputs: { situacaoCpf: { kind: 'path', path: ['situacao'] }, dobro: { kind: 'arithmetic', op: 'multiply', left: { kind: 'path', path: ['situacao'] }, right: { kind: 'literal', type: 'number', value: '2' } } },
};

async function build(stored: unknown = STORED) {
  const view = await render(AutomationStep, {
    inputs: { stored, catalog: CATALOG },
    providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
  });
  return { view, backend: TestBed.inject(HttpTestingController), user: userEvent.setup() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('AutomationStep (workflow-editor.md §10.9)', () => {
  it('shows an output mapping of another shape as text, keeps it, and lets it be removed', async () => {
    const { view, backend, user } = await build();
    backend.expectOne('/api/automations').flush(AUTOMATIONS);
    backend.expectOne('/api/automations/a-1/versions/2').flush(VERSION);
    await settle();
    view.fixture.detectChanges();

    const step = view.fixture.componentInstance;
    expect(within(screen.getByRole('group', { name: 'dobro' })).getByText('dobro ← (data.situacao × 2)')).toBeTruthy();
    expect(step.result()).toEqual({ reference: STORED });
    await user.click(within(screen.getByRole('group', { name: 'dobro' })).getByRole('button', { name: 'Remover' }));
    expect(step.result()).toEqual({ reference: { automationId: 'a-1', inputs: STORED.inputs, outputs: { situacaoCpf: STORED.outputs.situacaoCpf } } });
    backend.verify();
  });

  it('drops the mappings when another automation is chosen, even for inputs of the same key', async () => {
    const { view, backend, user } = await build();
    backend.expectOne('/api/automations').flush(AUTOMATIONS);
    backend.expectOne('/api/automations/a-1/versions/2').flush(VERSION);
    await settle();
    view.fixture.detectChanges();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Automação' }), 'a-3');
    backend.expectOne('/api/automations/a-3/versions/1').flush({ ...VERSION, versionNumber: 1 });
    await settle();
    view.fixture.detectChanges();
    const cpf = screen.getByRole('group', { name: 'cpf' });
    expect((within(cpf).getByRole('combobox', { name: 'Tipo do valor' }) as HTMLSelectElement).value).toBe('none');
    expect(screen.queryByRole('group', { name: 'dobro' })).toBeNull();
    expect(view.fixture.componentInstance.result()).toEqual({ reference: { automationId: 'a-3' } });
    backend.verify();
  });

  it('names an automation that no longer exists, and keeps its reference', async () => {
    const gone = await build({ automationId: 'a-9' });
    gone.backend.expectOne('/api/automations').flush(AUTOMATIONS);
    await settle();
    gone.view.fixture.detectChanges();
    expect((screen.getByRole('combobox', { name: 'Automação' }) as HTMLSelectElement).selectedOptions[0].textContent!.trim()).toBe('Automação indisponível');
    expect(gone.view.fixture.componentInstance.result()).toEqual({ reference: { automationId: 'a-9' } });
  });

  it('says when the version cannot be read, and keeps the reference as stored', async () => {
    const failing = await build();
    failing.backend.expectOne('/api/automations').flush(AUTOMATIONS);
    failing.backend.expectOne('/api/automations/a-1/versions/2').flush({ code: 'internal' }, { status: 500, statusText: 'Erro' });
    await settle();
    failing.view.fixture.detectChanges();
    expect(screen.getByText('Não foi possível ler a automação.')).toBeTruthy();
    expect(failing.view.fixture.componentInstance.result()).toEqual({ reference: STORED }); // untouched: kept as stored
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      const { view, backend } = await build();
      backend.expectOne('/api/automations').flush(AUTOMATIONS);
      backend.expectOne('/api/automations/a-1/versions/2').flush(VERSION);
      await settle();
      view.fixture.detectChanges();
      await expectNoAxeViolations(view.container);
    });
  });
});
