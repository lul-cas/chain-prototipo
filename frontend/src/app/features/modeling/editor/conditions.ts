import { EVALUATION_ZONE_MINUTES, parseDateTime } from '../../../expression';
import { parseNumber } from '../../../expression/decimal';
import { MAX_OFFSET } from '../../../expression/parser';

/**
 * The condition builder's model (workflow-editor.md §10.7, expression-language.md §3–§6). Conditions are read from the JSON
 * that documents store (§5) into rows the builder edits, which may be incomplete, and written back once complete. What the
 * builder cannot edit (functions, arithmetic, offsets it can't edit, unknown nodes) is kept as it is and shown read-only.
 */

/** An entry of the data catalog at a gateway (workflow-definition.md §6.5). */
export interface CatalogEntry {
  readonly path: readonly string[];
  readonly type: string;
  readonly presence: 'definite' | 'optional';
  readonly sources: readonly string[];
  /** The key is sensitive (sensitive-data.md §2); the server leaves it out when false. */
  readonly sensitive?: boolean;
}

export type Operator = 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan' | 'greaterOrEqual' | 'lessOrEqual' | 'isEmpty' | 'isNotEmpty';
export type LiteralType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'time';
export type SystemName = 'currentDate' | 'currentDateTime';
export type OffsetUnit = 'days' | 'months' | 'years' | 'hours' | 'minutes';

/** A date or datetime operand's adjustment (§3a), as entered: *mais* or *menos*, a quantity that may be incomplete, a unit. */
export interface Offset {
  readonly sign: '+' | '-';
  readonly amount: string;
  readonly unit: OffsetUnit;
}

/** An operand the builder edits, or keeps as it is. A datum or a system value may carry an offset (workflow-editor.md §10.8). */
export type Operand =
  | { readonly kind: 'path'; readonly path: readonly string[]; readonly offset?: Offset }
  | { readonly kind: 'literal'; readonly type: LiteralType; readonly value: string }
  | { readonly kind: 'system'; readonly name: SystemName; readonly offset?: Offset }
  | { readonly kind: 'kept'; readonly json: unknown };

/** A row of the builder: a group, a comparison that may be incomplete, or a condition it keeps as it is. */
export type Row =
  | { readonly kind: 'group'; readonly op: 'and' | 'or'; readonly items: readonly Row[] }
  | { readonly kind: 'compare'; readonly left: Operand | null; readonly operator: Operator | null; readonly right: Operand | null }
  | { readonly kind: 'kept'; readonly json: unknown };

export type Group = Extract<Row, { kind: 'group' }>;
export type Comparison = Extract<Row, { kind: 'compare' }>;

/** A row's problem: an error keeps the condition from being written; a warning is for publishing to report (WF201). */
export type Problem = { readonly error: string } | { readonly warning: string };

/** The pt-BR labels of the operators (§3), in the order the builder lists them. */
export const OPERATOR_LABEL: Readonly<Record<Operator, string>> = {
  equals: 'igual a',
  notEquals: 'diferente de',
  contains: 'contém',
  greaterThan: 'maior que',
  lessThan: 'menor que',
  greaterOrEqual: 'maior ou igual a',
  lessOrEqual: 'menor ou igual a',
  isEmpty: 'está vazio',
  isNotEmpty: 'não está vazio',
};

const SYMBOL: Readonly<Record<Operator, string>> = {
  equals: '=',
  notEquals: '≠',
  contains: '∋',
  greaterThan: '>',
  lessThan: '<',
  greaterOrEqual: '≥',
  lessOrEqual: '≤',
  isEmpty: 'está vazio',
  isNotEmpty: 'não está vazio',
};

