import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FieldOption } from '../../../forms/model';
import { Button } from '../../../ui/button/button';
import { Input } from '../../../ui/form-field/input';
import { MAX_OPTIONS } from './form-checks';
import { keyFromLabel, uniqueKey } from './form-keys';
import { formProblemText } from './form-messages';

/** The options and, for each, whether its value still follows its label. */
export interface OptionsChange {
  readonly options: readonly FieldOption[];
  readonly follows: readonly boolean[];
}

/**
 * Opções (form-designer.md §8.1): a label and a value per option. A new option's value comes from its label until the value is
 * edited, as keys do (§8.2). Options can be added, moved and removed, down to one; repeated values show FM003.
 */
@Component({
  selector: 'chain-options-editor',
  imports: [Button, Input],
  template: `
    <ol class="chain-options">
      @for (option of options(); track $index; let i = $index; let first = $first; let last = $last) {
        <li class="chain-options__row" role="group" [attr.aria-label]="'Opção ' + (i + 1)">
          <input chainInput type="text" aria-label="Rótulo" [value]="option.label" (change)="setLabel(i, $event)" />
          <input chainInput class="chain-mono" type="text" aria-label="Valor" [value]="option.value" (change)="setValue(i, $event)" />
          <div class="chain-options__actions">
            <button chainButton variant="ghost" size="sm" type="button" [disabled]="first" [attr.aria-label]="'Mover a opção ' + option.label + ' para cima'" (click)="move(i, -1)">↑</button>
            <button chainButton variant="ghost" size="sm" type="button" [disabled]="last" [attr.aria-label]="'Mover a opção ' + option.label + ' para baixo'" (click)="move(i, 1)">↓</button>
            <button chainButton variant="ghost" size="sm" type="button" [disabled]="options().length === 1" [attr.aria-label]="'Remover a opção ' + option.label" (click)="remove(i)">Remover</button>
          </div>
        </li>
      }
    </ol>
    @if (problem(); as text) {
      <p class="chain-options__problem" role="alert">{{ text }}</p>
    }
    <button chainButton variant="secondary" size="sm" type="button" [disabled]="options().length >= max" (click)="add()">Adicionar opção</button>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--chain-space-2);
    }

    .chain-options {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-2);
      align-self: stretch;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chain-options__row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--chain-space-1) var(--chain-space-2);
    }

    .chain-options__actions {
      grid-column: 1 / -1;
      display: flex;
      justify-content: flex-end;
      gap: var(--chain-space-1);
    }

    .chain-options__problem {
      margin: 0;
      color: var(--color-text-danger);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OptionsEditor {
  readonly options = input.required<readonly FieldOption[]>();
  /** Absent for options that were loaded: their values don't follow their labels. */
  readonly follows = input<readonly boolean[] | undefined>(undefined);
  readonly changed = output<OptionsChange>();

  protected readonly max = MAX_OPTIONS;
  protected readonly problem = computed(() => {
    const options = this.options();
    const values = new Set(options.map((option) => option.value));
    return options.length === 0 || options.length > MAX_OPTIONS || values.size !== options.length ? formProblemText('FM003') : null;
  });

  protected setLabel(index: number, event: Event): void {
    const label = (event.target as HTMLInputElement).value;
    const follows = this.flags();
    this.emit(
      this.options().map((option, i) =>
        i !== index ? option : { value: follows[i] ? uniqueKey(keyFromLabel(label), this.valuesExcept(i)) : option.value, label },
      ),
      follows,
    );
  }

  protected setValue(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.emit(
      this.options().map((option, i) => (i === index ? { ...option, value } : option)),
      this.flags().map((follow, i) => (i === index ? false : follow)),
    );
  }

  protected add(): void {
    const label = `Opção ${this.options().length + 1}`;
    const value = uniqueKey(keyFromLabel(label), new Set(this.options().map((option) => option.value)));
    this.emit([...this.options(), { value, label }], [...this.flags(), true]);
  }

  protected move(index: number, by: -1 | 1): void {
    const swap = <T>(list: readonly T[]): T[] => {
      const next = [...list];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    };
    this.emit(swap(this.options()), swap(this.flags()));
  }

  protected remove(index: number): void {
    this.emit(
      this.options().filter((_, i) => i !== index),
      this.flags().filter((_, i) => i !== index),
    );
  }

  private flags(): boolean[] {
    const follows = this.follows();
    return this.options().map((_, i) => follows?.[i] === true);
  }

  private valuesExcept(index: number): Set<string> {
    return new Set(this.options().flatMap((option, i) => (i === index ? [] : [option.value])));
  }

  private emit(options: readonly FieldOption[], follows: readonly boolean[]): void {
    this.changed.emit({ options, follows });
  }
}
