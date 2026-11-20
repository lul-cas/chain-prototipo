import { AutomationDocument, AutomationField } from './automation-document';

/** A problem the editor finds without the server (automation-ui.md §7.9): the server's code and path, and its cause in pt-BR. */
export interface LocalProblem {
  readonly code: string;
  readonly path: string;
  readonly text: string;
  /** For a query parameter or a header, whose problems share its path: `name` when the problem is in its name, not its value. */
  readonly part?: 'name';
}

export const MAX_INPUTS = 50;
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** The type names other than lists (automation.md §5.2); the editor's controls offer these and lists of them (§7.2). */
export const NAMED_TYPES: readonly string[] = ['text', 'number', 'boolean', 'date', 'datetime', 'time', 'object', 'unknown'];
const MAX_TYPE_NAME_LENGTH = 100;

/** An input or output key (AU001): a letter followed by up to 63 letters, digits or underscores. */
export function isKey(text: string): boolean {
  return KEY.test(text);
}

/** A type name of automation.md §5.2, as `AutomationRules.IsTypeName` reads it (AU002). */
export function isTypeName(type: string): boolean {
  if (NAMED_TYPES.includes(type)) {
    return true;
  }
  return type.length <= MAX_TYPE_NAME_LENGTH && type.startsWith('list<') && type.endsWith('>') && isTypeName(type.slice(5, -1));
}

/** AU001 and AU002 of the inputs, as `AutomationRules.CheckFields` finds them, in its order. */
export function inputProblems(document: AutomationDocument): LocalProblem[] {
  return fieldProblems(document.inputs, 'inputs', ['entradas', 'outra entrada']);
}

/** AU001 and AU002 of a list of inputs or outputs; `names` are the list's plural and "another one" in pt-BR. */
export function fieldProblems(fields: readonly AutomationField[], list: 'inputs' | 'outputs', names: readonly [string, string]): LocalProblem[] {
  const problems: LocalProblem[] = [];
  if (fields.length > MAX_INPUTS) {
    problems.push({ code: 'AU001', path: list, text: `Uma automação tem no máximo ${MAX_INPUTS} ${names[0]}.` });
  }
  const seen = new Set<string>();
  fields.forEach(({ key, type }, i) => {
    const at = `${list}[${i}]`;
    if (key === '') {
      problems.push({ code: 'AU001', path: `${at}.key`, text: 'Informe a chave.' });
    } else if (!isKey(key)) {
      problems.push({ code: 'AU001', path: `${at}.key`, text: 'A chave começa com uma letra, seguida de até 63 letras, dígitos ou _.' });
    } else if (seen.has(key)) {
      problems.push({ code: 'AU001', path: `${at}.key`, text: `A chave ${key} já é usada por ${names[1]}.` });
    } else {
      seen.add(key);
    }
    if (!isTypeName(type)) {
      problems.push({ code: 'AU002', path: `${at}.type`, text: type === '' ? 'Escolha o tipo.' : `O tipo ${type} não existe: escolha um da lista.` });
    }
  });
  return problems;
}
