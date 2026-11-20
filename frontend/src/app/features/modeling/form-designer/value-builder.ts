import { ChangeDetectionStrategy, Component, computed, forwardRef, input, model, signal } from '@angular/core';
import { Button } from '../../../ui/button/button';
import { Input } from '../../../ui/form-field/input';
import { CatalogEntry, Offset, OffsetUnit, fromZoneLocal, toZoneLocal } from '../editor/conditions';
import { OffsetEditor } from '../editor/offset-editor';
import { typeLabel } from '../editor/type-labels';
import { FUNCTIONS, FunctionSpec } from './value-types';

type Kind = '' | 'path' | 'number' | 'text' | 'boolean' | 'date' | 'datetime' | 'time' | 'today' | 'now' | 'call' | 'arithmetic';

const KINDS: readonly { readonly kind: Kind; readonly label: string; readonly composite?: boolean }[] = [
  { kind: '', label: 'Escolha' },
  { kind: 'path', label: 'Dado' },
  { kind: 'number', label: 'Número' },
  { kind: 'text', label: 'Texto' },
  { kind: 'boolean', label: 'Verdadeiro ou falso' },
  { kind: 'date', label: 'Data' },
  { kind: 'datetime', label: 'Data e hora' },
  { kind: 'time', label: 'Hora' },
  { kind: 'today', label: 'Hoje' },
  { kind: 'now', label: 'Agora' },
  { kind: 'call', label: 'Função', composite: true },
  { kind: 'arithmetic', label: 'Conta', composite: true },
];
const OPERATIONS: readonly { readonly op: string; readonly symbol: string }[] = [
  { op: 'add', symbol: '+' },
  { op: 'subtract', symbol: '−' },
  { op: 'multiply', symbol: '×' },
  { op: 'divide', symbol: '÷' },
];
const OTHER = '#outro';
const MAX_DEPTH = 4;
const MAX_OFFSET = 10_000;
const DATE_UNITS: readonly OffsetUnit[] = ['days', 'months', 'years'];
const DATETIME_UNITS: readonly OffsetUnit[] = ['days', 'months', 'years', 'hours', 'minutes'];

type Node = Record<string, unknown>;

/**
 * The value builder of computed fields (form-designer.md §12.6, Q-FD6 (a)), made from the condition builder's operands: a
 * datum of the form or of the request, a value, today or now with an adjustment, a function of expression-language.md §3b,
 * or an arithmetic step. It writes the ADR-0003 value tree as it is built; an unfinished one is left for the parser to refuse.
 */
