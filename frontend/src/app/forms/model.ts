// The form document of forms.md F1 (schemaVersion 1), as the API returns it. The server parsed and validated it at publish
// (FM000–FM008), so the renderer reads it as it is.

export type ComponentType =
  | 'heading'
  | 'paragraph'
  | 'separator'
  | 'text'
  | 'textarea'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'radio'
  | 'checklist'
  | 'date'
  | 'time'
  | 'datetime'
  | 'file'
  | 'group'
  | 'dynamicList'
  | 'computed';

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

/** A relative date bound: today or now, moved by an offset (forms.md F1, ADR-0003 §2). */
export interface RelativeBound {
  readonly system: 'currentDate' | 'currentDateTime';
  readonly offset?: { readonly amount: number; readonly unit: 'days' | 'months' | 'years' | 'hours' | 'minutes' };
}

export interface FieldValidation {
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** A number for number fields; ISO text or a relative bound for date, time and datetime fields. */
  readonly min?: number | string | RelativeBound;
  readonly max?: number | string | RelativeBound;
  readonly decimalDigits?: number;
  readonly step?: number;
  readonly format?: string;
  readonly pattern?: string;
  readonly minSelected?: number;
  readonly maxSelected?: number;
  readonly minRows?: number;
  readonly maxRows?: number;
  readonly maxFiles?: number;
  readonly accept?: readonly string[];
}

export interface FormComponent {
  readonly type: ComponentType;
  readonly key?: string;
  readonly label?: string;
  /** Help text, shown as the field's hint and named by its control (forms.md F1, FM012; card #234). */
  readonly description?: string;
  /** The text of headings and paragraphs. */
  readonly text?: string;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  /** Hidden from readers who may not see it (sensitive-data.md §1); the renderer ignores it. */
  readonly sensitive?: boolean;
  readonly validate?: FieldValidation;
  readonly options?: readonly FieldOption[];
  /** The children of groups and dynamic lists. */
  readonly components?: readonly FormComponent[];
  /** ADR-0003 condition trees. */
  readonly visibleWhen?: unknown;
  readonly requiredWhen?: unknown;
  /** The ADR-0003 value tree of a computed field. */
  readonly expression?: unknown;
}

export interface FormDocument {
  readonly schemaVersion: number;
  readonly components: readonly FormComponent[];
}

/** One error of a 422 `submission_invalid`: a dotted path (list rows as `name[i]`) and a code (forms.md F1). */
export interface FieldErrorView {
  readonly key: string;
  readonly code: string;
}

/** Headings, paragraphs and separators show text and hold no value. */
export function producesValue(component: FormComponent): boolean {
  return component.type !== 'heading' && component.type !== 'paragraph' && component.type !== 'separator';
}

/** The path of a field under `prefix`, written as the server writes it in errors. */
export function childPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

export function rowPath(listPath: string, index: number): string {
  return `${listPath}[${index}]`;
}
