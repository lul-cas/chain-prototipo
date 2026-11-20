import { netDecimal } from './decimal';
import { ExpressionError } from './errors';
import { call } from './functions';
import { ConditionNode, DateOffset, ValueNode } from './parser';
import {
  Instant,
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
} from './temporal';
import { ExprValue, MISSING, date, datetime, fromJson, num, time } from './values';

/** What expressions read: `data`, the current instant and the evaluation zone in minutes east of UTC (ADR-0003 §2; Q-15). */
export interface EvaluationContext {
  readonly data: unknown;
  readonly now: Instant;
  readonly zone: number;
}

/** Evaluates a condition (expression-language.md §3–§4). Failures throw {@link ExpressionError} with the codes of §5.3. */
export function evaluateCondition(node: ConditionNode, context: EvaluationContext): boolean {
  if (node.kind === 'group') {
    // Short-circuit, left to right (§4).
    return node.and ? node.items.every((item) => evaluateCondition(item, context)) : node.items.some((item) => evaluateCondition(item, context));
  }
  return compare(node, context);
}

/** Evaluates a value tree: an operand, a function argument or a computed field. */
export function evaluateValue(node: ValueNode, context: EvaluationContext): ExprValue {
  let value: ExprValue;
  switch (node.kind) {
    case 'path':
      value = read(context.data, node.segments, 0);
      break;
    case 'literal':
      value = node.value;
      break;
    case 'system':
      value = node.name === 'currentDate' ? date(clockDate(toOffset(context.now, context.zone))) : datetime(toUtc(context.now));
      break;
    case 'arithmetic':
      value = arithmetic(node.op, evaluateValue(node.left, context), evaluateValue(node.right, context));
      break;
    case 'call':
      value = call(node.fn, node.args.map((arg) => evaluateValue(arg, context)), context);
      break;
  }
  return node.offset ? applyOffset(value, node.offset) : value;
}

// Comparisons (§3)

type Compare = Extract<ConditionNode, { kind: 'compare' }>;

function compare(node: Compare, context: EvaluationContext): boolean {
  const left = evaluateValue(node.left, context);
  if (node.operator === 'isEmpty') {
    return isEmpty(left);
  }
  if (node.operator === 'isNotEmpty') {
    return !isEmpty(left);
  }

  const right = evaluateValue(node.right!, context);
  if (left.kind === 'missing' || right.kind === 'missing') {
    return node.operator === 'notEquals'; // §3: missing compares false, except notEquals
  }

  const [l, r] = coerce(left, right);
  switch (node.operator) {
    case 'equals':
      return equal(l, r);
    case 'notEquals':
      return !equal(l, r);
    case 'contains':
      return contains(l, r);
    case 'greaterThan':
      return order(l, r) > 0;
    case 'lessThan':
      return order(l, r) < 0;
    case 'greaterOrEqual':
      return order(l, r) >= 0;
    case 'lessOrEqual':
      return order(l, r) <= 0;
    default:
      throw new ExpressionError('type_mismatch', `Unknown operator '${node.operator}'.`);
  }
}

function isEmpty(value: ExprValue): boolean {
  switch (value.kind) {
    case 'missing':
      return true;
    case 'text':
      return value.value.length === 0;
    case 'list':
      return value.items.length === 0;
    default:
      return false;
  }
}

const temporal = (value: ExprValue): boolean => value.kind === 'date' || value.kind === 'datetime' || value.kind === 'time';

/** Dates and times are stored as ISO text: text is parsed when the other side is temporal (§5.2). */
function coerce(left: ExprValue, right: ExprValue): [ExprValue, ExprValue] {
  if (left.kind === 'text' && temporal(right)) {
    return [parseAs(left.value, right), right];
  }
  if (temporal(left) && right.kind === 'text') {
    return [left, parseAs(right.value, left)];
  }
  return [left, right];
}

function parseAs(text: string, like: ExprValue): ExprValue {
  const parsed =
    like.kind === 'date' ? fromNullable(parseDate(text), date)
    : like.kind === 'datetime' ? fromNullable(parseDateTime(text), datetime)
    : like.kind === 'time' ? fromNullable(parseTime(text), time)
    : null;
  if (!parsed) {
    throw new ExpressionError('type_mismatch', `'${text}' is not a ${like.kind}.`);
  }
  return parsed;
}

/** The temporal value an ISO text denotes, or null. The three formats are disjoint, so at most one applies (§5.2). */
function asTemporal(text: string): ExprValue | null {
  return fromNullable(parseDate(text), date) ?? fromNullable(parseTime(text), time) ?? fromNullable(parseDateTime(text), datetime);
}

function fromNullable<T>(value: T | null, make: (value: T) => ExprValue): ExprValue | null {
  return value === null ? null : make(value);
}

