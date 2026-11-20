/** A function of expression-language.md §3b, as the value builder offers it (form-designer.md §12.6). */
export interface FunctionSpec {
  readonly name: string;
  /** What it does, in pt-BR. */
  readonly label: string;
  /** Each argument's name. */
  readonly args: readonly string[];
  /** How many of the last arguments may be left out. */
  readonly optional?: number;
  /** Whether it takes more of its last argument (min and max). */
  readonly variadic?: boolean;
  /** The type it produces. */
  readonly result: string;
}

/** Every function of expression-language.md §3b; there are no others in the first release. */
export const FUNCTIONS: readonly FunctionSpec[] = [
  { name: 'abs', label: 'valor absoluto', args: ['Número'], result: 'number' },
  { name: 'round', label: 'arredondar', args: ['Número', 'Casas decimais'], optional: 1, result: 'number' },
  { name: 'floor', label: 'arredondar para baixo', args: ['Número'], result: 'number' },
  { name: 'ceil', label: 'arredondar para cima', args: ['Número'], result: 'number' },
  { name: 'min', label: 'o menor', args: ['Valor'], variadic: true, result: 'number' },
  { name: 'max', label: 'o maior', args: ['Valor'], variadic: true, result: 'number' },
  { name: 'sum', label: 'soma de uma lista', args: ['Lista'], result: 'number' },
  { name: 'avg', label: 'média de uma lista', args: ['Lista'], result: 'number' },
  { name: 'count', label: 'quantidade de itens', args: ['Lista'], result: 'number' },
  { name: 'string', label: 'como texto', args: ['Valor'], result: 'text' },
  { name: 'number', label: 'como número', args: ['Texto'], result: 'number' },
  { name: 'date', label: 'como data', args: ['Valor'], result: 'date' },
  { name: 'time', label: 'como hora', args: ['Valor'], result: 'time' },
  { name: 'datetime', label: 'como data e hora', args: ['Data ou texto', 'Hora'], optional: 1, result: 'datetime' },
];

/**
 * The type a value tree produces, with every path `unknown`, as workflow-definition.md §6.1 types a computed field: a
 * function's result, `number` for arithmetic, a literal's or a system value's own type.
 */
export function inferType(tree: unknown): string {
  if (!isObject(tree)) {
    return 'unknown';
  }
  switch (tree['kind']) {
    case 'literal':
      return typeof tree['type'] === 'string' ? tree['type'] : 'unknown';
    case 'system':
      return tree['name'] === 'currentDate' ? 'date' : 'datetime';
    case 'arithmetic':
      return 'number';
    case 'call':
      return FUNCTIONS.find((spec) => spec.name === tree['function'])?.result ?? 'unknown';
    default:
      return 'unknown';
  }
}

/** Every path a value tree reads, in the order they appear. */
export function pathsIn(tree: unknown): string[][] {
  if (Array.isArray(tree)) {
    return tree.flatMap(pathsIn);
  }
  if (!isObject(tree)) {
    return [];
  }
  if (tree['kind'] === 'path' && Array.isArray(tree['path'])) {
    return [[...(tree['path'] as string[])]];
  }
  return Object.values(tree).flatMap(pathsIn);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
