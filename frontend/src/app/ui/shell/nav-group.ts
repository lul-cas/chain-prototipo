import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let nextId = 0;

/**
 * A labelled group of navigation links, such as *Administração* (automation-ui.md §2, Q-AS2 (a)). The label names the group
 * for screen readers; the links inside are `chainNavItem`s.
 */
@Component({
  selector: 'chain-nav-group',
  template: `
    <p class="chain-nav-group__label" [id]="labelId">{{ label() }}</p>
    <div class="chain-nav-group__items" role="group" [attr.aria-labelledby]="labelId">
      <ng-content />
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-hairline);
      margin-block-start: var(--chain-space-4);
    }

    .chain-nav-group__label {
      margin: 0;
      padding: 0 var(--chain-space-3) var(--chain-space-1);
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
      font-weight: var(--chain-font-weight-semibold);
    }

    .chain-nav-group__items {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-hairline);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NavGroup {
  readonly label = input.required<string>();
  protected readonly labelId = `chain-nav-group-${++nextId}`;
}
