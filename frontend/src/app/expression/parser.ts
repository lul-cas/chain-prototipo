import { parseNumber } from './decimal';
import { parseDate, parseDateTime, parseTime } from './temporal';
import { ExprValue, bool, date, datetime, num, text, time } from './values';

// Condition and expression trees (ADR-0003; expression-language.md §5.1).

export type ConditionNode =
  | { readonly kind: 'group'; readonly and: boolean; readonly items: readonly ConditionNode[] }
  | { readonly kind: 'compare'; readonly left: ValueNode; readonly operator: string; readonly right: ValueNode | null };

/** A date offset (§3a). A negative amount subtracts. */
export interface DateOffset {
  readonly amount: number;
  readonly unit: string;
}

export type ValueNode = (
  | { readonly kind: 'path'; readonly segments: readonly string[] }
  | { readonly kind: 'literal'; readonly value: ExprValue }
  | { readonly kind: 'system'; readonly name: 'currentDate' | 'currentDateTime' }
  | { readonly kind: 'call'; readonly fn: string; readonly args: readonly ValueNode[] }
  | { readonly kind: 'arithmetic'; readonly op: string; readonly left: ValueNode; readonly right: ValueNode }
) & { readonly offset?: DateOffset };

export type ParseResult<T> = { readonly ok: true; readonly node: T } | { readonly ok: false; readonly error: string };

export const MAX_GROUP_DEPTH = 10;
export const MAX_COMPARISONS = 50;
export const MAX_NODES = 200;
export const MAX_VALUE_DEPTH = 10;
export const MAX_PATH_SEGMENTS = 10;
export const MAX_OFFSET = 10_000;

const UNARY = new Set(['isEmpty', 'isNotEmpty']);
const BINARY = new Set(['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual']);
const FUNCTIONS: Readonly<Record<string, readonly [number, number]>> = {
  abs: [1, 1], round: [1, 2], floor: [1, 1], ceil: [1, 1],
  min: [1, 50], max: [1, 50], sum: [1, 1], avg: [1, 1], count: [1, 1],
  string: [1, 1], number: [1, 1], date: [1, 1], time: [1, 1], datetime: [1, 2],
};
const DATE_UNITS = new Set(['days', 'months', 'years']);
const DATETIME_UNITS = new Set(['days', 'months', 'years', 'hours', 'minutes']);

class ParseError extends Error {}

/** Parses an untrusted condition tree: known node kinds and properties only, valid literals and arities, and the limits. */
export function parseCondition(json: unknown): ParseResult<ConditionNode> {
  return run(() => new Parser().condition(json, 0));
}

/** Parses an untrusted value tree (operands, function arguments, computed fields). */
export function parseValue(json: unknown): ParseResult<ValueNode> {
  return run(() => new Parser().value(json, 0));
}

