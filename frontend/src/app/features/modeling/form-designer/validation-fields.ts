import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { formatNumber } from '../../../expression/decimal';
import { ComponentType, FieldValidation, FormComponent } from '../../../forms/model';
import { parseNumberInput } from '../../../forms/numbers';
import { firstRefused } from '../../../forms/pattern-subset';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { DateBound, DateBoundEditor, DateType } from './date-bound-editor';
import { ACCEPTED_TYPES, MAX_FILES, compiles } from './form-checks';
import { formProblemText } from './form-messages';

type Rule = keyof FieldValidation;

const REQUIRABLE = new Set<ComponentType>(['text', 'textarea', 'number', 'date', 'time', 'datetime', 'checkbox', 'select', 'radio', 'checklist', 'file']);
const FORMATS: readonly { readonly value: string; readonly name: string }[] = [
  { value: '', name: 'Nenhum' },
  { value: 'email', name: 'E-mail' },
  { value: 'cpf', name: 'CPF' },
  { value: 'cnpj', name: 'CNPJ' },
  { value: 'phone', name: 'Telefone' },
  { value: 'cep', name: 'CEP' },
  { value: 'pattern', name: 'Padrão' },
];
/** The allowlist of ADR-0014 §5 by family, as *Tipos aceitos* offers it (§8.1). */
const FAMILIES: readonly { readonly name: string; readonly types: readonly string[] }[] = [
  { name: 'PDF', types: ['application/pdf'] },
  { name: 'Imagens', types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
  { name: 'Texto e CSV', types: ['text/plain', 'text/csv'] },
  { name: 'Office', types: ACCEPTED_TYPES.filter((type) => type.includes('openxmlformats')) },
  { name: 'OpenDocument', types: ACCEPTED_TYPES.filter((type) => type.includes('opendocument')) },
];
const WHOLE = 'Use um número inteiro, 0 ou maior.';
const DECIMAL = 'Use um número, com vírgula antes das casas decimais.';
const ORDER = 'O máximo não pode ser menor que o mínimo.';

/**
 * Validação (form-designer.md §8.1, N3d): the rules each type takes, as forms.md F1 names them. A field applies when it loses
 * the focus, and a choice at once. An entry that is not a number for its rule is refused at its field; a minimum above its
 * maximum applies and shows at the maximum, as FM004 does on the card.
 */
@Component({
  selector: 'chain-validation-fields',
  imports: [DateBoundEditor, FormField, Input],
  template: `
    @let v = rules();
    @if (requirable()) {
      <label class="chain-rules__check">
        <input type="checkbox" [checked]="v.required === true" (change)="set('required', checked($event) ? true : undefined)" />
        Obrigatório
      </label>
    }
    @switch (type()) {
      @case ('number') {
        <div class="chain-rules__pair">
          <chain-form-field label="Mínimo" [error]="error('min')">
            <input chainInput type="text" inputmode="decimal" [value]="decimalText(v.min)" (change)="setDecimal('min', $event)" />
          </chain-form-field>
          <chain-form-field label="Máximo" [error]="error('max') ?? order(v.min, v.max)">
            <input chainInput type="text" inputmode="decimal" [value]="decimalText(v.max)" (change)="setDecimal('max', $event)" />
          </chain-form-field>
        </div>
        <div class="chain-rules__pair">
          <chain-form-field label="Casas decimais" [error]="error('decimalDigits')">
            <input chainInput type="text" inputmode="numeric" [value]="v.decimalDigits ?? ''" (change)="setWhole('decimalDigits', $event, 0, 10)" />
          </chain-form-field>
          <chain-form-field label="Incremento" [error]="error('step')">
            <input chainInput type="text" inputmode="decimal" [value]="decimalText(v.step)" (change)="setStep($event)" />
          </chain-form-field>
        </div>
      }
      @case ('checklist') {
        <div class="chain-rules__pair">
          <chain-form-field label="Seleções mínimas" [error]="error('minSelected')">
            <input chainInput type="text" inputmode="numeric" [value]="v.minSelected ?? ''" (change)="setWhole('minSelected', $event)" />
          </chain-form-field>
          <chain-form-field label="Seleções máximas" [error]="error('maxSelected') ?? order(v.minSelected, v.maxSelected)">
            <input chainInput type="text" inputmode="numeric" [value]="v.maxSelected ?? ''" (change)="setWhole('maxSelected', $event)" />
          </chain-form-field>
        </div>
      }
      @case ('dynamicList') {
        <div class="chain-rules__pair">
          <chain-form-field label="Linhas mínimas" [error]="error('minRows')">
            <input chainInput type="text" inputmode="numeric" [value]="v.minRows ?? ''" (change)="setWhole('minRows', $event)" />
          </chain-form-field>
          <chain-form-field label="Linhas máximas" [error]="error('maxRows') ?? order(v.minRows, v.maxRows)">
            <input chainInput type="text" inputmode="numeric" [value]="v.maxRows ?? ''" (change)="setWhole('maxRows', $event)" />
          </chain-form-field>
        </div>
      }
      @case ('file') {
        <chain-form-field label="Máximo de arquivos" [error]="error('maxFiles')">
          <input chainInput type="text" inputmode="numeric" [value]="v.maxFiles ?? ''" (change)="setWhole('maxFiles', $event, 1, maxFiles)" />
        </chain-form-field>
        <fieldset class="chain-rules__families">
          <legend>Tipos aceitos</legend>
          @for (family of families; track family.name) {
            <label class="chain-rules__check">
              <input type="checkbox" [checked]="accepts(family.types)" (change)="setFamily(family.types, checked($event))" />
              {{ family.name }}
            </label>
          }
          <p class="chain-rules__hint">Nenhum marcado: todos os tipos permitidos.</p>
        </fieldset>
      }
    }
    @if (type() === 'text' || type() === 'textarea') {
      <div class="chain-rules__pair">
        <chain-form-field label="Comprimento mínimo" [error]="error('minLength')">
          <input chainInput type="text" inputmode="numeric" [value]="v.minLength ?? ''" (change)="setWhole('minLength', $event)" />
        </chain-form-field>
        <chain-form-field label="Comprimento máximo" [error]="error('maxLength') ?? order(v.minLength, v.maxLength)">
          <input chainInput type="text" inputmode="numeric" [value]="v.maxLength ?? ''" (change)="setWhole('maxLength', $event)" />
        </chain-form-field>
      </div>
    }
    @if (type() === 'text') {
      <chain-form-field label="Formato">
        <select chainInput (change)="setFormat($event)">
          @for (format of formats; track format.value) {
            <option [value]="format.value" [selected]="format.value === formatChoice()">{{ format.name }}</option>
          }
        </select>
      </chain-form-field>
      @if (formatChoice() === 'pattern') {
        <chain-form-field label="Padrão" [error]="patternError()">
          <input chainInput class="chain-mono" type="text" [value]="v.pattern ?? ''" (change)="setPattern($event)" />
        </chain-form-field>
      }
    }
    @if (dateType(); as dates) {
      <chain-date-bound [type]="dates" label="Mínimo" [bound]="dateBound(v.min)" (changed)="set('min', $event)" />
      <chain-date-bound [type]="dates" label="Máximo" [bound]="dateBound(v.max)" (changed)="set('max', $event)" />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-rules__pair {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--chain-space-2);
    }

    .chain-rules__check {
      display: flex;
      align-items: center;
      gap: var(--chain-space-2);
    }

    .chain-rules__families {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-1);
      margin: 0;
      padding: 0;
      border: 0;
    }

    .chain-rules__families legend {
      margin-block-end: var(--chain-space-1);
      font-weight: var(--chain-font-weight-medium);
    }

    .chain-rules__hint {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ValidationFields {
  readonly component = input.required<FormComponent>();
  /** The new `validate`, or undefined when no rule is left. */
  readonly changed = output<FieldValidation | undefined>();

  protected readonly formats = FORMATS;
  protected readonly families = FAMILIES;
  protected readonly maxFiles = MAX_FILES;
  protected readonly rules = computed<FieldValidation>(() => this.component().validate ?? {});
  protected readonly type = computed(() => this.component().type);
  protected readonly requirable = computed(() => REQUIRABLE.has(this.type()));
  protected readonly dateType = computed<DateType | null>(() => {
    const type = this.type();
    return type === 'date' || type === 'time' || type === 'datetime' ? type : null;
  });

  /** An entry refused at its field, by rule. */
  private readonly refused = signal<Partial<Record<Rule, string>>>({});
  /** *Padrão* chosen before a pattern is typed. */
  private readonly patternChosen = signal(false);
  protected readonly formatChoice = computed(() => {
    const rules = this.rules();
    return rules.pattern !== undefined || this.patternChosen() ? 'pattern' : (rules.format ?? '');
  });
  protected readonly patternError = computed(() => {
    const pattern = this.rules().pattern;
    if (pattern === undefined) {
      return null;
    }
    // The allowlist names what it refuses and what to write instead (forms.md F1, card #149).
    const refused = firstRefused(pattern);
    if (refused !== null) {
      return `O padrão não pode usar ${refused.construct}${refused.replacement === null ? '' : `: use ${refused.replacement}`}.`;
    }
    return compiles(pattern) ? null : formProblemText('FM005');
  });

  protected error(rule: Rule): string | null {
    return this.refused()[rule] ?? null;
  }

  protected order(min: unknown, max: unknown): string | null {
    return typeof min === 'number' && typeof max === 'number' && min > max ? ORDER : null;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected decimalText(value: unknown): string {
    return typeof value === 'number' ? String(value).replace('.', ',') : '';
  }

  protected dateBound(value: unknown): DateBound | undefined {
    return typeof value === 'string' || (typeof value === 'object' && value !== null) ? (value as DateBound) : undefined;
  }

  protected accepts(types: readonly string[]): boolean {
    const accept = this.rules().accept ?? [];
    return types.every((type) => accept.includes(type));
  }

  /** A whole number within its range; empty removes the rule. */
  protected setWhole(rule: Rule, event: Event, min = 0, max = Number.MAX_SAFE_INTEGER): void {
    const text = (event.target as HTMLInputElement).value.trim();
    if (text === '') {
      this.set(rule, undefined);
      return;
    }
    const value = /^[0-9]{1,9}$/.test(text) ? Number(text) : NaN;
    if (!(value >= min && value <= max)) {
      this.refuse(rule, max === Number.MAX_SAFE_INTEGER ? WHOLE : `Use de ${min} a ${max}.`);
      return;
    }
    this.set(rule, value);
  }

  /** A number typed with a decimal comma, as in the renderer; empty removes the rule. */
  protected setDecimal(rule: 'min' | 'max', event: Event): void {
    const value = this.decimal(rule, event);
    if (value !== null) {
      this.set(rule, value);
    }
  }

  protected setStep(event: Event): void {
    const value = this.decimal('step', event);
    if (value === null) {
      return;
    }
    if (value !== undefined && value <= 0) {
      this.refuse('step', 'Use um número maior que zero.');
      return;
    }
    this.set('step', value);
  }

  protected setFormat(event: Event): void {
    const choice = (event.target as HTMLSelectElement).value;
    this.patternChosen.set(choice === 'pattern');
    this.apply({ ...this.rules(), format: choice === '' || choice === 'pattern' ? undefined : choice, pattern: undefined });
  }

  protected setPattern(event: Event): void {
    const pattern = (event.target as HTMLInputElement).value;
    this.set('pattern', pattern === '' ? undefined : pattern);
  }

  protected setFamily(types: readonly string[], on: boolean): void {
    const accept = new Set(this.rules().accept ?? []);
    for (const type of types) {
      if (on) {
        accept.add(type);
      } else {
        accept.delete(type);
      }
    }
    const ordered = ACCEPTED_TYPES.filter((type) => accept.has(type));
    this.set('accept', ordered.length > 0 ? ordered : undefined);
  }

  set(rule: Rule, value: unknown): void {
    this.apply({ ...this.rules(), [rule]: value });
  }

  /** The number typed, undefined for an empty field, or null when it was refused. */
  private decimal(rule: Rule, event: Event): number | undefined | null {
    const text = (event.target as HTMLInputElement).value.trim();
    if (text === '') {
      this.clearRefusal(rule);
      return undefined;
    }
    const number = parseNumberInput(text);
    if (number === null) {
      this.refuse(rule, DECIMAL);
      return null;
    }
    this.clearRefusal(rule);
    return Number(formatNumber(number));
  }

  private refuse(rule: Rule, text: string): void {
    this.refused.update((refused) => ({ ...refused, [rule]: text }));
  }

  private clearRefusal(rule: Rule): void {
    this.refused.update((refused) => {
      const next = { ...refused };
      delete next[rule];
      return next;
    });
  }

  private apply(rules: Record<string, unknown>): void {
    for (const [rule, value] of Object.entries(rules)) {
      if (value === undefined) {
        delete rules[rule];
        this.clearRefusal(rule as Rule);
      } else {
        this.clearRefusal(rule as Rule);
      }
    }
    this.changed.emit(Object.keys(rules).length > 0 ? (rules as FieldValidation) : undefined);
  }
}
