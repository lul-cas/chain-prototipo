/**
 * How the editor names each type, after a datum's path or a contract's key, and the plural, which names a list's elements
 * (workflow-editor.md §10.7, expression-language.md §2).
 */
const TYPE_NAMES: Readonly<Record<string, readonly [name: string, plural: string]>> = {
  text: ['texto', 'textos'],
  number: ['número', 'números'],
  boolean: ['sim ou não', 'valores sim ou não'],
  date: ['data', 'datas'],
  datetime: ['data e hora', 'datas e horas'],
  time: ['hora', 'horas'],
  object: ['objeto', 'objetos'],
  file: ['arquivo', 'arquivos'],
  unknown: ['tipo desconhecido', 'valores de tipo desconhecido'],
};

/** `list<T>`, as the data catalog and the contracts write a list (workflow-definition.md §6.5). */
const LIST = /^list<(.+)>$/;

/**
 * The editor's name for a type from the data catalog or a contract: "lista de" and the plural of its element for a list
 * (card #213), or the type itself when it has none. Only the table's own entries count: a name every object inherits, such
 * as `constructor`, has none (ADR-0010 D9, card #201).
 */
export function typeLabel(type: string): string {
  return nameOf(type, 0);
}

/** A type's name (0) or plural (1); a list's element is named in the plural, and shown as it is when it has no name. */
function nameOf(type: string, form: 0 | 1): string {
  const element = LIST.exec(type)?.[1];
  if (element !== undefined) {
    return `${form === 0 ? 'lista' : 'listas'} de ${nameOf(element, 1)}`;
  }
  return Object.hasOwn(TYPE_NAMES, type) ? TYPE_NAMES[type][form] : type;
}
