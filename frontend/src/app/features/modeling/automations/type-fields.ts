import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { typeLabel } from '../editor/type-labels';
import { NAMED_TYPES } from './automation-checks';
import { SectionControl } from './section-control';

/** The type control's choices (automation-ui.md §7.2), named as `type-labels.ts` names them; a list's items are chosen apart. */
const TYPE_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'text', label: 'Texto' },
  { value: 'number', label: 'Número' },
  { value: 'boolean', label: 'Sim ou não' },
  { value: 'date', label: 'Data' },
  { value: 'datetime', label: 'Data e hora' },
  { value: 'time', label: 'Hora' },
  { value: 'object', label: 'Objeto' },
  { value: 'list', label: 'Lista de…' },
  { value: 'unknown', label: 'Desconhecido (aceita qualquer valor)' },
];
/** A list's items, as the end of a list's name in `type-labels.ts`: "textos", "números"… */
const ITEM_CHOICES = NAMED_TYPES.map((type) => ({
  value: type,
  label: typeLabel(`list<${type}>`).replace(/^lista de /, ''),
}));
const LIST = /^list<(.+)>$/;

/**
 * **Tipo**, and **Itens da lista** for a list (automation-ui.md §7.2, §7.4), for an input or an output. A type no control
 * offers, such as `list<list<text>>`, is kept and shown as it is until another is chosen (§7.7). The fields join the row's
 * layout, since the host takes no box.
 */
@Component({
  selector: 'chain-type-fields',
  imports: [FormField, Input, SectionControl],
  template: `
    <chain-form-field label="Tipo" [error]="problem()">
      <select chainInput [chainControl]="control()" (change)="choose($event)">
        @if (choice() === null) {
          <option [value]="type()" selected>{{ type() || '(vazio)' }} (não editável)</option>
        }
        @for (option of typeChoices; track option.value) {
          <option [value]="option.value" [selected]="option.value === choice()">
            {{ option.label }}
          </option>
        }
      </select>
    </chain-form-field>
    @if (choice() === 'list') {
      <chain-form-field label="Itens da lista">
        <select chainInput (change)="chooseItems($event)">
          @for (item of itemChoices; track item.value) {
            <option [value]="item.value" [selected]="item.value === items()">
              {{ item.label }}
            </option>
          }
        </select>
      </chain-form-field>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class TypeFields {
  readonly type = input.required<string>();
  /** The path its problems name, such as `inputs[0].type` (§8.2). */
  readonly control = input.required<string>();
  readonly problem = input<string | null>(null);
  readonly changed = output<string>();

  protected readonly typeChoices = TYPE_CHOICES;
  protected readonly itemChoices = ITEM_CHOICES;
  private readonly list = computed(() => LIST.exec(this.type())?.[1]);
  /** One of `TYPE_CHOICES`, or null for a type no control offers. */
  protected readonly choice = computed(() => {
    const list = this.list();
    return NAMED_TYPES.includes(this.type())
      ? this.type()
      : list !== undefined && NAMED_TYPES.includes(list)
        ? 'list'
        : null;
  });
  protected readonly items = computed(() => (this.choice() === 'list' ? this.list()! : null));

  /** *Lista de…* starts as a list of texts. */
  protected choose(event: Event): void {
    const choice = (event.target as HTMLSelectElement).value;
    this.changed.emit(choice === 'list' ? 'list<text>' : choice);
  }

  protected chooseItems(event: Event): void {
    this.changed.emit(`list<${(event.target as HTMLSelectElement).value}>`);
  }
}
