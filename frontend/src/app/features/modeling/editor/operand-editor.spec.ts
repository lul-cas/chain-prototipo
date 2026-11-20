import { Component, signal } from '@angular/core';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { CatalogEntry, Operand } from './conditions';
import { OperandEditor } from './operand-editor';

const CATALOG: CatalogEntry[] = [
  { path: ['cpf'], type: 'text', presence: 'definite', sources: ['start'] },
  { path: ['endereco'], type: 'object', presence: 'optional', sources: ['start'] },
  { path: ['itens'], type: 'list<text>', presence: 'optional', sources: ['start'] },
  { path: ['vence'], type: 'date', presence: 'definite', sources: ['start'] },
];

@Component({
  imports: [OperandEditor],
  template: `<chain-operand-editor [(operand)]="operand" [type]="type()" [catalog]="catalog" [optional]="optional()" pathLabel="Dado" />`,
})
class Host {
  readonly operand = signal<Operand | null>(null);
  readonly type = signal('text');
  readonly optional = signal(true);
  readonly catalog = CATALOG;
}

/** A catalog whose types have no label (card #201). */
@Component({
  imports: [OperandEditor],
  template: `<chain-operand-editor [(operand)]="operand" type="unknown" [catalog]="catalog" [optional]="false" pathLabel="Dado" />`,
})
class OddTypesHost {
  readonly operand = signal<Operand | null>(null);
  readonly catalog: CatalogEntry[] = [
    { path: ['estranho'], type: 'constructor', presence: 'definite', sources: ['start'] },
    { path: ['outro'], type: '__proto__', presence: 'definite', sources: ['start'] },
  ];
}

/** A catalog with sensitive keys; a nested entry follows its top-level key (sensitive-data.md §2). */
@Component({
  imports: [OperandEditor],
  template: `<chain-operand-editor [(operand)]="operand" type="unknown" [catalog]="catalog" [optional]="false" pathLabel="Dado" />`,
})
class SensitiveHost {
  readonly operand = signal<Operand | null>(null);
  readonly catalog: CatalogEntry[] = [
    { path: ['cpf'], type: 'text', presence: 'definite', sources: ['start'], sensitive: true },
    { path: ['renda', 'mensal'], type: 'number', presence: 'definite', sources: ['start'], sensitive: true },
    { path: ['nome'], type: 'text', presence: 'definite', sources: ['start'] },
  ];
}

async function build(type: string, optional = true) {
  const view = await render(Host);
  view.fixture.componentInstance.type.set(type);
  view.fixture.componentInstance.optional.set(optional);
  view.fixture.detectChanges();
  const host = view.fixture.componentInstance;
  /** Changes the type the value should have, as a new row would. */
  const retype = (next: string) => {
    host.type.set(next);
    view.fixture.detectChanges();
  };
  return { host, retype, user: userEvent.setup() };
}

const optionsOf = (name: string) => within(screen.getByRole('combobox', { name })).getAllByRole('option').map((option) => option.textContent!.trim());

describe('OperandEditor (workflow-editor.md §10.7–§10.9)', () => {
  it('offers Não enviar when it may be left out, a value only for types that have one, and the data of its type', async () => {
    const { host, user } = await build('text');
    expect(optionsOf('Tipo do valor')).toEqual(['Não enviar', 'Valor', 'Dado']);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tipo do valor' }), 'path');
    expect(optionsOf('Dado')).toEqual(['Escolha o dado', 'cpf (texto)']);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tipo do valor' }), 'none');
    expect(host.operand()).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Dado' })).toBeNull();
  });

  it('takes an object or a list only from the data, and any datum for an unknown type', async () => {
    const object = await build('object');
    expect(optionsOf('Tipo do valor')).toEqual(['Não enviar', 'Dado']);
    await object.user.selectOptions(screen.getByRole('combobox', { name: 'Tipo do valor' }), 'path');
    expect(optionsOf('Dado')).toEqual(['Escolha o dado', 'endereco (objeto)']);
    object.retype('list<text>');
    expect(optionsOf('Tipo do valor')).toEqual(['Não enviar', 'Dado']);
    expect(optionsOf('Dado')).toEqual(['Escolha o dado', 'itens (lista de textos)']);
  });

  it('takes any datum, or a text, for an unknown type, and the current date with an adjustment for a date', async () => {
    const unknown = await build('unknown', false);
    expect(optionsOf('Tipo do valor')).toEqual(['Valor', 'Dado', 'Sistema']); // any value fits, the current date too
    await unknown.user.selectOptions(screen.getByRole('combobox', { name: 'Tipo do valor' }), 'system');
    expect(optionsOf('Valor do sistema')).toEqual(['Data atual', 'Data e hora atual']);
    await unknown.user.selectOptions(screen.getByRole('combobox', { name: 'Tipo do valor' }), 'path');
    expect(optionsOf('Dado')).toEqual(['Escolha o dado', 'cpf (texto)', 'endereco (objeto)', 'itens (lista de textos)', 'vence (data)']);
    unknown.retype('date');
    await unknown.user.selectOptions(screen.getByRole('combobox', { name: 'Tipo do valor' }), 'system');
    expect(unknown.host.operand()).toEqual({ kind: 'system', name: 'currentDate' });
    await unknown.user.selectOptions(within(screen.getByRole('group', { name: 'Ajuste do valor' })).getByRole('combobox', { name: 'Ajuste' }), '+');
    await unknown.user.type(screen.getByRole('textbox', { name: 'Quantidade' }), '2');
    expect(unknown.host.operand()).toEqual({ kind: 'system', name: 'currentDate', offset: { sign: '+', amount: '2', unit: 'days' } });
  });

  it('marks the sensitive data in the list, as the catalog flags them (sensitive-data.md §10)', async () => {
    await render(SensitiveHost);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tipo do valor' }), 'path');

    expect(optionsOf('Dado')).toEqual(['Escolha o dado', 'cpf (texto, sensível)', 'renda.mensal (número, sensível)', 'nome (texto)']);
  });

  // Card #201: a datum's type comes from the data catalog, so a name every object inherits is shown as it is.
  it('names a datum whose type has no label by the type itself', async () => {
    await render(OddTypesHost);
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Tipo do valor' }), 'path');
    expect(optionsOf('Dado')).toEqual(['Escolha o dado', 'estranho (constructor)', 'outro (__proto__)']);
  });
});
