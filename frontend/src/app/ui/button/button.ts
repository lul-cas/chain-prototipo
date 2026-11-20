import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, booleanAttribute, inject, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

/**
 * Chain button, applied to a native `<button>` or `<a>` (design-system.md §4.1).
 *
 * `loading` marks a command in flight: the button keeps its focus and name, announces that it is
 * busy, and swallows clicks, so the same intent is not sent twice (ADR-0010 D4).
 */
@Component({
  selector: 'button[chainButton], a[chainButton]',
  template: `
    @if (loading()) {
      <span class="chain-button__spinner" aria-hidden="true"></span>
    }
    <span class="chain-button__label"><ng-content /></span>
    @if (loading()) {
      <span class="chain-visually-hidden">, processando</span>
    }
  `,
  styleUrl: './button.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'chain-button',
    '[class.chain-button--primary]': 'variant() === "primary"',
    '[class.chain-button--secondary]': 'variant() === "secondary"',
    '[class.chain-button--ghost]': 'variant() === "ghost"',
    '[class.chain-button--danger]': 'variant() === "danger"',
    '[class.chain-button--sm]': 'size() === "sm"',
    '[class.chain-button--loading]': 'loading()',
    '[attr.aria-disabled]': 'loading() ? "true" : null',
    '[attr.aria-busy]': 'loading() ? "true" : null',
  },
})
export class Button {
  readonly variant = input<ButtonVariant>('primary');
  readonly size = input<ButtonSize>('md');
  readonly loading = input(false, { transform: booleanAttribute });

  constructor() {
    // A capture listener on the element itself runs before the click handlers bound in the
    // consumer's template, so it can stop them while a command is in flight.
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const guard = (event: Event) => {
      if (this.loading()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    element.addEventListener('click', guard, { capture: true });
    inject(DestroyRef).onDestroy(() => element.removeEventListener('click', guard, { capture: true }));
  }
}