const ALL = Object.keys(OPERATOR_LABEL) as Operator[];
const EMPTINESS: readonly Operator[] = ['isEmpty', 'isNotEmpty'];
const ORDERED: readonly Operator[] = ['equals', 'notEquals', 'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual', ...EMPTINESS];
const LITERAL_TYPES: readonly string[] = ['text', 'number', 'boolean', 'date', 'datetime', 'time'];
/** The units of an offset, singular and plural (§3a). */
export const OFFSET_UNIT: Readonly<Record<OffsetUnit, readonly [string, string]>> = {
  days: ['dia', 'dias'],
  months: ['mês', 'meses'],
  years: ['ano', 'anos'],
  hours: ['hora', 'horas'],
  minutes: ['minuto', 'minutos'],
};
const DATE_UNITS: readonly OffsetUnit[] = ['days', 'months', 'years'];
const ARITHMETIC: Readonly<Record<string, string>> = { add: '+', subtract: '−', multiply: '×', divide: '÷' };

/** Whether an operator takes no right operand. */
export function isUnary(operator: Operator): boolean {
  return EMPTINESS.includes(operator);
}

/** The operators valid for a left operand of this type (§3); every one for a value whose type is unknown. */
export function operatorsFor(type: string): Operator[] {
  if (type.startsWith('list<')) {
    return ['contains', ...EMPTINESS];
  }
  switch (type) {
    case 'text':
      return ['equals', 'notEquals', 'contains', ...EMPTINESS];
    case 'boolean':
      return ['equals', 'notEquals', ...EMPTINESS];
    case 'number':
    case 'date':
    case 'datetime':
    case 'time':
      return [...ORDERED];
    case 'object':
      return [];
    default:
      return [...ALL];
  }
}

/** The type a right operand takes for a left operand of this type: a list's element type for `contains`. */
export function rightTypeFor(type: string): string {
  const element = /^list<(.+)>$/.exec(type);
  return element ? element[1] : type;
}

/** The literal type a value of this type is entered as: text when the type has no literal of its own. */
export function literalTypeFor(type: string): LiteralType {
  return (LITERAL_TYPES.includes(type) ? type : 'text') as LiteralType;
}

/** The units an offset takes on a value of this type: days, months and years for a date, also hours and minutes for a datetime. */
export function offsetUnits(type: string): readonly OffsetUnit[] {
  return type === 'date' ? DATE_UNITS : type === 'datetime' ? [...DATE_UNITS, 'hours', 'minutes'] : [];
}

/** Reads a condition into rows; a single comparison becomes a group of one, and nothing an empty `and` group. */
export function toRows(json: unknown): Group {
  if (!isObject(json)) {
    return { kind: 'group', op: 'and', items: [] };
  }
  const row = rowOf(json);
  return row.kind === 'group' ? row : { kind: 'group', op: 'and', items: [row] };
}

/** Writes rows back as a condition, or says they are incomplete: a missing operand, a missing value or an invalid number. */
export function toJson(group: Group): { readonly json: unknown } | { readonly incomplete: true } {
  const json = groupJson(group);
  return json === null ? { incomplete: true } : { json };
}

/** A text rendering of rows (§5): `data.valor ≤ 50000 E data.DataVencimento ≥ currentDate`. */
export function render(row: Row, nested = false): string {
  switch (row.kind) {
    case 'group': {
      const text = row.items.map((item) => render(item, true)).join(row.op === 'and' ? ' E ' : ' OU ');
      return nested && row.items.length > 1 ? `(${text})` : text;
    }
    case 'compare': {
      const left = row.left ? operandText(row.left) : '…';
      if (!row.operator) {
        return `${left} … …`;
      }
      if (isUnary(row.operator)) {
        return `${left} ${SYMBOL[row.operator]}`;
      }
      return `${left} ${SYMBOL[row.operator]} ${row.right ? operandText(row.right) : '…'}`;
    }
    default:
      return valueText(row.json);
  }
}

/**
 * Each row's problem, keyed by its place in the tree (indices joined with '.', '' for the outermost group): an error
 * for what keeps the condition from being written, a warning for what publishing reports (WF201).
 */
