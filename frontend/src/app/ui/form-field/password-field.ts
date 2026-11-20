import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewEncapsulation,
  contentChild,
  inject,
  input,
  signal,
} from '@angular/core';
import { LucideEye, LucideEyeOff } from '@lucide/angular';
import { FORM_FIELD } from './form-field';
import { Input } from './input';

/**
 * Wraps a password `<input chainInput>` and adds a show/hide toggle (design-system.md §4.3).
 * The toggle is a toggle button: a constant name ("Mostrar senha", or `toggleLabel`) plus `aria-pressed`.
 */
@Component({
  selector: 'chain-password-field',
  imports: [LucideEye, LucideEyeOff],
  template: `
    <ng-content />
    <button
      type="button"
      class="chain-password-field__toggle"
      [attr.aria-pressed]="visible()"
      [attr.aria-controls]="field?.controlId ?? null"
      (click)="toggle()"
    >
      @if (visible()) {
        <svg lucideEyeOff aria-hidden="true"></svg>
      } @else {
        <svg lucideEye aria-hidden="true"></svg>
      }
      <span class="chain-visually-hidden">{{ toggleLabel() }}</span>
    </button>
  `,
  styleUrl: './password-field.css',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'chain-password-field' },
})
export class PasswordField {
  private readonly input = contentChild.required(Input, { read: ElementRef<HTMLInputElement> });
  /** The toggle's name: "Mostrar valor" for a credential (automation-ui.md §4.2). */
  readonly toggleLabel = input('Mostrar senha');
  protected readonly visible = signal(false);
  protected readonly field = inject(FORM_FIELD, { optional: true });

  protected toggle(): void {
    this.visible.update((v) => !v);
    this.input().nativeElement.type = this.visible() ? 'text' : 'password';
  }
}
