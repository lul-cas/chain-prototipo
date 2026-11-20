import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@angular/aria/menu';
import { Button } from '../../../ui/button/button';

/** An entry of an *Inserir* menu (automation-ui.md §7.3, §7.8). */
export interface InsertChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string | null;
  /** Why it can't be chosen: it is listed, but not chosen. */
  readonly refusal?: string | null;
}

/**
 * **Inserir entrada** and **Inserir credencial** (automation-ui.md §7.3, §7.8): a button that opens a menu of choices, built on
 * `@angular/aria`'s menu (design-system.md §7), which gives the roles, the arrow keys, typeahead and Escape. A choice that
 * can't be taken stays in the list with its reason. Choosing one emits its value; the field it writes into takes the focus.
 */
@Component({
  selector: 'chain-insert-menu',
  imports: [Button, Menu, MenuContent, MenuItem, MenuTrigger],
  template: `
    <button chainButton variant="secondary" size="sm" type="button" ngMenuTrigger [menu]="menu" [attr.aria-label]="label() + (target() ? ' em ' + target() : '')">
      {{ label() }}
    </button>
    <div ngMenu #menu="ngMenu" class="chain-insert__menu" [attr.aria-label]="label()" (itemSelected)="choose($event)">
      <ng-template ngMenuContent>
        @for (choice of choices(); track choice.value) {
          <div ngMenuItem class="chain-insert__item" [value]="choice.value" [disabled]="!!choice.refusal">
            <span class="chain-insert__label">{{ choice.label }}</span>
            @if (choice.hint) {
              <span class="chain-insert__hint"><span class="chain-visually-hidden">, </span>{{ choice.hint }}</span>
            }
            @if (choice.refusal) {
              <span class="chain-insert__refusal"><span class="chain-visually-hidden">. </span>{{ choice.refusal }}</span>
            }
          </div>
        } @empty {
          <div ngMenuItem class="chain-insert__item" value="" [disabled]="true">{{ empty() }}</div>
        }
      </ng-template>
    </div>
  `,
  styleUrl: './insert-menu.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'chain-insert' },
})
export class InsertMenu {
  /** The button's text, such as "Inserir entrada". */
  readonly label = input.required<string>();
  /** What the button inserts into, for its accessible name: "Inserir entrada em Caminho". */
  readonly target = input<string | null>(null);
  readonly choices = input.required<readonly InsertChoice[]>();
  /** What the menu says when there is nothing to choose. */
  readonly empty = input('Nada para inserir.');
  readonly chosen = output<string>();

  protected choose(value: string | undefined): void {
    const choice = this.choices().find((candidate) => candidate.value === value);
    if (choice && !choice.refusal) {
      this.chosen.emit(choice.value);
    }
  }
}