export function problemsOf(group: Group, catalog: readonly CatalogEntry[]): Map<string, Problem> {
  const problems = new Map<string, Problem>();
  const visit = (row: Row, key: string) => {
    if (row.kind === 'group') {
      if (row.items.length === 0) {
        problems.set(key, { warning: 'Grupo vazio.' });
      }
      row.items.forEach((item, index) => visit(item, key === '' ? `${index}` : `${key}.${index}`));
    } else if (row.kind === 'compare') {
      const problem = comparisonProblem(row, catalog);
      if (problem) {
        problems.set(key, problem);
      }
    }
  };
  visit(group, '');
  return problems;
}

/** The type of an operand, from the catalog for a path; `unknown` when it can't be told. */
export function typeOf(operand: Operand, catalog: readonly CatalogEntry[]): string {
  switch (operand.kind) {
    case 'path':
      return catalog.find((entry) => sameItems(entry.path, operand.path))?.type ?? 'unknown';
    case 'literal':
      return operand.type;
    case 'system':
      return operand.name === 'currentDate' ? 'date' : 'datetime';
    default:
      return 'unknown';
  }
}

/** The row at a place in the tree changed by `change`. */
export function updateAt(group: Group, place: readonly number[], change: (row: Row) => Row): Group {
  if (place.length === 0) {
    return change(group) as Group;
  }
  const [index, ...rest] = place;
  return {
    ...group,
    items: group.items.map((item, i) => (i !== index ? item : rest.length === 0 ? change(item) : updateAt(item as Group, rest, change))),
  };
}

/** The tree without the row at a place. */
export function removeAt(group: Group, place: readonly number[]): Group {
  const parent = place.slice(0, -1);
  const index = place[place.length - 1];
  return updateAt(group, parent, (row) => ({ ...(row as Group), items: (row as Group).items.filter((_, i) => i !== index) }));
}

/** The tree with a row added at the end of the group at a place. */
export function addAt(group: Group, place: readonly number[], row: Row): Group {
  return updateAt(group, place, (target) => ({ ...(target as Group), items: [...(target as Group).items, row] }));
}

/** A datetime entered in the evaluation zone (§2, UTC−03:00), from `yyyy-MM-ddTHH:mm`, as the literal stores it. */
export function fromZoneLocal(local: string): string {
  return `${local}${zoneOffsetText()}`;
}

/** A stored datetime as `yyyy-MM-ddTHH:mm` in the evaluation zone, for a datetime input; null when it isn't one. */
export function toZoneLocal(value: string): string | null {
  if (!parseDateTime(value)) {
    return null;
  }
  const local = new Date(Date.parse(value) + EVALUATION_ZONE_MINUTES * 60_000);
  return local.toISOString().slice(0, 16);
}

function rowOf(json: Record<string, unknown>): Row {
  if (json['kind'] === 'group' && (json['op'] === 'and' || json['op'] === 'or') && Array.isArray(json['items'])) {
    return { kind: 'group', op: json['op'], items: json['items'].map((item) => (isObject(item) ? rowOf(item) : { kind: 'kept', json: item })) };
  }
  if (json['kind'] === 'compare' && ALL.includes(json['operator'] as Operator)) {
    const operator = json['operator'] as Operator;
    return { kind: 'compare', left: toOperand(json['left']), operator, right: 'right' in json ? toOperand(json['right']) : null };
  }
  return { kind: 'kept', json };
}

/** Reads one value node into an operand the builder edits, or keeps (§10.7, §10.8). */
export function toOperand(json: unknown): Operand {
  if (!isObject(json)) {
    return { kind: 'kept', json };
  }
  const offset = 'offset' in json ? offsetOf(json['offset']) : undefined;
  const adjusted = offset ? { offset } : {};
  if (offset === null) {
    return { kind: 'kept', json };
  }
  if (json['kind'] === 'path' && Array.isArray(json['path']) && json['path'].every((segment) => typeof segment === 'string')) {
    return { kind: 'path', path: json['path'] as string[], ...adjusted };
  }
  if (json['kind'] === 'literal' && !offset && LITERAL_TYPES.includes(json['type'] as string) && typeof json['value'] === 'string') {
    return { kind: 'literal', type: json['type'] as LiteralType, value: json['value'] };
  }
  if (json['kind'] === 'system' && (json['name'] === 'currentDate' || json['name'] === 'currentDateTime')) {
    return { kind: 'system', name: json['name'], ...adjusted };
  }
  return { kind: 'kept', json };
}

