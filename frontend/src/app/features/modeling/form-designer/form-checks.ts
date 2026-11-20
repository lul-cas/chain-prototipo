import { parseCondition, parseDateTime, parseValue } from '../../../expression';
import { parseDate, parseTime } from '../../../expression/temporal';
import { FormComponent, FormDocument } from '../../../forms/model';
import { firstRefused } from '../../../forms/pattern-subset';

/** A problem the designer finds without the server: the code and the path the server would report (forms.md F1). */
export interface FormProblem {
  readonly code: string;
  /** A key path such as `endereco.cep`, `components[i]` for a component without a key, or null for the whole form. */
  readonly path: string | null;
}

export const MAX_COMPONENTS = 200;
export const MAX_DEPTH = 3;
export const MAX_OPTIONS = 200;
export const MAX_FILES = 10;
export const MAX_PATTERN_LENGTH = 500;
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const FORMATS = new Set(['email', 'cpf', 'cnpj', 'phone', 'cep']);
const DISPLAY = new Set(['heading', 'paragraph', 'separator']);
const CONTAINERS = new Set(['group', 'dynamicList']);
const REQUIRABLE = new Set(['text', 'textarea', 'number', 'date', 'time', 'datetime', 'file', 'checkbox', 'select', 'radio', 'checklist']);
/** The file types a field may accept: the allowlist of ADR-0014 §5, as the server's FileRules lists it. */
export const ACCEPTED_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
];
const MAX_OFFSET = 10_000;
export const MAX_DESCRIPTION_LENGTH = 500;
/** Blank as .NET's `string.IsNullOrWhiteSpace` reads it, for FM011: JavaScript's `trim` also drops U+FEFF and keeps U+0085 (#124). */
const BLANK = /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/;

/**
 * The structural rules the designer checks locally (form-designer.md §9.2), as the server's FormValidator does, in its order:
 * FM001–FM012, FM005's allowlist included (card #149). Feedback only: the server decides.
 * A rule is reported once per component, though the server may give it once per way it fails.
 */
