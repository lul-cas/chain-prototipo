import { ExprValue, ExpressionError, canonical, evaluateCondition, evaluateValue, parseCondition, parseValue } from '../expression';
import { Num } from '../expression/decimal';
import { formatDate, formatInstant, formatTime, parseDate, parseDateTime, parseTime } from '../expression/temporal';
import { FormComponent, FormDocument, childPath, producesValue, rowPath } from './model';
import { parseNumberInput } from './numbers';
import { Clock, checkField, isEmpty } from './rules';
import { EditableObject, EditableValue } from './values';
import { isPendingUpload, toFieldFile } from './uploads';

/** The state of one value-producing field at `path` (a dotted path, list rows as `name[i]`). */
export interface FieldState {
  readonly visible: boolean;
  readonly required: boolean;
  readonly readOnly: boolean;
  /** Client-side codes, in the server's order (forms.md F1). */
  readonly errors: readonly string[];
  /** A file field with a file still uploading: the form isn't sent until it arrives (forms.md F3, "File fields"). */
  readonly uploading?: boolean;
  /** The result of a computed field; absent when it failed or has no value. */
  readonly computed?: ExprValue;
}

export interface Evaluation {
  readonly fields: ReadonlyMap<string, FieldState>;
  /** Visibility of headings, paragraphs and separators, by their parent's path and position: `#2`, `endereco#0`. */
  readonly display: ReadonlyMap<string, boolean>;
  /** What would be sent: visible, editable values, `null` when empty; numbers as exact decimals (see `serializeJson`). */
  readonly data: Record<string, unknown>;
  readonly valid: boolean;
}

/** Enough passes for conditions that depend on conditional fields; each pass changes visibility only if the previous one did. */
const MAX_PASSES = 5;

/**
 * Evaluates a form as the server will process its submission (forms.md F2 and F3; Chain.Forms/SubmissionValidator.cs).
 * `base` is the data around the form: the request's data with the prefill on top. Conditions read `base` overlaid with what
 * will be sent, as the server reads the submission; computed fields read `base` overlaid with the valid values and the
 * computed fields before them.
 */
export function evaluateForm(document: FormDocument, values: EditableObject, base: Readonly<Record<string, unknown>>, clock: Clock): Evaluation {
  // What will be sent depends on visibility, and visibility on what will be sent: start from everything typed, then let
  // hidden values drop out until visibility settles.
  let walk = walkForm(document, values, overlay(base, typedValues(document.components, values)), clock);
  for (let pass = 1; pass < MAX_PASSES; pass++) {
    const next = walkForm(document, values, overlay(base, walk.raw), clock);
    const settled = sameVisibility(walk, next);
    walk = next;
    if (settled) {
      break;
    }
  }

  for (const item of walk.computed) {
    computeField(item, walk, base, clock);
  }

  const invalid = [...walk.fields.values()].some((state) => state.visible && (state.errors.length > 0 || state.uploading === true));
  return { fields: walk.fields, display: walk.display, data: walk.raw, valid: !invalid };
}

interface ComputedItem {
  readonly component: FormComponent;
  readonly path: string;
  /** The object of valid values the result joins, so later computed fields read it. */
  readonly target: Record<string, unknown>;
}

interface Walk {
  readonly fields: Map<string, FieldState>;
  readonly display: Map<string, boolean>;
  /** The submission: visible, editable values as sent, `null` when empty, valid or not (the server's conditions read these). */
  readonly raw: Record<string, unknown>;
  /** Valid values in canonical form, as the server stores them, `null` when empty; computed fields read these. */
  readonly processed: Record<string, unknown>;
  readonly computed: ComputedItem[];
}

function walkForm(document: FormDocument, values: EditableObject, data: Readonly<Record<string, unknown>>, clock: Clock): Walk {
  const walk: Walk = { fields: new Map(), display: new Map(), raw: {}, processed: {}, computed: [] };
  walkLevel(document.components, values, '', { data, clock, walk }, walk.raw, walk.processed);
  return walk;
}

interface Context {
  readonly data: Readonly<Record<string, unknown>>;
  readonly clock: Clock;
  readonly walk: Walk;
}

