import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { RelativeBound } from '../../../forms/model';
import { Input } from '../../../ui/form-field/input';
import { Offset, OffsetUnit, fromZoneLocal, toZoneLocal } from '../editor/conditions';
import { OffsetEditor } from '../editor/offset-editor';

export type DateType = 'date' | 'time' | 'datetime';
export type DateBound = string | RelativeBound;

const MAX_OFFSET = 10_000;
const DATE_UNITS: readonly OffsetUnit[] = ['days', 'months', 'years'];
const DATETIME_UNITS: readonly OffsetUnit[] = ['days', 'months', 'years', 'hours', 'minutes'];
const FIXED: Readonly<Record<DateType, string>> = { date: 'Data fixa', time: 'Hora fixa', datetime: 'Data e hora fixa' };
const INPUT: Readonly<Record<DateType, string>> = { date: 'date', time: 'time', datetime: 'datetime-local' };

/**
 * One date limit of Validação (form-designer.md §8.1): none, a fixed value, or *Hoje* or *Agora* moved by an adjustment
 * (forms.md F1, ADR-0003 §2). A time has fixed limits only, as the server requires (FM004). A fixed datetime is entered in
 * UTC−03:00, the evaluation zone. Only valid limits are emitted.
 */
@Component({
  selector: 'chain-date-bound',
  imports: [Input, OffsetEditor],
  host: { role: 'group', '[attr.aria-label]': 'label()' },
  template: `
    <select chainInput [attr.aria-label]="label() + ': limite'" (change)="setKind($event)">
      <option value="none" [selected]="kind() === 'none'">Sem limite</option>
      <option value="fixed" [selected]="kind() === 'fixed'">{{ fixedName() }}</option>
      @if (type() !== 'time') {
        <option value="relative" [selected]="kind() === 'relative'">{{ type() === 'date' ? 'Hoje' : 'Agora' }}</option>
      }
    </select>
    @if (kind() === 'fixed') {
      <input chainInput [type]="inputType()" [attr.aria-label]="label() + ': valor'" [value]="fixedValue()" (change)="setFixed($event)" />
    }
    @if (kind() === 'relative') {
      <chain-offset-editor [label]="label() + ': ajuste'" [units]="units()" [offset]="offset()" (offsetChange)="setOffset($event)" />
      @if (offsetError()) {
        <p class="chain-date-bound__error" role="alert">Use um número inteiro de 0 a 10.000.</p>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--chain-space-2);
    }

    .chain-date-bound__error {
      grid-column: 1 / -1;
      margin: 0;
      color: var(--color-text-danger);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DateBoundEditor {
  readonly type = input.required<DateType>();
  readonly label = input.required<string>();
  readonly bound = input<DateBound | undefined>(undefined);
  readonly changed = output<DateBound | undefined>();

  /** The kind chosen before it has a value: a fixed limit is only emitted once it is entered. */
  private readonly chosen = signal<'none' | 'fixed' | 'relative' | null>(null);
  /** The adjustment as entered, which may be incomplete. */
  private readonly entered = signal<Offset | null | undefined>(undefined);
  protected readonly offsetError = signal(false);

  protected readonly kind = computed(() => {
    const bound = this.bound();
    return this.chosen() ?? (bound === undefined ? 'none' : typeof bound === 'string' ? 'fixed' : 'relative');
  });
  protected readonly fixedName = computed(() => FIXED[this.type()]);
  protected readonly inputType = computed(() => INPUT[this.type()]);
  protected readonly units = computed(() => (this.type() === 'date' ? DATE_UNITS : DATETIME_UNITS));
  protected readonly fixedValue = computed(() => {
    const bound = this.bound();
    if (typeof bound !== 'string') {
      return '';
    }
    return this.type() === 'datetime' ? (toZoneLocal(bound) ?? '') : bound;
  });
  protected readonly offset = computed<Offset | null>(() => {
    const entered = this.entered();
    if (entered !== undefined) {
      return entered;
    }
    const bound = this.bound();
    const offset = typeof bound === 'object' ? bound.offset : undefined;
    return offset ? { sign: offset.amount < 0 ? '-' : '+', amount: String(Math.abs(offset.amount)), unit: offset.unit } : null;
  });

  protected setKind(event: Event): void {
    const kind = (event.target as HTMLSelectElement).value as 'none' | 'fixed' | 'relative';
    this.chosen.set(kind);
    this.entered.set(undefined);
    this.offsetError.set(false);
    if (kind === 'none') {
      this.changed.emit(undefined);
    } else if (kind === 'relative') {
      this.changed.emit({ system: this.system() });
    }
  }

  protected setFixed(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (value === '') {
      return;
    }
    this.changed.emit(this.type() === 'datetime' ? fromZoneLocal(value) : value);
  }

  protected setOffset(offset: Offset | null): void {
    this.entered.set(offset);
    if (offset === null) {
      this.offsetError.set(false);
      this.changed.emit({ system: this.system() });
      return;
    }
    const amount = /^[0-9]{1,5}$/.test(offset.amount) ? Number(offset.amount) : NaN;
    this.offsetError.set(!(amount <= MAX_OFFSET));
    if (amount <= MAX_OFFSET) {
      this.changed.emit({ system: this.system(), offset: { amount: offset.sign === '-' ? -amount : amount, unit: offset.unit } });
    }
  }

  private system(): RelativeBound['system'] {
    return this.type() === 'date' ? 'currentDate' : 'currentDateTime';
  }
}