@Component({
  selector: 'chain-value-builder',
  imports: [Button, Input, OffsetEditor, forwardRef(() => ValueBuilder)],
  host: { role: 'group', '[attr.aria-label]': 'label()' },
  template: `
    @let node = asNode(value());
    <select chainInput [attr.aria-label]="label() + ': forma'" (change)="setKind($event)">
      @for (option of kinds(); track option.kind) {
        <option [value]="option.kind" [selected]="option.kind === kind()">{{ option.label }}</option>
      }
    </select>
    @switch (kind()) {
      @case ('path') {
        <select chainInput aria-label="Dado" (change)="setPath($event)">
          <option value="" [selected]="pathValue() === ''">Escolha o dado</option>
          @for (entry of catalog(); track entryValue(entry)) {
            <option [value]="entryValue(entry)" [selected]="entryValue(entry) === pathValue()">{{ entryLabel(entry) }}</option>
          }
          <option [value]="other" [selected]="pathValue() === other">Outro dado do pedido…</option>
        </select>
        @if (pathValue() === other) {
          <input chainInput class="chain-mono" type="text" aria-label="Caminho do dado do pedido" placeholder="cliente.limite" [value]="pathText()" (change)="setOtherPath($event)" />
        }
      }
      @case ('number') {
        <input chainInput type="text" inputmode="decimal" aria-label="Número" [value]="literalText()" (input)="setNumber($event)" />
      }
      @case ('text') {
        <input chainInput type="text" aria-label="Texto" [value]="literalText()" (input)="setLiteral('text', $event)" />
      }
      @case ('boolean') {
        <select chainInput aria-label="Verdadeiro ou falso" (change)="setLiteral('boolean', $event)">
          <option value="" [selected]="literalText() === ''">Escolha</option>
          <option value="true" [selected]="literalText() === 'true'">verdadeiro</option>
          <option value="false" [selected]="literalText() === 'false'">falso</option>
        </select>
      }
      @case ('date') {
        <input chainInput type="date" aria-label="Data" [value]="literalText()" (input)="setLiteral('date', $event)" />
      }
      @case ('datetime') {
        <input chainInput type="datetime-local" aria-label="Data e hora" [value]="zoneLocal()" (input)="setDateTime($event)" />
      }
      @case ('time') {
        <input chainInput type="time" aria-label="Hora" [value]="literalText()" (input)="setLiteral('time', $event)" />
      }
      @case ('call') {
        <select chainInput aria-label="Função" (change)="setFunction($event)">
          @for (spec of functions; track spec.name) {
            <option [value]="spec.name" [selected]="spec.name === node['function']">{{ spec.name }}: {{ spec.label }}</option>
          }
        </select>
        @for (arg of args(); track $index; let i = $index) {
          <chain-value-builder class="chain-value__child" [value]="arg" (valueChange)="setArg(i, $event)" [catalog]="catalog()" [label]="argLabel(i)" [depth]="depth() + 1" />
          @if (removable(i)) {
            <button chainButton variant="ghost" size="sm" type="button" [attr.aria-label]="'Remover o argumento ' + (i + 1)" (click)="removeArg(i)">Remover</button>
          }
        }
        @if (spec(); as current) {
          @if (current.variadic) {
            <button chainButton variant="secondary" size="sm" type="button" (click)="addArg()">+ valor</button>
          } @else if (args().length < current.args.length) {
            <button chainButton variant="secondary" size="sm" type="button" (click)="addArg()">Usar {{ current.args[args().length] }}</button>
          }
        }
      }
      @case ('arithmetic') {
        <chain-value-builder class="chain-value__child" [value]="node['left']" (valueChange)="setSide('left', $event)" [catalog]="catalog()" label="Primeiro termo" [depth]="depth() + 1" />
        <select chainInput aria-label="Operação" (change)="setOperation($event)">
          @for (operation of operations; track operation.op) {
            <option [value]="operation.op" [selected]="operation.op === node['op']">{{ operation.symbol }}</option>
          }
        </select>
        <chain-value-builder class="chain-value__child" [value]="node['right']" (valueChange)="setSide('right', $event)" [catalog]="catalog()" label="Segundo termo" [depth]="depth() + 1" />
      }
    }
    @if (units().length > 0) {
      <chain-offset-editor [label]="label() + ': ajuste'" [units]="units()" [offset]="offset()" (offsetChange)="setOffset($event)" />
      @if (offsetError()) {
        <p class="chain-value__error" role="alert">Use um número inteiro de 0 a 10.000.</p>
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: var(--chain-space-2);
    }

    .chain-value__child {
      flex-basis: 100%;
      padding-inline-start: var(--chain-space-3);
      border-inline-start: var(--chain-border-width-strong) solid var(--color-border-subtle);
    }

    .chain-value__error {
      flex-basis: 100%;
      margin: 0;
      color: var(--color-text-danger);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ValueBuilder {
  readonly value = model<unknown>(undefined);
  readonly catalog = input<readonly CatalogEntry[]>([]);
  readonly label = input.required<string>();
  /** How deep it sits: functions and arithmetic are offered up to four levels. */
  readonly depth = input(0);

  protected readonly functions = FUNCTIONS;
  protected readonly operations = OPERATIONS;
  protected readonly other = OTHER;
  private readonly entered = signal<Offset | null | undefined>(undefined);
  protected readonly offsetError = signal(false);

  protected readonly kinds = computed(() => KINDS.filter((option) => !option.composite || this.depth() < MAX_DEPTH));
  protected readonly kind = computed<Kind>(() => kindOf(this.value()));
  protected readonly spec = computed<FunctionSpec | undefined>(() => FUNCTIONS.find((spec) => spec.name === this.asNode(this.value())['function']));
  protected readonly args = computed<readonly unknown[]>(() => {
    const args = this.asNode(this.value())['args'];
    return Array.isArray(args) ? args : [];
  });
  /** The adjustment's units: a datum of a date or datetime type, or today or now. */
  protected readonly units = computed<readonly OffsetUnit[]>(() => {
    const kind = this.kind();
    if (kind === 'today') {
      return DATE_UNITS;
    }
    if (kind === 'now') {
      return DATETIME_UNITS;
    }
    if (kind === 'path') {
      const type = this.catalog().find((entry) => this.entryValue(entry) === this.pathValue())?.type;
      return type === 'date' ? DATE_UNITS : type === 'datetime' ? DATETIME_UNITS : [];
    }
    return [];
  });
  protected readonly offset = computed<Offset | null>(() => {
    const entered = this.entered();
    if (entered !== undefined) {
      return entered;
    }
    const offset = this.asNode(this.value())['offset'] as { amount: number; unit: OffsetUnit } | undefined;
    return offset ? { sign: offset.amount < 0 ? '-' : '+', amount: String(Math.abs(offset.amount)), unit: offset.unit } : null;
  });

  protected asNode(value: unknown): Node {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Node) : {};
  }

  protected entryValue(entry: CatalogEntry): string {
    return entry.path.join('.');
  }

  protected entryLabel(entry: CatalogEntry): string {
    return `${entry.path.join('.').replace(/\.\[\]/g, '[]')} (${typeLabel(entry.type)})`;
  }

  /** The chosen datum, or *Outro dado do pedido* for a path the catalog lacks or one not typed yet. */
  protected pathValue(): string {
    const node = this.asNode(this.value());
    const path = Array.isArray(node['path']) ? (node['path'] as string[]).join('.') : '';
    return path === '' && node['other'] !== true ? '' : this.catalog().some((entry) => this.entryValue(entry) === path) ? path : OTHER;
  }

  protected pathText(): string {
    const path = this.asNode(this.value())['path'];
    return Array.isArray(path) ? path.join('.') : '';
  }

  protected literalText(): string {
    const value = this.asNode(this.value())['value'];
    return typeof value === 'string' ? value : '';
  }

  protected zoneLocal(): string {
    return toZoneLocal(this.literalText()) ?? '';
  }

  protected argLabel(index: number): string {
    return this.depth() === 0 ? `Argumento ${index + 1}` : `Argumento ${index + 1} de ${this.asNode(this.value())['function']}`;
  }

  protected removable(index: number): boolean {
    const spec = this.spec();
    if (!spec) {
      return false;
    }
    return spec.variadic ? this.args().length > 1 : index >= spec.args.length - (spec.optional ?? 0) && index === this.args().length - 1;
  }

  protected setKind(event: Event): void {
    this.entered.set(undefined);
    this.offsetError.set(false);
    this.value.set(start((event.target as HTMLSelectElement).value as Kind));
  }

  protected setPath(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.entered.set(undefined);
    this.value.set(value === OTHER ? { kind: 'path', path: [], other: true } : { kind: 'path', path: value ? value.split('.') : [] });
  }

  protected setOtherPath(event: Event): void {
    const path = (event.target as HTMLInputElement).value.split('.').map((segment) => segment.trim()).filter((segment) => segment !== '');
    this.value.set(path.length > 0 ? { kind: 'path', path } : { kind: 'path', path: [], other: true });
  }

  /** A number as the expression language reads it: a decimal comma becomes a point (§3b). */
  protected setNumber(event: Event): void {
    this.value.set({ kind: 'literal', type: 'number', value: (event.target as HTMLInputElement).value.trim().replace(',', '.') });
  }

  protected setLiteral(type: string, event: Event): void {
    this.value.set({ kind: 'literal', type, value: (event.target as HTMLInputElement | HTMLSelectElement).value });
  }

  /** A fixed date and time is entered in UTC−03:00, the evaluation zone. */
  protected setDateTime(event: Event): void {
    const local = (event.target as HTMLInputElement).value;
    this.value.set({ kind: 'literal', type: 'datetime', value: local ? fromZoneLocal(local) : '' });
  }

  protected setFunction(event: Event): void {
    const spec = FUNCTIONS.find((candidate) => candidate.name === (event.target as HTMLSelectElement).value)!;
    const kept = this.args().slice(0, spec.args.length - (spec.optional ?? 0));
    const args = [...kept, ...Array.from({ length: spec.args.length - (spec.optional ?? 0) - kept.length }, () => null)];
    this.value.set({ kind: 'call', function: spec.name, args });
  }

  protected setArg(index: number, value: unknown): void {
    this.value.set({ ...this.asNode(this.value()), args: this.args().map((arg, i) => (i === index ? value : arg)) });
  }

  protected addArg(): void {
    this.value.set({ ...this.asNode(this.value()), args: [...this.args(), null] });
  }

  protected removeArg(index: number): void {
    this.value.set({ ...this.asNode(this.value()), args: this.args().filter((_, i) => i !== index) });
  }

  protected setSide(side: 'left' | 'right', value: unknown): void {
    this.value.set({ ...this.asNode(this.value()), [side]: value });
  }

  protected setOperation(event: Event): void {
    this.value.set({ ...this.asNode(this.value()), op: (event.target as HTMLSelectElement).value });
  }

  /** Only a whole quantity up to 10 000 is written; *sem ajuste* removes the adjustment. */
  protected setOffset(offset: Offset | null): void {
    this.entered.set(offset);
    const node = { ...this.asNode(this.value()) };
    delete node['offset'];
    if (offset === null) {
      this.offsetError.set(false);
      this.value.set(node);
      return;
    }
    const amount = /^[0-9]{1,5}$/.test(offset.amount) ? Number(offset.amount) : NaN;
    this.offsetError.set(!(amount <= MAX_OFFSET));
    if (amount <= MAX_OFFSET) {
      this.value.set({ ...node, offset: { amount: offset.sign === '-' ? -amount : amount, unit: offset.unit } });
    }
  }
}

function kindOf(value: unknown): Kind {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const node = value as Node;
  switch (node['kind']) {
    case 'path':
      return 'path';
    case 'literal':
      return (['number', 'text', 'boolean', 'date', 'datetime', 'time'] as const).find((type) => type === node['type']) ?? 'text';
    case 'system':
      return node['name'] === 'currentDate' ? 'today' : 'now';
    case 'call':
      return 'call';
    case 'arithmetic':
      return 'arithmetic';
    default:
      return '';
  }
}

/** A new node of a kind: what the builder fills in next. */
function start(kind: Kind): unknown {
  switch (kind) {
    case 'path':
      return { kind: 'path', path: [] };
    case 'number':
    case 'text':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'time':
      return { kind: 'literal', type: kind, value: '' };
    case 'today':
      return { kind: 'system', name: 'currentDate' };
    case 'now':
      return { kind: 'system', name: 'currentDateTime' };
    case 'call':
      return { kind: 'call', function: 'sum', args: [null] };
    case 'arithmetic':
      return { kind: 'arithmetic', op: 'add', left: null, right: null };
    default:
      return undefined;
  }
}