function walkLevel(
  components: readonly FormComponent[],
  values: EditableObject,
  prefix: string,
  context: Context,
  raw: Record<string, unknown>,
  processed: Record<string, unknown>,
): void {
  components.forEach((component, index) => {
    if (!producesValue(component)) {
      context.walk.display.set(`${prefix}#${index}`, holds(component.visibleWhen, context, true, true).value);
      return;
    }
    if (!component.key) {
      return;
    }

    const key = component.key;
    const path = childPath(prefix, key);
    const errors: string[] = [];
    const visibility = holds(component.visibleWhen, context, true, true);
    if (visibility.error) {
      errors.push('expression_error');
    }
    if (!visibility.value) {
      context.walk.fields.set(path, { visible: false, required: false, readOnly: component.readOnly === true, errors: [] });
      return; // hidden: not validated, not sent; a hidden container hides its children
    }
    if (component.type === 'computed') {
      context.walk.fields.set(path, { visible: true, required: false, readOnly: true, errors });
      context.walk.computed.push({ component, path, target: processed });
      return;
    }
    if (component.readOnly) {
      context.walk.fields.set(path, { visible: true, required: false, readOnly: true, errors });
      return; // prefilled; the server ignores client values
    }

    let required = component.validate?.required === true;
    if (!required) {
      const condition = holds(component.requiredWhen, context, true, false);
      if (condition.error) {
        errors.push('expression_error');
      }
      required = condition.value;
    }

    const value = values[key];
    let uploading = false;
    switch (component.type) {
      case 'group': {
        const groupRaw: Record<string, unknown> = {};
        const groupProcessed: Record<string, unknown> = {};
        walkLevel(component.components ?? [], isObject(value) ? value : {}, path, context, groupRaw, groupProcessed);
        raw[key] = groupRaw;
        processed[key] = groupProcessed;
        break;
      }
      case 'dynamicList': {
        const rows = Array.isArray(value) ? (value as readonly EditableObject[]) : [];
        errors.push(...checkField(component, rows, required, context.clock));
        const rawRows: Record<string, unknown>[] = [];
        const processedRows: Record<string, unknown>[] = [];
        rows.forEach((row, i) => {
          const rowRaw: Record<string, unknown> = {};
          const rowProcessed: Record<string, unknown> = {};
          walkLevel(component.components ?? [], row, rowPath(path, i), context, rowRaw, rowProcessed);
          rawRows.push(rowRaw);
          processedRows.push(rowProcessed);
        });
        raw[key] = rawRows;
        processed[key] = processedRows;
        break;
      }
      case 'file': {
        // Sent as the files' ids, or null when empty, which clears the stored files; files still uploading aren't sent but
        // hold the form back (forms.md F3, "File fields").
        const files = fileIds(value);
        const pending = (Array.isArray(value) ? value : []).filter(isPendingUpload).length;
        uploading = pending > 0;
        if (required && files.length === 0 && !uploading) {
          errors.push('required');
        }
        if (files.length + pending > (component.validate?.maxFiles ?? 10)) {
          errors.push('too_many');
        }
        raw[key] = files.length === 0 ? null : files;
        processed[key] = raw[key];
        break;
      }
      default: {
        const codes = checkField(component, value, required, context.clock);
        errors.push(...codes);
        if (isEmpty(component, value)) {
          // Sent as null, so the server clears the stored value: conditions and computed fields read it as missing (card #86).
          raw[key] = null;
          processed[key] = null;
          break;
        }
        const sent = toRaw(component, value);
        if (sent !== undefined) {
          raw[key] = sent;
          if (codes.length === 0) {
            processed[key] = toStored(component, sent);
          }
        }
      }
    }
    context.walk.fields.set(path, { visible: true, required, readOnly: false, errors, ...(uploading ? { uploading } : {}) });
  });
}

/** The value as sent: text as typed, exact decimals for numbers; undefined when it can't be sent at all. */
function toRaw(component: FormComponent, value: EditableValue): unknown {
  if (component.type === 'number') {
    return parseNumberInput(String(value)) ?? undefined;
  }
  return value;
}