function equal(left: ExprValue, right: ExprValue): boolean {
  if (left.kind === 'text' && right.kind === 'text') {
    return left.value === right.value; // ordinal (Q-16)
  }
  if (left.kind === 'number' && right.kind === 'number') {
    return left.value.eq(right.value);
  }
  if (left.kind === 'boolean' && right.kind === 'boolean') {
    return left.value === right.value;
  }
  if (left.kind === 'date' && right.kind === 'date') {
    return left.day === right.day;
  }
  if (left.kind === 'datetime' && right.kind === 'datetime') {
    return utcTicks(left.instant) === utcTicks(right.instant);
  }
  if (left.kind === 'time' && right.kind === 'time') {
    return left.ticks === right.ticks;
  }
  throw mismatch(left, right);
}

function contains(left: ExprValue, right: ExprValue): boolean {
  if (left.kind === 'text' && right.kind === 'text') {
    return left.value.includes(right.value);
  }
  if (left.kind === 'list') {
    return left.items.some((item) => item.kind !== 'missing' && equal(coerce(item, right)[0], right));
  }
  throw mismatch(left, right);
}

function order(left: ExprValue, right: ExprValue): number {
  if (left.kind === 'text' && right.kind === 'text') {
    // Two stored temporal values are two ISO texts (§5.2): order them as the temporal type both parse as.
    const x = asTemporal(left.value);
    const y = x && asTemporal(right.value);
    if (x && y) {
      return order(x, y); // different kinds still mismatch
    }
  }
  if (left.kind === 'number' && right.kind === 'number') {
    return left.value.comparedTo(right.value);
  }
  if (left.kind === 'date' && right.kind === 'date') {
    return Math.sign(left.day - right.day);
  }
  if (left.kind === 'datetime' && right.kind === 'datetime') {
    const [a, b] = [utcTicks(left.instant), utcTicks(right.instant)];
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (left.kind === 'time' && right.kind === 'time') {
    return Math.sign(left.ticks - right.ticks);
  }
  throw mismatch(left, right);
}

// Values

function read(current: unknown, segments: readonly string[], index: number): ExprValue {
  for (let i = index; i < segments.length; i++) {
    if (segments[i] === '[]') {
      return Array.isArray(current) ? { kind: 'list', items: current.map((row) => read(row, segments, i + 1)) } : MISSING;
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !Object.hasOwn(current, segments[i])) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[segments[i]];
  }
  return fromJson(current);
}

function arithmetic(op: string, left: ExprValue, right: ExprValue): ExprValue {
  if (left.kind === 'missing' || right.kind === 'missing') {
    return MISSING;
  }
  if (left.kind !== 'number' || right.kind !== 'number') {
    throw mismatch(left, right);
  }
  switch (op) {
    case 'add':
      return num(netDecimal(left.value.plus(right.value)));
    case 'subtract':
      return num(netDecimal(left.value.minus(right.value)));
    case 'multiply':
      return num(netDecimal(left.value.times(right.value)));
    default:
      if (right.value.isZero()) {
        throw new ExpressionError('division_by_zero', 'Division by zero.');
      }
      return num(netDecimal(left.value.div(right.value)));
  }
}

/** Date and datetime offsets (§3a); month and year steps clamp to the last valid day. */
function applyOffset(value: ExprValue, offset: DateOffset): ExprValue {
  if (value.kind === 'text') {
    const parsed = fromNullable(parseDate(value.value), date) ?? fromNullable(parseDateTime(value.value), datetime);
    if (!parsed) {
      throw new ExpressionError('type_mismatch', `'${value.value}' is not a date.`);
    }
    value = parsed;
  }

  const { amount, unit } = offset;
  switch (value.kind) {
    case 'missing':
      return value;
    case 'date':
      switch (unit) {
        case 'days':
          return date(addDays(value.day, amount));
        case 'months':
          return date(addMonths(value.day, amount));
        case 'years':
          return date(addMonths(value.day, amount * 12));
        default:
          throw new ExpressionError('type_mismatch', 'Dates move by days, months or years.');
      }
    case 'datetime':
      switch (unit) {
        case 'days':
          return datetime(addTicks(value.instant, BigInt(amount) * TICKS_PER_DAY));
        case 'months':
          return datetime(addInstantMonths(value.instant, amount));
        case 'years':
          return datetime(addInstantMonths(value.instant, amount * 12));
        case 'hours':
          return datetime(addTicks(value.instant, BigInt(amount) * TICKS_PER_HOUR));
        default:
          return datetime(addTicks(value.instant, BigInt(amount) * TICKS_PER_MINUTE));
      }
    default:
      throw new ExpressionError('type_mismatch', `A ${value.kind} cannot carry a date offset.`);
  }
}

function mismatch(left: ExprValue, right: ExprValue): ExpressionError {
  return new ExpressionError('type_mismatch', `Cannot combine ${left.kind} and ${right.kind}.`);
}
