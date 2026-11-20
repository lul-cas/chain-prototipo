import { Num, formatNumber, netDecimal, numberFromJson } from './decimal';
import { Instant, formatDate, formatInstant, formatTime } from './temporal';

/** A runtime value of the language (expression-language.md §2). `missing` is an unset key or a JSON null. */
export type ExprValue =
  | { readonly kind: 'missing' }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: Num }
  | { readonly kind: 'boolean'; readonly value: boolean }
  /** Days since 0001-01-01. */
  | { readonly kind: 'date'; readonly day: number }
  /** Ticks (100 ns) since midnight. */
  | { readonly kind: 'time'; readonly ticks: number }
  | { readonly kind: 'datetime'; readonly instant: Instant }
  | { readonly kind: 'list'; readonly items: readonly ExprValue[] }
  | { readonly kind: 'object'; readonly value: Readonly<Record<string, unknown>> };

export type ExprKind = ExprValue['kind'];

export const MISSING: ExprValue = { kind: 'missing' };

export const text = (value: string): ExprValue => ({ kind: 'text', value });
export const num = (value: Num): ExprValue => ({ kind: 'number', value });
export const bool = (value: boolean): ExprValue => ({ kind: 'boolean', value });
export const date = (day: number): ExprValue => ({ kind: 'date', day });
export const time = (ticks: number): ExprValue => ({ kind: 'time', ticks });
export const datetime = (instant: Instant): ExprValue => ({ kind: 'datetime', instant });

export const isTemporal = (value: ExprValue): boolean => value.kind === 'date' || value.kind === 'time' || value.kind === 'datetime';

/** The text `string()` produces, and the form stored for temporal values (§5.2). */
export function canonical(value: ExprValue): string {
  switch (value.kind) {
    case 'missing':
      return '';
    case 'text':
      return value.value;
    case 'number':
      return formatNumber(value.value);
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'date':
      return formatDate(value.day);
    case 'time':
      return formatTime(value.ticks);
    case 'datetime':
      return formatInstant(value.instant);
    case 'list':
      return `[${value.items.map(canonical).join(',')}]`;
    case 'object':
      return JSON.stringify(value.value);
  }
}

/** Typed by the JSON kind: string → text, number → number, true/false → boolean, array → list, object → object (§5.2). */
export function fromJson(json: unknown): ExprValue {
  if (json instanceof Num) {
    return num(netDecimal(json)); // an exact decimal a form holds before sending it, read as JSON would read its text
  }
  if (typeof json === 'string') {
    return text(json);
  }
  if (typeof json === 'number') {
    return num(numberFromJson(json));
  }
  if (typeof json === 'boolean') {
    return bool(json);
  }
  if (Array.isArray(json)) {
    return { kind: 'list', items: json.map(fromJson) };
  }
  if (typeof json === 'object' && json !== null) {
    return { kind: 'object', value: json as Record<string, unknown> };
  }
  return MISSING;
}

/** Back into JSON data: temporal values become their canonical ISO text and missing becomes null (§5.2). */
export function toJson(value: ExprValue): unknown {
  switch (value.kind) {
    case 'missing':
      return null;
    case 'text':
      return value.value;
    case 'number':
      return Number(value.value.toString());
    case 'boolean':
      return value.value;
    case 'list':
      return value.items.map(toJson);
    case 'object':
      return value.value;
    default:
      return canonical(value);
  }
}