/** An offset the builder edits (§5.1): only `amount`, an integer up to 10 000 either way, and a known `unit`; null otherwise. */
function offsetOf(json: unknown): Offset | null {
  if (!isObject(json) || Object.keys(json).some((key) => key !== 'amount' && key !== 'unit')) {
    return null;
  }
  const { amount, unit } = json;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || Math.abs(amount) > MAX_OFFSET || !Object.hasOwn(OFFSET_UNIT, unit as string)) {
    return null;
  }
  return { sign: amount < 0 ? '-' : '+', amount: String(Math.abs(amount)), unit: unit as OffsetUnit };
}

function groupJson(group: Group): unknown {
  const items = group.items.map(rowJson);
  return items.includes(null) ? null : { kind: 'group', op: group.op, items };
}

function rowJson(row: Row): unknown {
  switch (row.kind) {
    case 'group':
      return groupJson(row);
    case 'compare': {
      const problem = comparisonProblem(row, []);
      if (!row.left || !row.operator || (problem !== null && 'error' in problem)) {
        return null; // incomplete: it can't be written as a condition yet
      }
      const left = fromOperand(row.left);
      return isUnary(row.operator)
        ? { kind: 'compare', left, operator: row.operator }
        : { kind: 'compare', left, operator: row.operator, right: fromOperand(row.right!) };
    }
    default:
      return row.json;
  }
}

/** Writes an operand back as a value node (§5.1). */
export function fromOperand(operand: Operand): unknown {
  switch (operand.kind) {
    case 'path':
      return { kind: 'path', path: [...operand.path], ...offsetJson(operand.offset) };
    case 'literal':
      return { kind: 'literal', type: operand.type, value: operand.value };
    case 'system':
      return { kind: 'system', name: operand.name, ...offsetJson(operand.offset) };
    default:
      return operand.json;
  }
}

function offsetJson(offset: Offset | undefined): object {
  return offset ? { offset: { amount: (offset.sign === '-' ? -1 : 1) * Number(offset.amount), unit: offset.unit } } : {};
}

/** An offset's error: a quantity missing, or not a whole number from 0 to 10 000. */
function offsetProblem(operand: Operand | null): Problem | null {
  const offset = operand?.kind === 'path' || operand?.kind === 'system' ? operand.offset : undefined;
  if (!offset) {
    return null;
  }
  if (offset.amount === '') {
    return { error: 'Informe a quantidade do ajuste.' };
  }
  return /^[0-9]+$/.test(offset.amount) && Number(offset.amount) <= MAX_OFFSET ? null : { error: 'Quantidade inválida: um número inteiro de 0 a 10.000.' };
}

function comparisonProblem(row: Comparison, catalog: readonly CatalogEntry[]): Problem | null {
  if (!row.left || (row.left.kind === 'path' && row.left.path.length === 0)) {
    return { error: 'Escolha o dado.' };
  }
  if (!row.operator) {
    return { error: 'Escolha o operador.' };
  }
  const leftOffset = offsetProblem(row.left);
  if (leftOffset || isUnary(row.operator)) {
    return leftOffset;
  }
  if (!row.right) {
    return { error: 'Informe o valor.' };
  }
  const left = typeOf(row.left, catalog);
  return valueProblem(row.right, row.operator === 'contains' ? rightTypeFor(left) : left, catalog);
}

/**
 * A value's problem against the type it should have, for a comparison's right side or a step's input (§10.9): not filled in
 * or invalid (errors), or of another type (a warning, which publishing reports).
 */
