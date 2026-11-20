import { ContractField } from '../automations-api';
import { CatalogEntry, Operand, Problem, fromOperand, toOperand, valueProblem, valueText } from './conditions';

/**
 * What a step's mappings are checked against (workflow-editor.md §10.9, §10.10): an automation version's contract, or a
 * sub-workflow version's. A child without a start form takes any keys (TC-5): its `inputs` are null.
 */
export interface StepContract {
  readonly version: number;
  readonly inputs: readonly ContractField[] | null;
  readonly outputs: readonly ContractField[];
}

/** How a step warns about its inputs: an automation's refuses at publish (WF110), a sub-workflow's start form at run time. */
export interface MappingTexts {
  readonly required: string;
  readonly undeclared: string;
  /** For a step whose inputs can't carry files, a sub-workflow's (WF206): the warning for one that does. An automation's may. */
  readonly files?: string;
}

export const AUTOMATION_TEXTS: MappingTexts = {
  required: 'Entrada obrigatória: publicar exige um valor.',
  undeclared: 'A automação não declara esta entrada.',
};

export const SUBPROCESS_TEXTS: MappingTexts = {
  required: 'Campo obrigatório: sem ele, a subsolicitação é recusada.',
  undeclared: 'O formulário inicial do processo não tem este campo.',
  files: 'Arquivos não passam para um subprocesso: publicar recusa esta entrada.',
};

/**
 * A step's mappings (workflow-editor.md §10.9, §10.10; automation.md §5.6, workflow-engine.md §14.1): a value for each declared
 * input, or free keys and values for a child without a start form; the key of the request's data each declared output is
 * kept as; and whatever else the step stores, kept as it is.
 */
export interface StepMappings {
  readonly inputs: readonly InputMapping[];
  /** Mapped inputs the version doesn't declare: kept, and reported by publishing (WF110). */
  readonly otherInputs: readonly KeptMapping[];
  readonly outputs: readonly OutputMapping[];
  /** Output mappings of another shape, or of outputs the version doesn't declare: kept. */
  readonly otherOutputs: readonly KeptMapping[];
  /** A child without a start form takes any keys (TC-5): rows of a key and a value. */
  readonly freeInputs: readonly FreeInput[];
}

export interface FreeInput {
  readonly key: string;
  readonly value: Operand;
}

/** A declared input and its value: null when it isn't sent. */
export interface InputMapping {
  readonly field: ContractField;
  readonly value: Operand | null;
}

/** A declared output and the key it is kept as: empty when it isn't kept. */
export interface OutputMapping {
  readonly field: ContractField;
  readonly target: string;
}

export interface KeptMapping {
  readonly key: string;
  readonly json: unknown;
}

/** WF019 and WF109: a mapping's key. */
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const KEY_TEXT = 'Use uma letra e depois letras sem acento, dígitos ou _, até 64 caracteres.';

/** Reads a step's stored mappings against the version's contract. */
export function readMappings(reference: unknown, contract: StepContract): StepMappings {
  const inputs = objectAt(reference, 'inputs');
  const outputs = objectAt(reference, 'outputs');
  const declared = new Set((contract.inputs ?? []).map((field) => field.key));
  const sources = new Map<string, string>();
  const otherOutputs: KeptMapping[] = [];
  for (const [key, json] of Object.entries(outputs)) {
    const source = outputSource(json);
    if (source !== null && contract.outputs.some((field) => field.key === source) && !sources.has(source)) {
      sources.set(source, key);
    } else {
      otherOutputs.push({ key, json });
    }
  }
  const free = contract.inputs === null;
  return {
    inputs: (contract.inputs ?? []).map((field) => ({ field, value: Object.hasOwn(inputs, field.key) ? toOperand(inputs[field.key]) : null })),
    otherInputs: free
      ? []
      : Object.entries(inputs)
          .filter(([key]) => !declared.has(key))
          .map(([key, json]) => ({ key, json })),
    outputs: contract.outputs.map((field) => ({ field, target: sources.get(field.key) ?? '' })),
    otherOutputs,
    freeInputs: free ? Object.entries(inputs).map(([key, json]) => ({ key, value: toOperand(json) })) : [],
  };
}

