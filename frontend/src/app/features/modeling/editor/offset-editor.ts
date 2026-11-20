import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { Input } from '../../../ui/form-field/input';
import { OFFSET_UNIT, Offset, OffsetUnit } from './conditions';

/**
 * A date's or a datetime's adjustment (workflow-editor.md §10.8): *sem ajuste*, *mais* or *menos*, then a quantity and a unit.
 * It is a group named by `label`, on a line of its own in a comparison's or a mapping's grid.
 */
@Component({
  selector: 'chain-offset-editor',
  imports: [Input],
  host: { role: 'group', '[attr.aria-label]': 'label()' },
  template: `
    <select chainInput aria-label="Ajuste" (change)="setSign($event)">
      <option value="" [selected]="!offset()">sem ajuste</option>
      <option value="+" [selected]="offset()?.sign === '+'">mais</option>
      <option value="-" [selected]="offset()?.sign === '-'">menos</option>
    </select>
    @if (offset(); as current) {
      <input chainInput type="text" inputmode="numeric" aria-label="Quantidade" [value]="current.amount" (input)="setAmount($event)" />
      <select chainInput aria-label="Unidade" (change)="setUnit($event)">
        @for (unit of units(); track unit) {
          <option [value]="unit" [selected]="unit === current.unit">{{ unitName(unit) }}</option>
        }
      </select>
    }
  `,
  styles: `
    :host {
      grid-column: 1 / 3;
      display: flex;
      gap: var(--chain-space-2);
    }

    .chain-input {
      flex: 1 1 0;
      min-width: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OffsetEditor {
  readonly offset = model<Offset | null>(null);
  /** The units the operand's type takes (§10.8). */
  readonly units = input.required<readonly OffsetUnit[]>();
  readonly label = input.required<string>();

  protected unitName(unit: OffsetUnit): string {
    return OFFSET_UNIT[unit][1];
  }

  /** *Sem ajuste* removes the adjustment; *mais* or *menos* sets its sign, starting with no quantity, in days. */
  protected setSign(event: Event): void {
    const sign = (event.target as HTMLSelectElement).value;
    const current = this.offset();
    this.offset.set(sign === '+' || sign === '-' ? { sign, amount: current?.amount ?? '', unit: current?.unit ?? 'days' } : null);
  }

  protected setAmount(event: Event): void {
    const current = this.offset();
    if (current) {
      this.offset.set({ ...current, amount: (event.target as HTMLInputElement).value });
    }
  }

  protected setUnit(event: Event): void {
    const current = this.offset();
    if (current) {
      this.offset.set({ ...current, unit: (event.target as HTMLSelectElement).value as OffsetUnit });
    }
  }
}
