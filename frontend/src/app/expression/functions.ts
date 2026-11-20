import { Num, netDecimal, parseNumber } from './decimal';
import { ExpressionError } from './errors';
import type { EvaluationContext } from './evaluator';
import { atClock, clockDate, clockTime, parseDate, parseDateTime, parseTime, toOffset } from './temporal';
import { ExprValue, MISSING, canonical, date, datetime, num, text, time } from './values';

/** The POC's functions (expression-language.md §3b). Nothing else is callable. */
export function call(fn: string, args: readonly ExprValue[], context: EvaluationContext): ExprValue {
  switch (fn) {
    case 'abs':
      return unary(args, (value) => value.abs());
    case 'floor':
      return unary(args, (value) => value.floor());
    case 'ceil':
      return unary(args, (value) => value.ceil());
    case 'round':
      return round(args);
    case 'min':
      return aggregate(args, (numbers) => numbers.reduce((a, b) => (b.lt(a) ? b : a)), false);
    case 'max':
      return aggregate(args, (numbers) => numbers.reduce((a, b) => (b.gt(a) ? b : a)), false);
    case 'avg':
      return aggregate(args, (numbers) => netDecimal(sum(numbers).div(numbers.length)), false);
    case 'sum':
      return aggregate(args, sum, true);
    case 'count':
      return count(args[0]);
    case 'string':
      return stringOf(args[0]);
    case 'number':
      return numberOf(args[0]);
    case 'date':
      return dateOf(args[0], context);
    case 'time':
      return timeOf(args[0], context);
    case 'datetime':
      return args.length === 2 ? dateTimeOfParts(args[0], args[1], context) : dateTimeOf(args[0]);
    default:
      throw new ExpressionError('type_mismatch', `Unknown function '${fn}'.`);
  }
}

function unary(args: readonly ExprValue[], operation: (value: Num) => Num): ExprValue {
  const [value] = args;
  if (value.kind === 'missing') {
    return MISSING;
  }
  if (value.kind !== 'number') {
    throw new ExpressionError('type_mismatch', `Expected a number, not ${value.kind}.`);
  }
  return num(netDecimal(operation(value.value)));
}

/** Rounds half away from zero, as C#'s `MidpointRounding.AwayFromZero` (§3b). */
function round(args: readonly ExprValue[]): ExprValue {
  let places = 0;
  if (args.length === 2) {
    const p = args[1];
    if (p.kind !== 'number' || !p.value.isInteger() || p.value.lt(0) || p.value.gt(28)) {
      throw new ExpressionError('type_mismatch', 'round places must be a whole number from 0 to 28.');
    }
    places = p.value.toNumber();
  }
  return unary(args, (value) => value.toDecimalPlaces(places, Num.ROUND_HALF_UP));
}

/** Checked addition, as .NET's `Sum()` over decimals. */
function sum(numbers: readonly Num[]): Num {
  return numbers.reduce((total, value) => netDecimal(total.plus(value)), new Num(0));
}

/** Aggregates either one list argument or several number arguments; missing items are skipped. */
function aggregate(args: readonly ExprValue[], operation: (numbers: Num[]) => Num, allowsEmpty: boolean): ExprValue {
  const items = args.length === 1 && args[0].kind === 'list' ? args[0].items : args.length === 1 && args[0].kind === 'missing' ? [] : args;
  const numbers: Num[] = [];
  for (const item of items) {
    if (item.kind === 'missing') {
      continue;
    }
    if (item.kind !== 'number') {
      throw new ExpressionError('type_mismatch', `Expected numbers, found ${item.kind}.`);
    }
    numbers.push(item.value);
  }
  if (numbers.length === 0) {
    if (allowsEmpty) {
      return num(new Num(0));
    }
    throw new ExpressionError('empty_list', 'The list is empty.');
  }
  return num(operation(numbers));
}