export function checkForm(document: FormDocument): FormProblem[] {
  const problems: FormProblem[] = [];
  if (count(document.components) > MAX_COMPONENTS || depth(document.components) > MAX_DEPTH) {
    problems.push({ code: 'FM006', path: null });
  }
  checkLevel(document.components, null, problems);
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const id = `${problem.code} ${problem.path}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function checkLevel(components: readonly FormComponent[], prefix: string | null, problems: FormProblem[]): void {
  const seen = new Set<string>();
  components.forEach((component, index) => {
    const path = component.key !== undefined ? join(prefix, component.key) : `${join(prefix, 'components')}[${index}]`;
    const problem = (code: string) => problems.push({ code, path });
    const producesValue = !DISPLAY.has(component.type);

    if (producesValue) {
      if (component.key === undefined || !KEY.test(component.key)) {
        problem('FM001');
      } else if (seen.has(component.key)) {
        problem('FM002');
      } else {
        seen.add(component.key);
      }
      if (component.label === undefined || BLANK.test(component.label)) {
        problem('FM011');
      }
      if ((component.description?.length ?? 0) > MAX_DESCRIPTION_LENGTH) {
        problem('FM012');
      }
    } else if (component.description !== undefined) {
      problem('FM012'); // a heading or a paragraph shows its text
    }

    checkOptions(component, problem);
    checkValidation(component, problem);
    if (component.sensitive) {
      if (prefix !== null || !producesValue) {
        problem('FM009');
      } else if (component.type === 'file') {
        problem('FM010');
      }
    }

    if (component.type === 'computed' && !(isObject(component.expression) && parseValue(component.expression).ok)) {
      problem('FM007');
    }
    for (const condition of [component.visibleWhen, component.requiredWhen]) {
      if (condition !== undefined && condition !== null && !parseCondition(condition).ok) {
        problem('FM008');
      }
    }

    const isContainer = CONTAINERS.has(component.type);
    if (isContainer !== (component.components !== undefined) || component.components?.length === 0) {
      problem('FM004');
    }
    if (component.components !== undefined && component.components.length > 0) {
      checkLevel(component.components, path, problems); // the full path, so nested problems name their component (card #237)
    }
  });
}

function checkOptions(component: FormComponent, problem: (code: string) => void): void {
  if (!['select', 'radio', 'checklist'].includes(component.type)) {
    if (component.options !== undefined) {
      problem('FM004');
    }
    return;
  }
  const options = component.options ?? [];
  if (options.length === 0 || options.length > MAX_OPTIONS || new Set(options.map((option) => option.value)).size !== options.length) {
    problem('FM003');
  }
}

function checkValidation(component: FormComponent, problem: (code: string) => void): void {
  const v = component.validate;
  if (v === undefined) {
    return;
  }
  const type = component.type;
  const isText = type === 'text' || type === 'textarea';
  const isNumber = type === 'number';
  const isDate = type === 'date' || type === 'time' || type === 'datetime';
  const isFile = type === 'file';
  const fm004 = () => problem('FM004');

  if (v.required && !REQUIRABLE.has(type)) fm004();
  if ((v.maxFiles !== undefined || v.accept !== undefined) && !isFile) fm004();
  if (isFile && v.maxFiles !== undefined && (v.maxFiles < 1 || v.maxFiles > MAX_FILES)) fm004();
  if (isFile && v.accept !== undefined && (v.accept.length === 0 || new Set(v.accept).size !== v.accept.length || v.accept.some((item) => !ACCEPTED_TYPES.includes(item)))) {
    fm004();
  }
  if ((v.minLength !== undefined || v.maxLength !== undefined || v.format !== undefined || v.pattern !== undefined) && !isText) fm004();
  if ((v.decimalDigits !== undefined || v.step !== undefined) && !isNumber) fm004();
  if ((v.minSelected !== undefined || v.maxSelected !== undefined) && type !== 'checklist') fm004();
  if ((v.minRows !== undefined || v.maxRows !== undefined) && type !== 'dynamicList') fm004();
  if ((v.min !== undefined || v.max !== undefined) && !(isNumber || isDate)) fm004();
  for (const [min, max] of [
    [v.minLength, v.maxLength],
    [v.minSelected, v.maxSelected],
    [v.minRows, v.maxRows],
  ] as const) {
    if ((min ?? 0) < 0 || (max ?? 0) < 0) fm004();
    if (min !== undefined && max !== undefined && min > max) fm004();
  }
  if (v.decimalDigits !== undefined && (v.decimalDigits < 0 || v.decimalDigits > 10)) fm004();
  if (v.step !== undefined && v.step <= 0) fm004();
  if (v.format !== undefined && !FORMATS.has(v.format)) fm004();
  if (isNumber) {
    const [min, max] = [v.min, v.max];
    if ((min !== undefined && typeof min !== 'number') || (max !== undefined && typeof max !== 'number')) {
      fm004();
    } else if (typeof min === 'number' && typeof max === 'number' && min > max) {
      fm004();
    }
  }
  if (isDate && [v.min, v.max].some((bound) => bound !== undefined && !isValidBound(bound, type))) fm004();
  if (v.pattern !== undefined && (!compiles(v.pattern) || firstRefused(v.pattern) !== null)) {
    problem('FM005');
  }
}

/** A date bound: ISO text of the field's type, or `{ system, offset }` for a date or a datetime (forms.md F1, DateBounds). */
function isValidBound(bound: unknown, type: string): boolean {
  if (typeof bound === 'string') {
    return type === 'date' ? parseDate(bound) !== null : type === 'time' ? parseTime(bound) !== null : parseDateTime(bound) !== null;
  }
  if (!isObject(bound) || type === 'time') {
    return false;
  }
  const relative = bound as Record<string, unknown>;
  const units = type === 'date' ? ['days', 'months', 'years'] : ['days', 'months', 'years', 'hours', 'minutes'];
  const offset = relative['offset'];
  return (
    Object.keys(relative).every((name) => name === 'system' || name === 'offset') &&
    relative['system'] === (type === 'date' ? 'currentDate' : 'currentDateTime') &&
    (offset === undefined ||
      (isObject(offset) &&
        Object.keys(offset).length === 2 &&
        Number.isInteger((offset as Record<string, unknown>)['amount']) &&
        Math.abs((offset as Record<string, number>)['amount']) <= MAX_OFFSET &&
        units.includes((offset as Record<string, unknown>)['unit'] as string)))
  );
}

/** FM005: the pattern compiles on its own and has at most 500 characters; `firstRefused` checks the allowlist apart. */
export function compiles(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return false;
  }
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** How many components the form has, at every level (FM006). */
export function count(components: readonly FormComponent[] | undefined): number {
  return (components ?? []).reduce((total, component) => total + 1 + count(component.components), 0);
}

/** How many levels of groups and lists nest (FM006). */
export function depth(components: readonly FormComponent[] | undefined): number {
  return Math.max(0, ...(components ?? []).map((component) => (CONTAINERS.has(component.type) ? 1 + depth(component.components) : 0)));
}

function join(prefix: string | null, key: string): string {
  return prefix === null ? key : `${prefix}.${key}`;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
