import { Component, signal } from '@angular/core';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { CatalogEntry } from '../editor/conditions';
import { ValueBuilder } from './value-builder';

const CATALOG: CatalogEntry[] = [
  { path: ['quantidade'], type: 'number', presence: 'optional', sources: ['Este formulário'] },
  { path: ['parcela'], type: 'number', presence: 'optional', sources: ['Este formulário'] },
  { path: ['inicio'], type: 'date', presence: 'optional', sources: ['Este formulário'] },
  { path: ['itens', '[]', 'valor'], type: 'number', presence: 'optional', sources: ['Este formulário'] },
];
const path = (...segments: string[]) => ({ kind: 'path', path: segments });

@Component({
  imports: [ValueBuilder],
  template: `<chain-value-builder [(value)]="value" [catalog]="catalog" label="Expressão" />`,
})
class Host {
  readonly value = signal<unknown>(undefined);
  readonly catalog = CATALOG;
}

describe('ValueBuilder: Expressão (form-designer.md §12.6, Q-FD6 (a))', () => {
  async function open(value: unknown = undefined) {
    const view = await render(Host);
    view.fixture.componentInstance.value.set(value);
    view.fixture.detectChanges();
    return { host: view.fixture.componentInstance, user: userEvent.setup() };
  }
  const group = (name: string) => within(screen.getByRole('group', { name }));
  const form = (name: string) => screen.getByRole('combobox', { name: `${name}: forma` });

  it('builds Parcelas × Valor da parcela as an arithmetic step', async () => {
    const { host, user } = await open();

    await user.selectOptions(form('Expressão'), 'Conta');
    await user.selectOptions(form('Primeiro termo'), 'Dado');
    await user.selectOptions(group('Primeiro termo').getByRole('combobox', { name: 'Dado' }), 'quantidade (número)');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Operação' }), '×');
    await user.selectOptions(form('Segundo termo'), 'Dado');
    await user.selectOptions(group('Segundo termo').getByRole('combobox', { name: 'Dado' }), 'parcela (número)');

    expect(host.value()).toEqual({ kind: 'arithmetic', op: 'multiply', left: path('quantidade'), right: path('parcela') });
  });

  it('builds a function call, with a list projection for sum and a number written with a decimal comma', async () => {
    const { host, user } = await open();

    await user.selectOptions(form('Expressão'), 'Função');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Função' }), 'round: arredondar');
    await user.selectOptions(form('Argumento 1'), 'Função');
    await user.selectOptions(group('Argumento 1').getByRole('combobox', { name: 'Função' }), 'sum: soma de uma lista');
    await user.selectOptions(form('Argumento 1 de sum'), 'Dado');
    await user.selectOptions(group('Argumento 1 de sum').getByRole('combobox', { name: 'Dado' }), 'itens[].valor (número)');
    await user.click(screen.getByRole('button', { name: 'Usar Casas decimais' }));
    await user.selectOptions(form('Argumento 2'), 'Número');
    await user.type(group('Argumento 2').getByRole('textbox', { name: 'Número' }), '2,0');

    expect(host.value()).toEqual({
      kind: 'call',
      function: 'round',
      args: [{ kind: 'call', function: 'sum', args: [path('itens', '[]', 'valor')] }, { kind: 'literal', type: 'number', value: '2.0' }],
    });
  });

  it('adds and removes values of min and max', async () => {
    const { host, user } = await open({ kind: 'call', function: 'max', args: [path('quantidade')] });

    await user.click(screen.getByRole('button', { name: '+ valor' }));
    await user.selectOptions(form('Argumento 2'), 'Número');
    await user.type(group('Argumento 2').getByRole('textbox', { name: 'Número' }), '10');
    expect(host.value()).toEqual({ kind: 'call', function: 'max', args: [path('quantidade'), { kind: 'literal', type: 'number', value: '10' }] });

    await user.click(screen.getByRole('button', { name: 'Remover o argumento 2' }));
    expect(host.value()).toEqual({ kind: 'call', function: 'max', args: [path('quantidade')] });
  });

  it('adjusts a date datum and today, and reads a path into the request data', async () => {
    const { host, user } = await open();

    await user.selectOptions(form('Expressão'), 'Hoje');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Ajuste' }), 'mais');
    await user.type(screen.getByRole('textbox', { name: 'Quantidade' }), '30');
    expect(host.value()).toEqual({ kind: 'system', name: 'currentDate', offset: { amount: 30, unit: 'days' } });

    await user.selectOptions(form('Expressão'), 'Dado');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dado' }), 'Outro dado do pedido…');
    await user.type(screen.getByRole('textbox', { name: 'Caminho do dado do pedido' }), 'cliente.limite');
    await user.tab();
    expect(host.value()).toEqual(path('cliente', 'limite'));
  });

  it('shows an existing tree, with its text form', async () => {
    await open({ kind: 'arithmetic', op: 'add', left: path('quantidade'), right: { kind: 'literal', type: 'number', value: '1' } });

    expect((form('Expressão') as HTMLSelectElement).selectedOptions[0].text).toBe('Conta');
    expect((screen.getByRole('combobox', { name: 'Operação' }) as HTMLSelectElement).selectedOptions[0].text).toBe('+');
    expect((group('Segundo termo').getByRole('textbox', { name: 'Número' }) as HTMLInputElement).value).toBe('1');
  });
});
