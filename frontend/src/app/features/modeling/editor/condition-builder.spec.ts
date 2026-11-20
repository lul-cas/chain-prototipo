import { Component, signal } from '@angular/core';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { ConditionBuilder } from './condition-builder';
import { CatalogEntry, Group, toJson, toRows } from './conditions';

const CATALOG: CatalogEntry[] = [
  { path: ['DataVencimento'], type: 'date', presence: 'definite', sources: ['start'] },
  { path: ['RecebidoEm'], type: 'datetime', presence: 'definite', sources: ['start'] },
  { path: ['aprovado'], type: 'boolean', presence: 'optional', sources: ['task_1'] },
  { path: ['endereco'], type: 'object', presence: 'optional', sources: ['task_1'] },
  { path: ['endereco', 'cep'], type: 'text', presence: 'optional', sources: ['task_1'] },
  { path: ['limite'], type: 'number', presence: 'definite', sources: ['start'] },
  { path: ['valor'], type: 'number', presence: 'definite', sources: ['start'] },
];

const path = (...segments: string[]) => ({ kind: 'path', path: segments });
const EXAMPLE = {
  kind: 'group',
  op: 'and',
  items: [
    { kind: 'compare', left: path('DataVencimento'), operator: 'greaterOrEqual', right: { kind: 'system', name: 'currentDate' } },
    { kind: 'compare', left: path('valor'), operator: 'lessOrEqual', right: { kind: 'literal', type: 'number', value: '50000' } },
  ],
};

@Component({
  imports: [ConditionBuilder],
  template: `<chain-condition-builder [(rows)]="rows" [catalog]="catalog" [otherData]="otherData" />`,
})
class Host {
  readonly rows = signal<Group>(toRows(EXAMPLE));
  catalog: readonly CatalogEntry[] = CATALOG;
  otherData = false;
}

async function build(condition: unknown = EXAMPLE) {
  const view = await render(Host);
  const host = view.fixture.componentInstance;
  host.rows.set(toRows(condition));
  view.fixture.detectChanges();
  await view.fixture.whenStable();
  return { host, view, user: userEvent.setup() };
}

const rows = () => screen.getAllByRole('group', { name: /^Condição \d/ });
const preview = () => screen.getByTestId('condition-preview').textContent!.trim();

