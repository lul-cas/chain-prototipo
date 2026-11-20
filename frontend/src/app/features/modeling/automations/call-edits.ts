import { AutomationResources } from '../automations-api';
import { isKey } from './automation-checks';
import { EditorDraft, EditorRow, inputsOf, isObject, requestOf, withRequest, withoutRequest } from './automation-edits';

/** A destination a Modeler may know (automation-ui.md §1.1). */
export type DestinationView = AutomationResources['destinations'][number];

/** *Sem corpo*, *JSON com todas as entradas* or *Só estas* (§7.3). */
export type BodyKind = 'none' | 'all' | 'some';

/** *Nenhuma* or *Básica* (§7.3). */
export type AuthKind = 'none' | 'basic';

/** At most 30 headers (AU006). */
export const MAX_HEADERS = 30;

export function setMethod(draft: EditorDraft, method: string): EditorDraft {
  return withRequest(draft, 'method', method);
}

/** Destino (§7.3): choosing one while the path is still `/` sets the path to its prefix. */
export function setDestination(draft: EditorDraft, name: string, destination: DestinationView | null): EditorDraft {
  const chosen = withRequest(draft, 'destination', name);
  const prefix = destination?.pathPrefix;
  return requestOf(chosen.json)['path'] === '/' && prefix && prefix !== '/' ? withRequest(chosen, 'path', prefix) : chosen;
}

/** Host (§7.3): a cleared host is removed, since the server reads an absent host as the destination's own. */
export function setHost(draft: EditorDraft, host: string): EditorDraft {
  return host === '' ? withoutRequest(draft, 'host') : withRequest(draft, 'host', host);
}

export function setPath(draft: EditorDraft, path: string): EditorDraft {
  return withRequest(draft, 'path', path);
}

/** A new query row, with an empty name and value. */
export function addQueryRow(draft: EditorDraft, id: string): EditorDraft {
  return { ...draft, query: [...draft.query, { id, name: '', value: '' }] };
}

export function removeQueryRow(draft: EditorDraft, id: string): EditorDraft {
  return removeRow(draft, 'query', id);
}

export function setQueryName(draft: EditorDraft, id: string, name: string): EditorDraft {
  return changeRow(draft, 'query', id, { name });
}

export function setQueryValue(draft: EditorDraft, id: string, value: string): EditorDraft {
  return changeRow(draft, 'query', id, { value });
}

/** A new header row, with an empty name and value; null at the limit of 30 (AU006). */
export function addHeaderRow(draft: EditorDraft, id: string): EditorDraft | null {
  return draft.headers.length >= MAX_HEADERS ? null : { ...draft, headers: [...draft.headers, { id, name: '', value: '' }] };
}

export function removeHeaderRow(draft: EditorDraft, id: string): EditorDraft {
  return removeRow(draft, 'headers', id);
}

export function setHeaderName(draft: EditorDraft, id: string, name: string): EditorDraft {
  return changeRow(draft, 'headers', id, { name });
}

export function setHeaderValue(draft: EditorDraft, id: string, value: string): EditorDraft {
  return changeRow(draft, 'headers', id, { value });
}

/** Autenticação (§7.3): *Nenhuma* writes `null`, unless the draft has none; *Básica* starts with an empty username and password. */
export function setAuth(draft: EditorDraft, kind: AuthKind): EditorDraft {
  const request = requestOf(draft.json);
  const auth = request['auth'];
  if (kind === 'none') {
    return 'auth' in request && auth !== null ? withRequest(draft, 'auth', null) : draft;
  }
  return isObject(auth) && auth['type'] === 'basic' ? draft : withRequest(draft, 'auth', { type: 'basic', username: '', password: '' });
}

/** Usuário or Senha of basic authentication; the same draft without one. */
export function setAuthField(draft: EditorDraft, field: 'username' | 'password', value: string): EditorDraft {
  const auth = requestOf(draft.json)['auth'];
  return !isObject(auth) || auth[field] === value ? draft : withRequest(draft, 'auth', { ...auth, [field]: value });
}

/**
 * Corpo (§7.3). *Só estas* starts from what the body sent: its list when it has one, else every input, so nothing changes
 * until an input is unchecked. A body the draft lacked stays absent when *Sem corpo* is chosen.
 */
export function setBody(draft: EditorDraft, kind: BodyKind): EditorDraft {
  const request = requestOf(draft.json);
  const body = request['body'];
  const keys = isObject(body) && body['type'] === 'json' ? body['keys'] : undefined;
  switch (kind) {
    case 'none':
      return 'body' in request ? withRequest(draft, 'body', null) : draft;
    case 'all':
      return isObject(body) && body['type'] === 'json' && keys === undefined ? draft : withRequest(draft, 'body', { type: 'json' });
    case 'some':
      return Array.isArray(keys) ? draft : withRequest(draft, 'body', { type: 'json', keys: everyInput(draft) });
  }
}

/** Checks or unchecks an input in *Só estas*: a checked one goes at the end of the list (§7.3). */
export function setBodyKey(draft: EditorDraft, key: string, included: boolean): EditorDraft {
  const body = requestOf(draft.json)['body'];
  const keys = isObject(body) ? body['keys'] : undefined;
  if (!isObject(body) || !Array.isArray(keys) || keys.includes(key) === included) {
    return draft;
  }
  return withRequest(draft, 'body', { ...body, keys: included ? [...keys, key] : keys.filter((name: unknown) => name !== key) });
}

/** The input keys a body of every input sends: the well-formed ones, each once, in input order. */
function everyInput(draft: EditorDraft): string[] {
  const keys = inputsOf(draft.json).map((input) => input['key']);
  return keys.filter((key, i): key is string => typeof key === 'string' && isKey(key) && keys.indexOf(key) === i);
}

function removeRow(draft: EditorDraft, list: 'query' | 'headers', id: string): EditorDraft {
  return draft[list].some((row) => row.id === id) ? { ...draft, [list]: draft[list].filter((row) => row.id !== id) } : draft;
}

function changeRow(draft: EditorDraft, list: 'query' | 'headers', id: string, change: Partial<EditorRow>): EditorDraft {
  const row = draft[list].find((candidate) => candidate.id === id);
  if (row === undefined || Object.entries(change).every(([member, value]) => row[member as keyof EditorRow] === value)) {
    return draft;
  }
  return { ...draft, [list]: draft[list].map((candidate) => (candidate.id === id ? { ...candidate, ...change } : candidate)) };
}
