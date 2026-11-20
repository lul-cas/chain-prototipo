import { Directive, inject } from '@angular/core';
import { FORM_FIELD } from './form-field';

/**
 * Marks the native control of a `chain-form-field` (`input`, `textarea` or `select`).
 * Native elements keep native behavior: reactive forms, autocomplete, mobile keyboards, and
 * the browser's own date and time pickers (ADR-0010 D2.4).
 */
@Directive({
  selector: 'input[chainInput], textarea[chainInput], select[chainInput]',
  host: {
    class: 'chain-input',
    '[id]': 'field?.controlId',
    '[attr.aria-describedby]': 'field?.describedBy()',
    '[attr.aria-invalid]': 'field?.invalid() ? "true" : null',
    '[attr.aria-required]': 'field?.required() ? "true" : null',
  },
})
export class Input {
  protected readonly field = inject(FORM_FIELD, { optional: true });
}
