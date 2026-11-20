import { Instant } from '../expression';
import { numberFromJson } from '../expression/decimal';
import {
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  addDays,
  addInstantMonths,
  addMonths,
  addTicks,
  clockDate,
  parseDate,
  parseDateTime,
  parseTime,
  toOffset,
  toUtc,
  utcTicks,
} from '../expression/temporal';
import { isValidFormat } from './formats';
import { FieldValidation, FormComponent, RelativeBound } from './model';
import { parseNumberInput } from './numbers';

/** The current instant and the evaluation zone in minutes east of UTC, for relative bounds (ADR-0003 §2). */
export interface Clock {
  readonly now: Instant;
  readonly zone: number;
}

/**
 * The client-side checks of one value-producing field, with the server's codes in the server's order (forms.md F1;
 * Chain.Forms/SubmissionValidator.cs). `value` is what the control holds: text, a boolean, or a list of option values.
 * Groups and lists are walked by the evaluation; for a list, this checks the row count only.
 */
export function checkField(component: FormComponent, value: unknown, required: boolean, clock: Clock): readonly string[] {
  const rules = component.validate ?? {};
  if (component.type === 'dynamicList') {
    return counts(Array.isArray(value) ? value.length : 0, rules.minRows, rules.maxRows);
  }
  if (isEmpty(component, value)) {
    return required ? ['required'] : [];
  }

  switch (component.type) {
    case 'text':
    case 'textarea':
      return checkText(String(value), rules);
    case 'number':
      return checkNumber(String(value), rules);
    case 'select':
    case 'radio':
      return component.options?.some((option) => option.value === value) ? [] : ['invalid_option'];
    case 'checklist':
      return checkChecklist(component, value as readonly string[], rules);
    case 'date':
      return checkTemporal(parseDate(String(value)), rules, (bound) => dateBound(bound, clock));
    case 'time':
      return checkTemporal(parseTime(String(value)), rules, (bound) => (typeof bound === 'string' ? parseTime(bound) : null));
    case 'datetime': {
      const instant = parseDateTime(String(value));
      return checkTemporal(instant === null ? null : utcTicks(instant), rules, (bound) => dateTimeBound(bound, clock));
    }
    default:
      return [];
  }
}

/** Empty as the server counts it: no value, empty text, no option chosen, an unchecked box, an empty checklist. */
export function isEmpty(component: FormComponent, value: unknown): boolean {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  if (component.type === 'checkbox') {
    return value === false;
  }
  return component.type === 'checklist' && Array.isArray(value) && value.length === 0;
}

function checkText(text: string, rules: FieldValidation): string[] {
  const codes: string[] = [];
  if (rules.minLength !== undefined && text.length < rules.minLength) {
    codes.push('too_short');
  }
  if (rules.maxLength !== undefined && text.length > rules.maxLength) {
    codes.push('too_long');
  }
  const formatOk = rules.format === undefined || isValidFormat(rules.format, text);
  const patternOk = rules.pattern === undefined || matchesPattern(rules.pattern, text);
  if (!formatOk || !patternOk) {
    codes.push('invalid_format');
  }
  return codes;
}

/**
 * The whole value must match, as with HTML's `pattern` (forms.md F1, "Patterns"). A pattern that compiles only inside the wrap
 * has unbalanced parentheses, which split the anchors (`a)|(?:b`): it matches no value, as on the server. A pattern the browser
 * can't compile at all is left to the server.
 */
export function matchesPattern(pattern: string, text: string): boolean {
  let expression: RegExp;
  try {
    expression = new RegExp(`^(?:${pattern})$`);
  } catch {
    return true;
  }
  return compiles(pattern) && expression.test(text);
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function checkNumber(text: string, rules: FieldValidation): string[] {
  const number = parseNumberInput(text);
  if (number === null) {
    return ['type_mismatch'];
  }
  const codes: string[] = [];
  const min = typeof rules.min === 'number' ? numberFromJson(rules.min) : null;
  const max = typeof rules.max === 'number' ? numberFromJson(rules.max) : null;
  if (min !== null && number.lt(min)) {
    codes.push('too_small');
  }
  if (max !== null && number.gt(max)) {
    codes.push('too_large');
  }
  // decimal.js counts places without trailing zeros, which is what the server's "scale > digits and rounding changes the
  // value" amounts to: 1,230 has two places.
  if (rules.decimalDigits !== undefined && number.decimalPlaces() > rules.decimalDigits) {
    codes.push('too_many_decimals');
  }
  if (rules.step !== undefined && !number.minus(min ?? 0).mod(numberFromJson(rules.step)).isZero()) {
    codes.push('invalid_step');
  }
  return codes;
}

function checkChecklist(component: FormComponent, selected: readonly string[], rules: FieldValidation): string[] {
  const codes: string[] = [];
  if (selected.some((value) => !component.options?.some((option) => option.value === value))) {
    codes.push('invalid_option');
  }
  return [...codes, ...counts(selected.length, rules.minSelected, rules.maxSelected)];
}

function counts(count: number, min: number | undefined, max: number | undefined): string[] {
  const codes: string[] = [];
  if (min !== undefined && count < min) {
    codes.push('too_few');
  }
  if (max !== undefined && count > max) {
    codes.push('too_many');
  }
  return codes;
}

/** Dates, times and instants compare as numbers (day numbers, ticks of the day, UTC ticks). */
function checkTemporal<T extends number | bigint>(
  value: T | null,
  rules: FieldValidation,
  resolve: (bound: FieldValidation['min']) => T | null,
): string[] {
  if (value === null) {
    return ['type_mismatch'];
  }
  const codes: string[] = [];
  const min = rules.min === undefined ? null : resolve(rules.min);
  const max = rules.max === undefined ? null : resolve(rules.max);
  if (min !== null && value < min) {
    codes.push('too_early');
  }
  if (max !== null && value > max) {
    codes.push('too_late');
  }
  return codes;
}

/** A date bound: ISO text, or today in the evaluation zone moved by the offset (Chain.Forms DateBounds). */
function dateBound(bound: FieldValidation['min'], clock: Clock): number | null {
  if (typeof bound === 'string') {
    return parseDate(bound);
  }
  if (!isRelative(bound)) {
    return null;
  }
  try {
    const today = clockDate(toOffset(clock.now, clock.zone));
    const { amount, unit } = bound.offset ?? { amount: 0, unit: 'days' };
    return unit === 'days' ? addDays(today, amount) : addMonths(today, unit === 'months' ? amount : amount * 12);
  } catch {
    return null; // a bound beyond year 9999 checks nothing here; the server decides
  }
}

/** A datetime bound: ISO text, or the current instant moved by the offset, as UTC ticks. */
function dateTimeBound(bound: FieldValidation['min'], clock: Clock): bigint | null {
  if (typeof bound === 'string') {
    const instant = parseDateTime(bound);
    return instant === null ? null : utcTicks(instant);
  }
  if (!isRelative(bound)) {
    return null;
  }
  try {
    const now = toUtc(clock.now);
    const { amount, unit } = bound.offset ?? { amount: 0, unit: 'days' };
    const moved =
      unit === 'months' || unit === 'years'
        ? addInstantMonths(now, unit === 'months' ? amount : amount * 12)
        : addTicks(now, BigInt(amount) * (unit === 'days' ? TICKS_PER_DAY : unit === 'hours' ? TICKS_PER_HOUR : TICKS_PER_MINUTE));
    return utcTicks(moved);
  } catch {
    return null;
  }
}

function isRelative(bound: unknown): bound is RelativeBound {
  return typeof bound === 'object' && bound !== null && 'system' in bound;
}