/** Writes the mappings back, or says they are incomplete: a value that can't be written, or a key that isn't valid or unique. */
export function writeMappings(mappings: StepMappings): { readonly inputs: Record<string, unknown>; readonly outputs: Record<string, unknown> } | null {
  if ([...mappingProblems(mappings, []).values()].some((problem) => 'error' in problem)) {
    return null;
  }
  const inputs: Record<string, unknown> = {};
  for (const { field, value } of mappings.inputs) {
    if (value !== null) {
      inputs[field.key] = fromOperand(value);
    }
  }
  for (const { key, json } of mappings.otherInputs) {
    inputs[key] = json;
  }
  for (const { key, value } of mappings.freeInputs) {
    inputs[key] = fromOperand(value);
  }
  const outputs: Record<string, unknown> = {};
  for (const { key, json } of mappings.otherOutputs) {
    outputs[key] = json;
  }
  for (const { field, target } of mappings.outputs) {
    if (target !== '') {
      outputs[target] = { kind: 'path', path: [field.key] };
    }
  }
  return { inputs, outputs };
}

/**
 * Each row's problem, keyed `input:<key>`, `free:<index>` or `output:<key>`: errors keep the mappings from being written;
 * warnings are for publishing, or the step at run time, to report, in each step's own words.
 */
export function mappingProblems(mappings: StepMappings, catalog: readonly CatalogEntry[], texts: MappingTexts = AUTOMATION_TEXTS): Map<string, Problem> {
  const problems = new Map<string, Problem>();
  for (const { field, value } of mappings.inputs) {
    const problem = value === null ? (field.required ? { warning: texts.required } : null) : inputProblem(value, field.type, catalog, texts);
    if (problem) {
      problems.set(`input:${field.key}`, problem);
    }
  }
  for (const { key } of mappings.otherInputs) {
    problems.set(`input:${key}`, { warning: texts.undeclared });
  }
  const keys = new Set<string>();
  mappings.freeInputs.forEach(({ key, value }, index) => {
    const problem =
      key === ''
        ? { error: 'Informe a chave.' }
        : !KEY.test(key)
          ? { error: KEY_TEXT }
          : keys.has(key)
            ? { error: 'Outra entrada já usa esta chave.' }
            : inputProblem(value, 'unknown', catalog, texts);
    keys.add(key);
    if (problem) {
      problems.set(`free:${index}`, problem);
    }
  });
  const used = new Set(mappings.otherOutputs.map((mapping) => mapping.key));
  for (const { field, target } of mappings.outputs) {
    if (target === '') {
      continue;
    }
    if (!KEY.test(target)) {
      problems.set(`output:${field.key}`, { error: KEY_TEXT });
    } else if (used.has(target)) {
      problems.set(`output:${field.key}`, { error: 'Outra saída já é guardada com esta chave.' });
    }
    used.add(target);
  }
  return problems;
}

/** Whether a type holds files: `list<file>`, or a list of them. */
export function typeHoldsFiles(type: string): boolean {
  return /\bfile\b/.test(type);
}

/**
 * Whether a datum holds files (WF206): it is a file field, or a group or a list with one at any depth. The catalog lists each
 * field inside a group or a list as an entry of its own (workflow-definition.md §6.5).
 */
export function holdsFiles(entry: CatalogEntry, catalog: readonly CatalogEntry[]): boolean {
  return holdsFilesAt(entry.path, catalog);
}

/** Whether a value carries files, as far as the panel can tell: it names a datum that holds them. Publishing checks the rest. */
export function carriesFiles(value: Operand | null, catalog: readonly CatalogEntry[]): boolean {
  return value?.kind === 'path' && value.path.length > 0 && holdsFilesAt(value.path, catalog);
}

/** A kept mapping as text, as the preview of conditions shows values (§10.7). */
export function keptText(mapping: KeptMapping): string {
  return `${mapping.key} ← ${valueText(mapping.json)}`;
}

/** `{ "kind": "path", "path": [outputKey] }`, the shape the panel writes, gives its output key; anything else, null. */
function outputSource(json: unknown): string | null {
  if (!isObject(json) || Object.keys(json).some((key) => key !== 'kind' && key !== 'path') || json['kind'] !== 'path') {
    return null;
  }
  const path = json['path'];
  return Array.isArray(path) && path.length === 1 && typeof path[0] === 'string' ? path[0] : null;
}

function holdsFilesAt(path: readonly string[], catalog: readonly CatalogEntry[]): boolean {
  return catalog.some((entry) => typeHoldsFiles(entry.type) && path.length <= entry.path.length && path.every((segment, index) => entry.path[index] === segment));
}

/** A value's problem; for a sub-workflow's input, the files it can't carry take the place of the type check (WF206). */
function inputProblem(value: Operand, type: string, catalog: readonly CatalogEntry[], texts: MappingTexts): Problem | null {
  const problem = valueProblem(value, type, catalog);
  if (problem && 'error' in problem) {
    return problem;
  }
  return texts.files !== undefined && (typeHoldsFiles(type) || carriesFiles(value, catalog)) ? { warning: texts.files } : problem;
}

function objectAt(json: unknown, key: string): Record<string, unknown> {
  const value = isObject(json) ? json[key] : undefined;
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