/** The value as the server stores it: dates, times and datetimes in canonical form (expression-language.md §5.2). */
function toStored(component: FormComponent, sent: unknown): unknown {
  switch (component.type) {
    case 'date':
      return formatDate(parseDate(String(sent))!);
    case 'time':
      return formatTime(parseTime(String(sent))!);
    case 'datetime':
      return formatInstant(parseDateTime(String(sent))!);
    default:
      return sent;
  }
}

/** Everything typed, visible or not: the first guess of what will be sent. */
function typedValues(components: readonly FormComponent[], values: EditableObject): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const component of components) {
    if (!producesValue(component) || !component.key || component.readOnly || component.type === 'computed') {
      continue;
    }
    const value = values[component.key];
    if (component.type === 'file') {
      const files = fileIds(value);
      raw[component.key] = files.length === 0 ? null : files;
      continue;
    }
    if (component.type === 'group') {
      raw[component.key] = typedValues(component.components ?? [], isObject(value) ? value : {});
    } else if (component.type === 'dynamicList') {
      raw[component.key] = (Array.isArray(value) ? (value as readonly EditableObject[]) : []).map((row) => typedValues(component.components ?? [], row));
    } else if (isEmpty(component, value)) {
      raw[component.key] = null;
    } else {
      const sent = toRaw(component, value);
      if (sent !== undefined) {
        raw[component.key] = sent;
      }
    }
  }
  return raw;
}

function computeField(item: ComputedItem, walk: Walk, base: Readonly<Record<string, unknown>>, clock: Clock): void {
  const state = walk.fields.get(item.path)!;
  const fail = () => walk.fields.set(item.path, { ...state, errors: [...state.errors, 'expression_error'] });
  const tree = parseValue(item.component.expression);
  if (!tree.ok) {
    fail();
    return;
  }

  let result: ExprValue;
  try {
    result = evaluateValue(tree.node, { data: overlay(base, walk.processed), now: clock.now, zone: clock.zone });
  } catch (error) {
    if (error instanceof ExpressionError) {
      fail();
      return;
    }
    throw error;
  }

  switch (result.kind) {
    case 'missing':
      return; // no value, and no error (as on the server)
    case 'list':
    case 'object':
      fail(); // the server can't store these
      return;
    case 'number':
      item.target[item.component.key!] = result.value;
      break;
    case 'text':
    case 'boolean':
      item.target[item.component.key!] = result.value;
      break;
    default:
      item.target[item.component.key!] = canonical(result);
  }
  walk.fields.set(item.path, { ...state, computed: result });
}

interface Holds {
  readonly value: boolean;
  readonly error: boolean;
}

/** An optional condition; one that fails to parse or evaluate counts as `onError` and is reported (the server's `Holds`). */
function holds(condition: unknown, context: Context, onError: boolean, absent: boolean): Holds {
  if (condition === undefined || condition === null) {
    return { value: absent, error: false };
  }
  const tree = parseCondition(condition);
  if (!tree.ok) {
    return { value: onError, error: true };
  }
  try {
    return { value: evaluateCondition(tree.node, { data: context.data, now: context.clock.now, zone: context.clock.zone }), error: false };
  } catch (error) {
    if (error instanceof ExpressionError) {
      return { value: onError, error: true };
    }
    throw error;
  }
}

/** Top-level keys of `top` replace those of `data`, as the server overlays the submission on the request's data. */
function overlay(data: Readonly<Record<string, unknown>>, top: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...data, ...top };
}

function sameVisibility(a: Walk, b: Walk): boolean {
  if (a.fields.size !== b.fields.size || a.display.size !== b.display.size) {
    return false;
  }
  for (const [path, state] of a.fields) {
    if (b.fields.get(path)?.visible !== state.visible) {
      return false;
    }
  }
  for (const [id, visible] of a.display) {
    if (b.display.get(id) !== visible) {
      return false;
    }
  }
  return true;
}

function isObject(value: unknown): value is EditableObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Num);
}

/** A file field's files, as the server takes them: `[{ fileId }]` (forms.md F4). */
function fileIds(value: unknown): { readonly fileId: string }[] {
  return (Array.isArray(value) ? value : []).map(toFieldFile).filter((file) => file !== null).map((file) => ({ fileId: file.fileId }));
}