describe('ConditionBuilder (workflow-editor.md §10.7, expression-language.md §6)', () => {
  it('shows each comparison with its data, operator and value, and a preview of the whole', async () => {
    await build();

    expect(rows()).toHaveLength(2);
    const [first, second] = rows();
    expect((within(first).getByRole('combobox', { name: 'Dado' }) as HTMLSelectElement).value).toBe('DataVencimento');
    expect((within(first).getByRole('combobox', { name: 'Operador' }) as HTMLSelectElement).value).toBe('greaterOrEqual');
    expect((within(first).getByRole('combobox', { name: 'Tipo do valor' }) as HTMLSelectElement).value).toBe('system');
    expect((within(first).getByRole('combobox', { name: 'Valor do sistema' }) as HTMLSelectElement).value).toBe('currentDate');
    expect((within(second).getByRole('textbox', { name: 'Valor' }) as HTMLInputElement).value).toBe('50000');
    expect((screen.getByRole('combobox', { name: 'Combinar' }) as HTMLSelectElement).value).toBe('and');
    expect(preview()).toBe('data.DataVencimento ≥ currentDate E data.valor ≤ 50000');
  });

  it("lists the data by path with its type, without objects, and only the operators of the chosen data's type", async () => {
    const { user, host } = await build({ kind: 'group', op: 'and', items: [] });

    await user.click(screen.getByRole('button', { name: '+ condição' }));
    const row = rows()[0];
    const data = within(row).getByRole('combobox', { name: 'Dado' });
    expect(within(data).getAllByRole('option').map((option) => option.textContent!.trim())).toEqual([
      'Escolha o dado',
      'DataVencimento (data)',
      'RecebidoEm (data e hora)',
      'aprovado (sim ou não)',
      'endereco.cep (texto)',
      'limite (número)',
      'valor (número)',
    ]);

    await user.selectOptions(data, 'aprovado');
    const operator = within(rows()[0]).getByRole('combobox', { name: 'Operador' });
    expect(within(operator).getAllByRole('option').map((option) => option.textContent!.trim())).toEqual([
      'Escolha o operador',
      'igual a',
      'diferente de',
      'está vazio',
      'não está vazio',
    ]);

    await user.selectOptions(operator, 'equals');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Valor' }), 'true');
    expect(toJson(host.rows())).toEqual({
      json: {
        kind: 'group',
        op: 'and',
        items: [{ kind: 'compare', left: path('aprovado'), operator: 'equals', right: { kind: 'literal', type: 'boolean', value: 'true' } }],
      },
    });
  });

  it('enters the value as its type: a number, a date, another datum of the same type, or the current date', async () => {
    const { user, host } = await build({ kind: 'group', op: 'and', items: [] });
    await user.click(screen.getByRole('button', { name: '+ condição' }));
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Dado' }), 'DataVencimento');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Operador' }), 'lessThan');

    const value = within(rows()[0]).getByLabelText('Valor') as HTMLInputElement;
    expect(value.type).toBe('date');
    await user.type(value, '2026-12-31');
    expect(preview()).toBe('data.DataVencimento < 2026-12-31');

    const kind = within(rows()[0]).getByRole('combobox', { name: 'Tipo do valor' });
    expect(within(kind).getAllByRole('option').map((option) => option.textContent!.trim())).toEqual(['Valor', 'Dado', 'Sistema']);
    await user.selectOptions(kind, 'system');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Valor do sistema' }), 'currentDate');
    expect(preview()).toBe('data.DataVencimento < currentDate');

    await user.click(screen.getByRole('button', { name: '+ condição' }));
    await user.selectOptions(within(rows()[1]).getByRole('combobox', { name: 'Dado' }), 'valor');
    await user.selectOptions(within(rows()[1]).getByRole('combobox', { name: 'Operador' }), 'lessOrEqual');
    const kinds = within(rows()[1]).getByRole('combobox', { name: 'Tipo do valor' });
    expect(within(kinds).getAllByRole('option').map((option) => option.textContent!.trim())).toEqual(['Valor', 'Dado']); // no system value for a number
    await user.selectOptions(within(rows()[1]).getByRole('combobox', { name: 'Tipo do valor' }), 'path');
    const other = within(rows()[1]).getByRole('combobox', { name: 'Outro dado' });
    expect(within(other).getAllByRole('option').map((option) => option.textContent!.trim())).toEqual(['Escolha o dado', 'limite (número)', 'valor (número)']);
    await user.selectOptions(other, 'limite');
    expect(within(rows()[1]).queryByRole('combobox', { name: 'Tipo do valor' })).toBeTruthy();
    expect(preview()).toBe('data.DataVencimento < currentDate E data.valor ≤ data.limite');
    expect('json' in toJson(host.rows())).toBe(true);
  });

  it('keeps the value when the new datum has the same type, and drops it when the type changes', async () => {
    const { user } = await build({
      kind: 'group',
      op: 'and',
      items: [{ kind: 'compare', left: path('valor'), operator: 'equals', right: { kind: 'literal', type: 'number', value: '10' } }],
    });

    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Dado' }), 'limite');
    expect((within(rows()[0]).getByRole('textbox', { name: 'Valor' }) as HTMLInputElement).value).toBe('10');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Dado' }), 'endereco.cep');
    expect((within(rows()[0]).getByRole('textbox', { name: 'Valor' }) as HTMLInputElement).value).toBe('');
    expect(within(rows()[0]).getByText('Informe o valor.')).toBeTruthy();
  });

  it('adjusts a date by days, months or years, and a datetime also by hours and minutes (§10.8)', async () => {
    const { user, host } = await build({ kind: 'group', op: 'and', items: [] });
    await user.click(screen.getByRole('button', { name: '+ condição' }));
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Dado' }), 'DataVencimento');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Operador' }), 'lessOrEqual');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Tipo do valor' }), 'system');

    const value = within(rows()[0]).getByRole('group', { name: 'Ajuste do valor' });
    expect(within(value).queryByRole('textbox', { name: 'Quantidade' })).toBeNull();
    await user.selectOptions(within(value).getByRole('combobox', { name: 'Ajuste' }), '-');
    expect(within(rows()[0]).getByText('Informe a quantidade do ajuste.')).toBeTruthy();
    const units = within(value).getByRole('combobox', { name: 'Unidade' });
    expect(within(units).getAllByRole('option').map((option) => option.textContent!.trim())).toEqual(['dias', 'meses', 'anos']);
    await user.type(within(value).getByRole('textbox', { name: 'Quantidade' }), '30');
    expect(preview()).toBe('data.DataVencimento ≤ currentDate − 30 dias');

    const datum = within(rows()[0]).getByRole('group', { name: 'Ajuste do dado' });
    await user.selectOptions(within(datum).getByRole('combobox', { name: 'Ajuste' }), '+');
    await user.type(within(datum).getByRole('textbox', { name: 'Quantidade' }), '1');
    await user.selectOptions(within(datum).getByRole('combobox', { name: 'Unidade' }), 'months');
    expect(preview()).toBe('data.DataVencimento + 1 mês ≤ currentDate − 30 dias');
    expect(toJson(host.rows())).toEqual({
      json: {
        kind: 'group',
        op: 'and',
        items: [
          {
            kind: 'compare',
            left: { kind: 'path', path: ['DataVencimento'], offset: { amount: 1, unit: 'months' } },
            operator: 'lessOrEqual',
            right: { kind: 'system', name: 'currentDate', offset: { amount: -30, unit: 'days' } },
          },
        ],
      },
    });

    await user.selectOptions(within(value).getByRole('combobox', { name: 'Ajuste' }), '');
    expect(preview()).toBe('data.DataVencimento + 1 mês ≤ currentDate');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Dado' }), 'RecebidoEm');
    const datetime = within(rows()[0]).getByRole('group', { name: 'Ajuste do dado' });
    expect((within(datetime).getByRole('combobox', { name: 'Ajuste' }) as HTMLSelectElement).value).toBe(''); // another datum drops it
    await user.selectOptions(within(datetime).getByRole('combobox', { name: 'Ajuste' }), '+');
    const datetimeUnits = within(datetime).getByRole('combobox', { name: 'Unidade' });
    expect(within(datetimeUnits).getAllByRole('option').map((option) => option.textContent!.trim())).toEqual(['dias', 'meses', 'anos', 'horas', 'minutos']);
    expect(within(rows()[0]).queryByRole('group', { name: 'Ajuste do valor' })).toBeNull(); // the value went with the type change, and a typed value takes none
  });

  it('offers no adjustment for data that are not dates, and shows one it cannot edit as text', async () => {
    const hours = { kind: 'path', path: ['DataVencimento'], offset: { amount: 2, unit: 'hours' } };
    const { user } = await build({ kind: 'group', op: 'and', items: [{ kind: 'compare', left: hours, operator: 'isNotEmpty' }] });
    expect(within(rows()[0]).getByText('data.DataVencimento + 2 horas não está vazio')).toBeTruthy(); // hours on a date

    await user.click(screen.getByRole('button', { name: '+ condição' }));
    await user.selectOptions(within(rows()[1]).getByRole('combobox', { name: 'Dado' }), 'valor');
    expect(within(rows()[1]).queryByRole('group', { name: 'Ajuste do dado' })).toBeNull();
  });

  it('hides the value of an operator that takes none, and nests groups with E and OU', async () => {
    const { user } = await build({ kind: 'group', op: 'and', items: [] });

    await user.click(screen.getByRole('button', { name: '+ condição' }));
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Dado' }), 'endereco.cep');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Operador' }), 'isEmpty');
    expect(within(rows()[0]).queryByRole('combobox', { name: 'Tipo do valor' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '+ grupo' }));
    const group = screen.getByRole('group', { name: 'Grupo 2' });
    await user.selectOptions(within(group).getByRole('combobox', { name: 'Combinar' }), 'or');
    await user.click(within(group).getByRole('button', { name: '+ condição' }));
    await user.selectOptions(within(group).getByRole('combobox', { name: 'Dado' }), 'aprovado');
    await user.selectOptions(within(group).getByRole('combobox', { name: 'Operador' }), 'isNotEmpty');
    expect(preview()).toBe('data.endereco.cep está vazio E data.aprovado não está vazio');

    await user.click(within(group).getByRole('button', { name: 'Remover grupo' }));
    expect(screen.queryByRole('group', { name: 'Grupo 2' })).toBeNull();
    await user.click(within(rows()[0]).getByRole('button', { name: 'Remover condição' }));
    expect(screen.queryAllByRole('group', { name: /^Condição \d/ })).toHaveLength(0);
  });

  it('says next to a row what it lacks, and warns about types that do not match and an empty group', async () => {
    const { user } = await build({ kind: 'group', op: 'and', items: [] });
    expect(screen.getByText('Grupo vazio.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '+ condição' }));
    expect(within(rows()[0]).getByText('Escolha o dado.')).toBeTruthy();
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Dado' }), 'valor');
    await user.selectOptions(within(rows()[0]).getByRole('combobox', { name: 'Operador' }), 'equals');
    expect(within(rows()[0]).getByText('Informe o valor.')).toBeTruthy();
    await user.type(within(rows()[0]).getByRole('textbox', { name: 'Valor' }), '12,5');
    expect(within(rows()[0]).getByText('Número inválido.')).toBeTruthy();
  });

  it('shows what it cannot edit as text, a function or a datum the catalog lacks, keeps it, and lets it be removed', async () => {
    const call = { kind: 'call', function: 'sum', args: [path('itens', '[]', 'valor')] };
    const condition = {
      kind: 'group',
      op: 'and',
      items: [
        { kind: 'compare', left: call, operator: 'greaterThan', right: { kind: 'literal', type: 'number', value: '10' } },
        { kind: 'compare', left: path('valor'), operator: 'equals', right: path('antigo') },
      ],
    };
    const { user, host } = await build(condition);

    expect(within(rows()[0]).getByText('sum(data.itens[].valor) > 10')).toBeTruthy();
    expect(within(rows()[1]).getByText('data.valor = data.antigo')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Dado' })).toBeNull();
    expect(toJson(host.rows())).toEqual({ json: condition });
    await user.click(within(rows()[0]).getByRole('button', { name: 'Remover condição' }));
    expect(toJson(host.rows())).toEqual({ json: { ...condition, items: [condition.items[1]] } });
  });

  it("with otherData, takes a path into the request's data that the catalog lacks, as the form designer does (form-designer.md §12.5)", async () => {
    const condition = { kind: 'compare', left: path('cliente', 'cpf'), operator: 'isNotEmpty' };
    const { user, host, view } = await build({ kind: 'group', op: 'and', items: [] });
    host.otherData = true;
    host.rows.set(toRows({ kind: 'group', op: 'and', items: [condition] }));
    view.fixture.detectChanges();

    const row = within(rows()[0]);
    expect((row.getByRole('combobox', { name: 'Dado' }) as HTMLSelectElement).selectedOptions[0].text).toBe('Outro dado do pedido…');
    expect((row.getByRole('textbox', { name: 'Caminho do dado do pedido' }) as HTMLInputElement).value).toBe('cliente.cpf');

    await user.clear(row.getByRole('textbox', { name: 'Caminho do dado do pedido' }));
    await user.type(row.getByRole('textbox', { name: 'Caminho do dado do pedido' }), 'cliente.cnpj');
    await user.tab();
    expect(toJson(host.rows())).toEqual({ json: { kind: 'group', op: 'and', items: [{ ...condition, left: path('cliente', 'cnpj') }] } });

    await user.selectOptions(row.getByRole('combobox', { name: 'Dado' }), 'valor (número)');
    expect(row.queryByRole('textbox', { name: 'Caminho do dado do pedido' })).toBeNull();
  });

  it('without otherData, keeps a datum the catalog lacks as text, as before', async () => {
    await build({ kind: 'compare', left: path('cliente', 'cpf'), operator: 'isNotEmpty' });

    expect(screen.queryByRole('combobox', { name: 'Dado' })).toBeNull();
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      const { view } = await build();
      await expectNoAxeViolations(view.container);
    });
  });
});