export function valueProblem(value: Operand, wanted: string, catalog: readonly CatalogEntry[]): Problem | null {
  // A value of a chosen kind, not filled yet: an empty literal, or another datum not picked.
  if ((value.kind === 'literal' && value.value === '') || (value.kind === 'path' && value.path.length === 0)) {
    return { error: 'Informe o valor.' };
  }
  const offset = offsetProblem(value);
  if (offset) {
    return offset;
  }
  if (value.kind === 'literal' && value.type === 'number' && parseNumber(value.value) === null) {
    return { error: 'Número inválido.' };
  }
  const actual = typeOf(value, catalog);
  return wanted !== 'unknown' && actual !== 'unknown' && wanted !== actual ? { warning: 'Os tipos não combinam.' } : null;
}

function operandText(operand: Operand): string {
  switch (operand.kind) {
    case 'path':
      return pathText(operand.path) + (operand.offset ? offsetText(operand.offset) : '');
    case 'literal':
      return literalText(operand.type, operand.value);
    case 'system':
      return operand.name + (operand.offset ? offsetText(operand.offset) : '');
    default:
      return valueText(operand.json);
  }
}

/** A value node as text, as the preview shows it: functions, arithmetic and offsets included. */
export function valueText(json: unknown): string {
  if (!isObject(json)) {
    return '?';
  }
  const offset = isObject(json['offset']) ? storedOffsetText(json['offset']) : '';
  switch (json['kind']) {
    case 'path':
      return Array.isArray(json['path']) ? pathText(json['path'] as string[]) + offset : '?';
    case 'literal':
      return literalText(String(json['type']), String(json['value'])) + offset;
    case 'system':
      return String(json['name']) + offset;
    case 'call':
      return `${String(json['function'])}(${(Array.isArray(json['args']) ? json['args'] : []).map(valueText).join(', ')})${offset}`;
    case 'arithmetic':
      return `(${valueText(json['left'])} ${arithmeticSymbol(json['op'])} ${valueText(json['right'])})${offset}`;
    case 'group':
    case 'compare': {
      // A node the builder can't read comes back kept, and reading it again would never end (#247).
      const row = rowOf(json);
      return row.kind === 'kept' ? '?' : render(row, true);
    }
    default:
      return '?';
  }
}

/** ` − 30 dias`, with the singular for a quantity of 1. */
function offsetText(offset: Offset): string {
  const amount = offset.amount === '' ? '…' : offset.amount;
  const [one, many] = OFFSET_UNIT[offset.unit];
  return ` ${offset.sign === '-' ? '−' : '+'} ${amount} ${offset.amount === '1' ? one : many}`;
}

/**
 * A stored arithmetic operator's symbol, or `?` for one the builder doesn't know, even a name every object inherits, such
 * as `constructor` (card #201).
 */
function arithmeticSymbol(op: unknown): string {
  const name = String(op);
  return Object.hasOwn(ARITHMETIC, name) ? ARITHMETIC[name] : '?';
}

/** A stored offset the builder keeps as it is, as text. */
function storedOffsetText(offset: Record<string, unknown>): string {
  const amount = Number(offset['amount']);
  const unit = String(offset['unit']);
  const names = Object.hasOwn(OFFSET_UNIT, unit) ? OFFSET_UNIT[unit as OffsetUnit] : [unit, unit];
  return ` ${amount < 0 ? '−' : '+'} ${Math.abs(amount)} ${Math.abs(amount) === 1 ? names[0] : names[1]}`;
}

function pathText(path: readonly string[]): string {
  return `data.${path.join('.').replace(/\.\[\]/g, '[]')}`;
}

function literalText(type: string, value: string): string {
  if (type === 'text') {
    return `"${value}"`;
  }
  if (type === 'boolean') {
    return value === 'true' ? 'verdadeiro' : 'falso';
  }
  return value;
}

function zoneOffsetText(): string {
  const minutes = Math.abs(EVALUATION_ZONE_MINUTES);
  const sign = EVALUATION_ZONE_MINUTES < 0 ? '-' : '+';
  return `${sign}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
