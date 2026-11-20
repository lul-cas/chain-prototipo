import { MAX_INPUTS, isKey } from './automation-checks';

/** A JSON object of the draft, as the server sent it and the edits changed it. */
export type Json = Readonly<Record<string, unknown>>;

/** A query parameter or a header as the editor holds it (automation-ui.md §7.3): two rows may share a name while editing. */
export interface EditorRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

/**
 * The draft as the automation editor holds it (automation-ui.md §5.4): its JSON, edited one to one, so that what a control
 * does not edit is saved as it was loaded; an id for each input, in memory only, which keeps a row's identity and focus
 * across moves, removals and undo; and the query and the headers as rows, which `documentOf` writes back into the JSON. The
 * edits are pure: each returns a new draft, or the same one when nothing changes.
 */
export interface EditorDraft {
  readonly json: Json;
  readonly inputIds: readonly string[];
  readonly outputIds: readonly string[];
  readonly query: readonly EditorRow[];
  readonly headers: readonly EditorRow[];
}

/** What a rename changed (§7.2): the draft, and where the call's references followed it. */
export interface Renamed {
  readonly draft: EditorDraft;
  readonly places: readonly string[];
}

/** The order of automation.md §5.2, where a member the draft lacks is put when an edit adds it. */
export const DOCUMENT_ORDER = ['schemaVersion', 'kind', 'inputs', 'request', 'response', 'outputs', 'execution'];
export const REQUEST_ORDER = ['method', 'destination', 'host', 'path', 'query', 'headers', 'auth', 'body'];

/** The draft the server sent (it parsed it, AU000), with an id for each input, query parameter and header. */
export function fromDraft(draft: unknown, newId: () => string): EditorDraft {
  const json: Json = isObject(draft) ? draft : {};
  const request = requestOf(json);
  const rows = (member: string): EditorRow[] => Object.entries(objectOf(request[member])).map(([name, value]) => ({ id: newId(), name, value: String(value) }));
  const outputs = Array.isArray(json['outputs']) ? json['outputs'] : [];
  return { json, inputIds: inputsOf(json).map(() => newId()), outputIds: outputs.map(() => newId()), query: rows('query'), headers: rows('headers') };
}

/**
 * The document to save and draw: the JSON with the query and the headers written from their rows. A member the draft
 * lacked stays absent while it has no rows. Two rows with the same name keep the last one's value; `repeatedName` says so,
 * and saving waits for it (§7.3).
 */
export function documentOf(draft: EditorDraft): Json {
  const request = draft.json['request'];
  if (!isObject(request)) {
    return draft.json;
  }
  const written = withRows(withRows(request, 'query', draft.query), 'headers', draft.headers);
  return written === request ? draft.json : { ...draft.json, request: written };
}

/** Why the draft can't be saved yet: two query or header rows with exactly the same name (§7.3); null when it can. */
export function repeatedName(draft: EditorDraft): string | null {
  const repeated = (rows: readonly EditorRow[]) => rows.find((row, i) => rows.findIndex((other) => other.name === row.name) !== i)?.name;
  const query = repeated(draft.query);
  if (query !== undefined) {
    return `Dois parâmetros da consulta se chamam ${query || '(sem nome)'}: renomeie ou remova um.`;
  }
  const header = repeated(draft.headers);
  return header === undefined ? null : `Dois cabeçalhos se chamam ${header || '(sem nome)'}: renomeie ou remova um.`;
}

/** The draft's inputs, `[]` when it has none. */
export function inputsOf(json: Json): readonly Json[] {
  const inputs = json['inputs'];
  return Array.isArray(inputs) ? (inputs as Json[]) : [];
}

/** The draft's request, `{}` when it has none. */
export function requestOf(json: Json): Json {
  return objectOf(json['request']);
}

/** Adds an input at the end: an empty key, of type text, optional (§7.2). Null at the limit of 50. */
export function addInput(draft: EditorDraft, id: string): EditorDraft | null {
  const inputs = inputsOf(draft.json);
  if (inputs.length >= MAX_INPUTS) {
    return null;
  }
  return {
    ...draft,
    json: withMember(draft.json, 'inputs', [...inputs, { key: '', type: 'text', required: false }], DOCUMENT_ORDER),
    inputIds: [...draft.inputIds, id],
  };
}

/** Removes an input. Its references in the call stay, for the checks to flag (§7.2). */
export function removeInput(draft: EditorDraft, index: number): EditorDraft {
  return {
    ...draft,
    json: withMember(draft.json, 'inputs', inputsOf(draft.json).filter((_, i) => i !== index), DOCUMENT_ORDER),
    inputIds: draft.inputIds.filter((_, i) => i !== index),
  };
}

/** Moves an input one place up (-1) or down (1); null past either end. */
export function moveInput(draft: EditorDraft, index: number, by: -1 | 1): EditorDraft | null {
  const inputs = inputsOf(draft.json);
  const other = index + by;
  if (index < 0 || other < 0 || other >= inputs.length) {
    return null;
  }
  return { ...draft, json: withMember(draft.json, 'inputs', swap(inputs, index, other), DOCUMENT_ORDER), inputIds: swap(draft.inputIds, index, other) };
}