function count(value: ExprValue): ExprValue {
  switch (value.kind) {
    case 'missing':
      return num(new Num(0));
    case 'list':
      return num(new Num(value.items.length));
    default:
      throw new ExpressionError('type_mismatch', `count needs a list, not ${value.kind}.`);
  }
}

function stringOf(value: ExprValue): ExprValue {
  switch (value.kind) {
    case 'missing':
      return MISSING;
    case 'list':
    case 'object':
      throw new ExpressionError('type_mismatch', 'string needs a single value.');
    default:
      return text(canonical(value));
  }
}

function numberOf(value: ExprValue): ExprValue {
  switch (value.kind) {
    case 'missing':
    case 'number':
      return value;
    case 'text': {
      const parsed = parseNumber(value.value);
      if (parsed === null) {
        throw new ExpressionError('invalid_number', `'${value.value}' is not a number.`);
      }
      return num(parsed);
    }
    default:
      throw new ExpressionError('type_mismatch', `number needs text, not ${value.kind}.`);
  }
}

/** A datetime is converted in the evaluation zone (§3b). */
function dateOf(value: ExprValue, context: EvaluationContext): ExprValue {
  switch (value.kind) {
    case 'missing':
    case 'date':
      return value;
    case 'datetime':
      return date(clockDate(toOffset(value.instant, context.zone)));
    case 'text': {
      const day = parseDate(value.value);
      if (day !== null) {
        return date(day);
      }
      const instant = parseDateTime(value.value);
      if (instant !== null) {
        return date(clockDate(toOffset(instant, context.zone)));
      }
      throw new ExpressionError('invalid_date', `'${value.value}' is not a date.`);
    }
    default:
      throw new ExpressionError('type_mismatch', `date needs text or a datetime, not ${value.kind}.`);
  }
}

function timeOf(value: ExprValue, context: EvaluationContext): ExprValue {
  switch (value.kind) {
    case 'missing':
    case 'time':
      return value;
    case 'datetime':
      return time(clockTime(toOffset(value.instant, context.zone)));
    case 'text': {
      const ticks = parseTime(value.value);
      if (ticks === null) {
        throw new ExpressionError('invalid_date', `'${value.value}' is not a time.`);
      }
      return time(ticks);
    }
    default:
      throw new ExpressionError('type_mismatch', `time needs text or a datetime, not ${value.kind}.`);
  }
}

/** `datetime(date, time)` on the evaluation zone's clock; text arguments are parsed by position (§5.2). */
function dateTimeOfParts(first: ExprValue, second: ExprValue, context: EvaluationContext): ExprValue {
  if (first.kind === 'missing' || second.kind === 'missing') {
    return MISSING;
  }
  if ((first.kind !== 'date' && first.kind !== 'text') || (second.kind !== 'time' && second.kind !== 'text')) {
    throw new ExpressionError('type_mismatch', 'datetime(date, time) needs a date and a time.');
  }
  const day = first.kind === 'date' ? first.day : parseDate(first.value);
  if (day === null) {
    throw new ExpressionError('invalid_date', `'${first.kind === 'text' ? first.value : ''}' is not a date.`);
  }
  const ticks = second.kind === 'time' ? second.ticks : parseTime(second.value);
  if (ticks === null) {
    throw new ExpressionError('invalid_date', `'${second.kind === 'text' ? second.value : ''}' is not a time.`);
  }
  return datetime(atClock(day, ticks, context.zone));
}

function dateTimeOf(value: ExprValue): ExprValue {
  switch (value.kind) {
    case 'missing':
    case 'datetime':
      return value;
    case 'text': {
      const instant = parseDateTime(value.value);
      if (instant === null) {
        throw new ExpressionError('invalid_date', `'${value.value}' is not a datetime.`);
      }
      return datetime(instant);
    }
    default:
      throw new ExpressionError('type_mismatch', `datetime needs text, not ${value.kind}.`);
  }
}