function run<T>(parse: () => T): ParseResult<T> {
  try {
    return { ok: true, node: parse() };
  } catch (error) {
    if (error instanceof ParseError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

class Parser {
  private nodes = 0;
  private comparisons = 0;

  condition(json: unknown, groupDepth: number): ConditionNode {
    this.count();
    const element = asObject(json);
    switch (str(element, 'kind')) {
      case 'group': {
        only(element, 'kind', 'op', 'items');
        if (groupDepth >= MAX_GROUP_DEPTH) {
          throw new ParseError(`Groups nest at most ${MAX_GROUP_DEPTH} levels.`);
        }
        const op = str(element, 'op');
        if (op !== 'and' && op !== 'or') {
          throw new ParseError("A group's op must be 'and' or 'or'.");
        }
        return { kind: 'group', and: op === 'and', items: list(element, 'items').map((item) => this.condition(item, groupDepth + 1)) };
      }
      case 'compare': {
        only(element, 'kind', 'left', 'operator', 'right');
        if (++this.comparisons > MAX_COMPARISONS) {
          throw new ParseError(`At most ${MAX_COMPARISONS} comparisons per expression.`);
        }
        const operator = str(element, 'operator');
        const hasRight = Object.hasOwn(element, 'right');
        if (UNARY.has(operator) ? hasRight : !BINARY.has(operator) || !hasRight) {
          throw new ParseError(`Invalid operator '${operator}' or operands.`);
        }
        if (!Object.hasOwn(element, 'left')) {
          throw new ParseError('A required property is missing.');
        }
        return { kind: 'compare', left: this.value(element['left'], 0), operator, right: hasRight ? this.value(element['right'], 0) : null };
      }
      default:
        throw new ParseError('A condition must be a group or a comparison.');
    }
  }

  value(json: unknown, depth: number): ValueNode {
    this.count();
    if (depth >= MAX_VALUE_DEPTH) {
      throw new ParseError(`Values nest at most ${MAX_VALUE_DEPTH} levels.`);
    }

    const element = asObject(json);
    let node: ValueNode;
    let allowsOffset = true;
    let dateUnitsOnly = false;
    switch (str(element, 'kind')) {
      case 'path': {
        only(element, 'kind', 'path', 'offset');
        const segments = list(element, 'path').map((segment) => {
          if (typeof segment !== 'string') {
            throw new ParseError('Path segments are text.');
          }
          return segment;
        });
        if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS || segments[0] === '[]' || segments.some((s) => s.length === 0 || s.length > 64)) {
          throw new ParseError('Invalid path.');
        }
        node = { kind: 'path', segments };
        break;
      }
      case 'literal': {
        only(element, 'kind', 'type', 'value', 'offset');
        const value = literal(str(element, 'type'), str(element, 'value'));
        allowsOffset = value.kind === 'date' || value.kind === 'datetime';
        dateUnitsOnly = value.kind === 'date';
        node = { kind: 'literal', value };
        break;
      }
      case 'system': {
        only(element, 'kind', 'name', 'offset');
        const name = str(element, 'name');
        if (name !== 'currentDate' && name !== 'currentDateTime') {
          throw new ParseError(`Unknown system value '${name}'.`);
        }
        dateUnitsOnly = name === 'currentDate';
        node = { kind: 'system', name };
        break;
      }
      case 'call': {
        only(element, 'kind', 'function', 'args', 'offset');
        const fn = str(element, 'function');
        const arity = Object.hasOwn(FUNCTIONS, fn) ? FUNCTIONS[fn] : undefined;
        if (!arity) {
          throw new ParseError(`Unknown function '${fn}'.`);
        }
        const args = list(element, 'args').map((arg) => this.value(arg, depth + 1));
        if (args.length < arity[0] || args.length > arity[1]) {
          throw new ParseError(`'${fn}' takes ${arity[0]}–${arity[1]} arguments.`);
        }
        allowsOffset = fn === 'date' || fn === 'datetime';
        dateUnitsOnly = fn === 'date';
        node = { kind: 'call', fn, args };
        break;
      }
      case 'arithmetic': {
        only(element, 'kind', 'op', 'left', 'right');
        const op = str(element, 'op');
        if (op !== 'add' && op !== 'subtract' && op !== 'multiply' && op !== 'divide') {
          throw new ParseError(`Unknown arithmetic op '${op}'.`);
        }
        if (!Object.hasOwn(element, 'left') || !Object.hasOwn(element, 'right')) {
          throw new ParseError('A required property is missing.');
        }
        node = { kind: 'arithmetic', op, left: this.value(element['left'], depth + 1), right: this.value(element['right'], depth + 1) };
        allowsOffset = false;
        break;
      }
      default:
        throw new ParseError('Unknown value kind.');
    }

    if (Object.hasOwn(element, 'offset')) {
      if (!allowsOffset) {
        throw new ParseError('Only date and datetime values can carry an offset.');
      }
      node = { ...node, offset: offsetOf(element['offset'], dateUnitsOnly ? DATE_UNITS : DATETIME_UNITS) };
    }
    return node;
  }

  private count(): void {
    if (++this.nodes > MAX_NODES) {
      throw new ParseError(`Expressions are limited to ${MAX_NODES} nodes.`);
    }
  }
}

function offsetOf(json: unknown, units: ReadonlySet<string>): DateOffset {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ParseError('An offset is an object.');
  }
  const offset = json as Record<string, unknown>;
  only(offset, 'amount', 'unit');
  const amount = offset['amount'];
  if (typeof amount !== 'number' || !Number.isInteger(amount) || Math.abs(amount) > MAX_OFFSET) {
    throw new ParseError('An offset amount is an integer up to 10000.');
  }
  const unit = str(offset, 'unit');
  if (!units.has(unit)) {
    throw new ParseError(`Unknown offset unit '${unit}'.`);
  }
  return { amount, unit };
}

function literal(type: string, value: string): ExprValue {
  switch (type) {
    case 'text':
      return text(value);
    case 'number':
      return parsed(parseNumber(value), num, 'number');
    case 'boolean':
      if (value === 'true' || value === 'false') {
        return bool(value === 'true');
      }
      throw new ParseError('Invalid boolean literal.');
    case 'date':
      return parsed(parseDate(value), date, 'date');
    case 'datetime':
      return parsed(parseDateTime(value), datetime, 'datetime');
    case 'time':
      return parsed(parseTime(value), time, 'time');
    default:
      throw new ParseError(`Unknown literal type '${type}'.`);
  }
}

function parsed<T>(value: T | null, make: (value: T) => ExprValue, type: string): ExprValue {
  if (value === null) {
    throw new ParseError(`Invalid ${type} literal.`);
  }
  return make(value);
}

function asObject(json: unknown): Record<string, unknown> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ParseError('A node is an object.');
  }
  return json as Record<string, unknown>;
}

function str(element: Record<string, unknown>, property: string): string {
  const value = element[property];
  if (typeof value !== 'string' || !Object.hasOwn(element, property)) {
    throw new ParseError(`'${property}' must be text.`);
  }
  return value;
}

function list(element: Record<string, unknown>, property: string): unknown[] {
  const value = element[property];
  if (!Array.isArray(value) || !Object.hasOwn(element, property)) {
    throw new ParseError(`'${property}' must be a list.`);
  }
  return value;
}

function only(element: Record<string, unknown>, ...allowed: string[]): void {
  for (const property of Object.keys(element)) {
    if (!allowed.includes(property)) {
      throw new ParseError(`Unknown property '${property}'.`);
    }
  }
}