export function setInputType(draft: EditorDraft, index: number, type: string): EditorDraft {
  return changeInput(draft, index, 'type', type);
}

export function setInputRequired(draft: EditorDraft, index: number, required: boolean): EditorDraft {
  return changeInput(draft, index, 'required', required);
}

/**
 * Changes an input's key. The call's references follow it (§7.2) only when both keys are well formed and no other input uses
 * either: otherwise which input a reference means would change, so the references stay and the checks flag them.
 */
export function setInputKey(draft: EditorDraft, index: number, key: string): Renamed {
  const inputs = inputsOf(draft.json);
  const old = inputs[index]?.['key'];
  const changed = changeInput(draft, index, 'key', key);
  const others = inputs.filter((_, i) => i !== index).map((input) => input['key']);
  if (changed === draft || typeof old !== 'string' || !isKey(old) || !isKey(key) || others.includes(old) || others.includes(key)) {
    return { draft: changed, places: [] };
  }
  const places: string[] = [];
  const request = requestOf(changed.json);
  let renamed = request;
  const path = request['path'];
  if (typeof path === 'string' && renameInPath(path, old, key) !== path) {
    renamed = { ...renamed, path: renameInPath(path, old, key) };
    places.push('no caminho');
  }
  let query = changed.query;
  if (query.some((row) => row.value === `{${old}}`)) {
    query = query.map((row) => (row.value === `{${old}}` ? { ...row, value: `{${key}}` } : row));
    places.push('na consulta');
  }
  const body = request['body'];
  const keys = isObject(body) ? body['keys'] : undefined;
  if (isObject(body) && Array.isArray(keys) && keys.includes(old)) {
    renamed = { ...renamed, body: { ...body, keys: keys.map((name: unknown) => (name === old ? key : name)) } };
    places.push('no corpo');
  }
  return { draft: { ...changed, json: renamed === request ? changed.json : { ...changed.json, request: renamed }, query }, places };
}

/** Renames each `{old}` the server reads as a template: from a brace to the next closing one (AutomationRules.CheckPath). */
function renameInPath(path: string, old: string, key: string): string {
  let result = '';
  let at = 0;
  for (let open = path.indexOf('{'); open >= 0; open = path.indexOf('{', at)) {
    const close = path.indexOf('}', open + 1);
    if (close < 0) {
      break;
    }
    result += path.slice(at, open) + (path.slice(open + 1, close) === old ? `{${key}}` : path.slice(open, close + 1));
    at = close + 1;
  }
  return result + path.slice(at);
}

function changeInput(draft: EditorDraft, index: number, member: string, value: unknown): EditorDraft {
  const inputs = inputsOf(draft.json);
  const input = inputs[index];
  if (input === undefined || (member in input && input[member] === value)) {
    return draft;
  }
  const changed = inputs.map((candidate, i) => (i === index ? withMember(candidate, member, value, ['key', 'type', 'required']) : candidate));
  return { ...draft, json: withMember(draft.json, 'inputs', changed, DOCUMENT_ORDER) };
}

/** A request member set, in its place when present, else where §5.2 puts it; the same draft when nothing changes. */
export function withRequest(draft: EditorDraft, member: string, value: unknown): EditorDraft {
  const request = requestOf(draft.json);
  if (member in request && request[member] === value) {
    return draft;
  }
  return { ...draft, json: withMember(draft.json, 'request', withMember(request, member, value, REQUEST_ORDER), DOCUMENT_ORDER) };
}

/** A request member removed; the same draft when it is absent. */
export function withoutRequest(draft: EditorDraft, member: string): EditorDraft {
  const request = requestOf(draft.json);
  if (!(member in request)) {
    return draft;
  }
  const rest = Object.fromEntries(Object.entries(request).filter(([name]) => name !== member));
  return { ...draft, json: withMember(draft.json, 'request', rest, DOCUMENT_ORDER) };
}

/** The object with `member` set: in its place when present, else where `order` puts it among the members present. */
export function withMember(json: Json, member: string, value: unknown, order: readonly string[]): Json {
  if (member in json) {
    return { ...json, [member]: value };
  }
  const rank = order.indexOf(member);
  const entries = Object.entries(json);
  const before = entries.findIndex(([name]) => order.indexOf(name) > rank);
  entries.splice(before < 0 ? entries.length : before, 0, [member, value]);
  return Object.fromEntries(entries);
}

/** The rows written into the request as an object, or the request as it was when they say what it already holds. */
function withRows(request: Json, member: string, rows: readonly EditorRow[]): Json {
  if (rows.length === 0 && !(member in request)) {
    return request;
  }
  const current = Object.entries(objectOf(request[member]));
  const same = current.length === rows.length && rows.every((row, i) => current[i][0] === row.name && current[i][1] === row.value);
  return same ? request : withMember(request, member, Object.fromEntries(rows.map((row) => [row.name, row.value])), REQUEST_ORDER);
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectOf(value: unknown): Json {
  return isObject(value) ? value : {};
}

function swap<T>(list: readonly T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}
