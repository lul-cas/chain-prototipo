import {
  ChangeDetectionStrategy,
  Component,
  InjectionToken,
  ViewEncapsulation,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';
import { LucideCircleAlert } from '@lucide/angular';

let nextId = 0;

/** What a control inside a form field needs from it (see Input). */
export interface FormFieldContext {
  readonly controlId: string;
  readonly describedBy: () => string | null;
  readonly invalid: () => boolean;
  readonly required: () => boolean;
}

export const FORM_FIELD = new InjectionToken<FormFieldContext>('chain.FormField');

/**
 * Label, hint, control and error message as one accessible unit (design-system.md §4.2).
 * The control is a projected native element carrying `chainInput`; the field links it to
 * its label and to its hint and error through ids, `aria-describedby` and `aria-invalid`.
 */
@Component({
  selector: 'chain-form-field',
  imports: [LucideCircleAlert],
  template: `
    <div class="chain-form-field__header">
      <label class="chain-form-field__label" [attr.for]="controlId">{{ label() }}</label>
      @if (required()) {
        <span class="chain-form-field__required" aria-hidden="true">obrigatório</span>
      }
    </div>
    @if (hint()) {
      <p class="chain-form-field__hint" [id]="hintId">{{ hint() }}</p>
    }
    <div class="chain-form-field__control"><ng-content /></div>
    <p class="chain-form-field__error" [id]="errorId" aria-live="polite">
      @if (error()) {
        <svg lucideCircleAlert aria-hidden="true"></svg>
        <span>{{ error() }}</span>
      }
    </p>
  `,
  styleUrl: './form-field.css',
  // Styles reach the projected native control, so they are global but scoped by class.
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'chain-form-field',
    '[class.chain-form-field--invalid]': 'invalid()',
  },
  providers: [{ provide: FORM_FIELD, useExisting: FormField }],
})
export class FormField implements FormFieldContext {
  readonly label = input.required<string>();
  readonly hint = input<string | null>(null);
  /** Error text to show; null or empty means valid. Server errors take precedence over client ones (ADR-0010 D4). */
  readonly error = input<string | null>(null);
  readonly required = input(false, { transform: booleanAttribute });

  private readonly id = nextId++;
  readonly controlId = `chain-field-${this.id}`;
  protected readonly hintId = `chain-field-${this.id}-hint`;
  protected readonly errorId = `chain-field-${this.id}-error`;

  readonly invalid = computed(() => !!this.error());
  readonly describedBy = computed(() => {
    const ids = [this.hint() ? this.hintId : null, this.invalid() ? this.errorId : null].filter(Boolean);
    return ids.length ? ids.join(' ') : null;
  });
}
