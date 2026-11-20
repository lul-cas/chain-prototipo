import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { RequestPage } from './request-page';

// requests-ui.md §6: hidden sensitive values and hidden incident messages (sensitive-data.md §5, card #53).

const ANA = { id: 'u-ana', username: 'ana', displayName: 'Ana Souza' };

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    definitionId: 'd-1',
    definitionName: 'Concessão de Crédito',
    versionNumber: 1,
    status: 'faulted',
    currentNodeId: 'gw',
    requester: ANA,
    startedAt: '2026-10-16T12:00:00Z',
    endedAt: null,
    openTasks: [],
    participants: [ANA],
    timeline: [],
    data: { valor: 1000 },
    maskedKeys: ['cpf', 'renda'],
    incidents: [
      { id: 'i-1', nodeId: 'gw', code: 'type_mismatch', message: null, createdAt: '2026-10-16T12:00:00Z', resolvedAt: null, resolution: null },
      { id: 'i-2', nodeId: 'gw', code: 'a_new_code', message: null, createdAt: '2026-10-16T12:00:00Z', resolvedAt: null, resolution: null },
    ],
    parent: null,
    children: [],
    version: 3,
    ...overrides,
  };
}

describe('RequestPage: sensitive data (requests-ui.md §6)', () => {
  let backend: HttpTestingController;

  async function open(body: object): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'solicitacoes/:id', component: RequestPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    backend = TestBed.inject(HttpTestingController);
    await RouterTestingHarness.create('/solicitacoes/r-1');
    backend.expectOne('/api/instances/r-1').flush(body);
    await new Promise((resolve) => setTimeout(resolve));
  }

  afterEach(() => backend.verify());

  it('lists each hidden key in the data, after the values it may see', async () => {
    await open(view());

    const data = screen.getByRole('region', { name: 'Dados' });
    const terms = within(data).getAllByRole('term').map((term) => term.textContent?.trim());
    expect(terms).toEqual(['valor', 'cpf', 'renda']);
    expect(within(data).getAllByText('Oculto (dado sigiloso)')).toHaveLength(2);
  });

  it('shows the data section when every key is hidden', async () => {
    await open(view({ data: {}, maskedKeys: ['cpf'] }));

    expect(screen.queryByText('Nenhum dado.')).toBeNull();
    expect(screen.getByText('Oculto (dado sigiloso)')).toBeTruthy();
  });

  it("shows a hidden incident message as the code's text, or the code, alone", async () => {
    await open(view());

    const incidents = within(screen.getByRole('region', { name: 'Incidentes' })).getAllByRole('listitem');
    const parts = incidents.map((item) => Array.from(item.children, (child) => child.textContent?.trim()));
    expect(parts).toEqual([['A decisão automática usou dados de tipos que não combinam.', 'type_mismatch'], ['a_new_code']]);
    expect(incidents.some((item) => item.textContent?.includes('null'))).toBe(false);
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe with hidden values', async () => {
      await open(view());
      await expectNoAxeViolations();
    });
  });
});
