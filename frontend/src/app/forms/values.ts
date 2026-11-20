import { Num, numberFromJson } from '../expression/decimal';
import { EVALUATION_ZONE_MINUTES, parseDateTime } from '../expression';
import { clockDate, clockTime, formatDate, formatTime, toOffset } from '../expression/temporal';
import { FormComponent, producesValue } from './model';
import { formatNumberInput } from './numbers';
import { toFieldFile } from './uploads';

/**
 * What the controls hold (forms.md F3): text for text, number, choice, date and time inputs (`''` when empty), booleans for
 * checkboxes, lists of option values for checklists, objects for groups and lists of objects for dynamic lists. A datetime
 * holds the text that will be sent, with an offset; the native input shows it in UTC−03:00, Chain's zone (forms.md F3).
 */
export type EditableValue = string | boolean | readonly string[] | EditableObject | readonly EditableObject[];

export interface EditableObject {
  readonly [key: string]: EditableValue;
}

/** The values the controls start with: the prefill for each field, or an empty value. Unknown and computed keys are left out. */
export function initialValues(components: readonly FormComponent[], prefill: unknown): EditableObject {
  const source = isObject(prefill) ? prefill : {};
  const values: Record<string, EditableValue> = {};
  for (const component of components) {
    if (!producesValue(component) || !component.key || component.type === 'computed') {
      continue;
    }
    values[component.key] = initialValue(component, source[component.key]);
  }
  return values;
}

/** A new, empty row of a dynamic list. */
export function emptyRow(list: FormComponent): EditableObject {
  return initialValues(list.components ?? [], {});
}

function initialValue(component: FormComponent, prefill: unknown): EditableValue {
  switch (component.type) {
    case 'checkbox':
      return prefill === true;
    case 'checklist':
      return Array.isArray(prefill) && prefill.every((item) => typeof item === 'string') ? prefill : [];
    case 'number':
      return typeof prefill === 'number' && Number.isFinite(prefill) ? formatNumberInput(numberFromJson(prefill)) : '';
    case 'group':
      return initialValues(component.components ?? [], prefill);
    case 'dynamicList':
      return Array.isArray(prefill) ? prefill.map((row) => initialValues(component.components ?? [], row)) : [];
    case 'file':
      // The files the request holds, sent back unchanged (forms.md F3, "File fields"; card #69).
      return Array.isArray(prefill) ? prefill.map(toFieldFile).filter((file) => file !== null) : [];
    default:
      return typeof prefill === 'string' ? prefill : '';
  }
}

/**
 * JSON for the API with every digit of exact decimals: numbers held as {@link Num} are written as they are, never through
 * binary floating point (forms.md F3).
 */
export function serializeJson(value: unknown): string {
  if (value instanceof Num) {
    return value.toFixed();
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeJson).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${serializeJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const LOCAL_INPUT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/;

/**
 * The text a datetime field sends for what the native `datetime-local` input shows: that time in UTC−03:00, Chain's zone,
 * whatever the browser's (forms.md F3, owner decision on card #157; NFR-005, ADR-0010 D8). `''` stays `''`.
 */
export function fromLocalInput(local: string): string {
  const match = LOCAL_INPUT.exec(local);
  if (!match) {
    return '';
  }
  const minutes = Math.abs(EVALUATION_ZONE_MINUTES);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = `${EVALUATION_ZONE_MINUTES < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}${offset}`;
}

/** What the native input shows for a datetime value: its date and time in UTC−03:00, to the minute; `''` when it isn't one. */
export function toLocalInput(value: string): string {
  const instant = parseDateTime(value);
  if (instant === null) {
    return '';
  }
  try {
    const zoned = toOffset(instant, EVALUATION_ZONE_MINUTES);
    return `${formatDate(clockDate(zoned))}T${formatTime(clockTime(zoned)).slice(0, 5)}`;
  } catch {
    return ''; // before year 1 in UTC−03:00
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Num);
}
