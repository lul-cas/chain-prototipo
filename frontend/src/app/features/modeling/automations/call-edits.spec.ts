import { EditorDraft, documentOf, fromDraft, repeatedName, requestOf } from './automation-edits';
import {
  MAX_HEADERS,
  addHeaderRow,
  addQueryRow,
  removeHeaderRow,
  removeQueryRow,
  setAuth,
  setAuthField,
  setBody,
  setBodyKey,
  setDestination,
  setHeaderName,
  setHeaderValue,
  setHost,
  setMethod,
  setPath,
  setQueryName,
  setQueryValue,
} from './call-edits';

function load(request: Record<string, unknown>, inputs: object[] = [{ key: 'cpf', type: 'text', required: true }]): EditorDraft {
  let n = 0;
  return fromDraft({ schemaVersion: 1, kind: 'http', inputs, request, response: { type: 'none' } }, () => `r${++n}`);
}

const saved = (draft: EditorDraft) => requestOf(documentOf(draft));
const ERP = { name: 'erp', description: null, scheme: 'https', host: 'api.erp.example', port: null, pathPrefix: '/v1' };

describe('call edits (automation-ui.md §7.3)', () => {
  it('sets the method, the path and the destination, member by member', () => {
    const draft = load({ method: 'GET', destination: '', path: '/a' });

    expect(saved(setMethod(draft, 'POST'))).toEqual({ method: 'POST', destination: '', path: '/a' });
    expect(saved(setPath(draft, '/b/{cpf}'))).toEqual({ method: 'GET', destination: '', path: '/b/{cpf}' });
    expect(saved(setDestination(draft, 'erp', ERP))).toEqual({ method: 'GET', destination: 'erp', path: '/a' });
    expect(setMethod(draft, 'GET')).toBe(draft);
  });

  it("sets the path to the destination's prefix while it is still /", () => {
    const draft = load({ method: 'GET', destination: '', path: '/' });

    expect(saved(setDestination(draft, 'erp', ERP))['path']).toBe('/v1');
    expect(saved(setDestination(draft, 'outro', { ...ERP, pathPrefix: null }))['path']).toBe('/');
    expect(saved(setDestination(draft, 'sumiu', null))['path']).toBe('/');
  });

  it('sets the host, and removes it when cleared', () => {
    const draft = load({ method: 'GET', destination: 'erp', path: '/' });

    const set = setHost(draft, 'api.erp.example');
    expect(Object.keys(saved(set))).toEqual(['method', 'destination', 'host', 'path']);
    expect(saved(setHost(set, ''))).toEqual({ method: 'GET', destination: 'erp', path: '/' });
    expect(setHost(draft, '')).toBe(draft);
  });

  describe('query rows', () => {
    it('adds, renames, sets and removes rows, and writes them in order', () => {
      let draft = load({ method: 'GET', destination: 'erp', path: '/' });
      draft = addQueryRow(draft, 'q1');
      draft = setQueryName(draft, 'q1', 'origem');
      draft = setQueryValue(draft, 'q1', 'chain');
      draft = addQueryRow(draft, 'q2');
      draft = setQueryName(draft, 'q2', 'doc');
      draft = setQueryValue(draft, 'q2', '{cpf}');

      expect(saved(draft)).toEqual({ method: 'GET', destination: 'erp', path: '/', query: { origem: 'chain', doc: '{cpf}' } });
      expect(saved(removeQueryRow(draft, 'q1'))['query']).toEqual({ doc: '{cpf}' });
    });

    it('keeps a query the draft had, empty, and leaves out one it lacked', () => {
      const had = load({ method: 'GET', destination: 'erp', path: '/', query: { a: '1' } });
      const lacked = load({ method: 'GET', destination: 'erp', path: '/' });

      expect(saved(removeQueryRow(had, had.query[0].id))['query']).toEqual({});
      expect('query' in saved(removeQueryRow(addQueryRow(lacked, 'x'), 'x'))).toBe(false);
    });

    it('lets two rows share a name while editing, and says that saving waits (§7.3)', () => {
      let draft = load({ method: 'GET', destination: 'erp', path: '/', query: { origem: 'chain' } });
      draft = setQueryName(addQueryRow(draft, 'q'), 'q', 'origem');

      expect(draft.query.map((row) => row.name)).toEqual(['origem', 'origem']);
      expect(repeatedName(draft)).toBe('Dois parâmetros da consulta se chamam origem: renomeie ou remova um.');
      expect(repeatedName(setQueryName(draft, 'q', 'Origem'))).toBeNull(); // query names are case-sensitive
    });
  });

  describe('the body', () => {
    const inputs = [
      { key: 'cpf', type: 'text', required: true },
      { key: 'valor', type: 'number', required: false },
    ];

    it('is none, every input, or only some, in input order with new ones at the end', () => {
      const draft = load({ method: 'POST', destination: 'erp', path: '/', body: null }, inputs);

      const all = setBody(draft, 'all');
      expect(saved(all)['body']).toEqual({ type: 'json' });
      const some = setBody(all, 'some');
      expect(saved(some)['body']).toEqual({ type: 'json', keys: ['cpf', 'valor'] }); // what every input sent, until one is unchecked
      const unchecked = setBodyKey(some, 'cpf', false);
      expect(saved(unchecked)['body']).toEqual({ type: 'json', keys: ['valor'] });
      expect(saved(setBodyKey(unchecked, 'cpf', true))['body']).toEqual({ type: 'json', keys: ['valor', 'cpf'] });
      expect(saved(setBody(some, 'none'))['body']).toBeNull();
    });

    it('leaves a missing body missing, and changes nothing when the kind stays', () => {
      const draft = load({ method: 'POST', destination: 'erp', path: '/' }, inputs);
      const all = load({ method: 'POST', destination: 'erp', path: '/', body: { type: 'json' } }, inputs);

      expect(setBody(draft, 'none')).toBe(draft);
      expect(setBody(all, 'all')).toBe(all);
      expect(setBodyKey(all, 'cpf', true)).toBe(all); // only a list of some inputs takes a key
    });

    it('keeps the list of some when switched to again, and skips keys that are not well formed or repeated', () => {
      const odd = [...inputs, { key: '', type: 'text', required: false }, { key: 'cpf', type: 'text', required: false }];
      const draft = load({ method: 'POST', destination: 'erp', path: '/', body: { type: 'json', keys: ['valor'] } }, odd);

      expect(setBody(draft, 'some')).toBe(draft);
      expect(saved(setBody(setBody(draft, 'all'), 'some'))['body']).toEqual({ type: 'json', keys: ['cpf', 'valor'] });
    });
  });

  describe('header rows (AS4b-2)', () => {
    it('adds, renames, sets and removes rows, up to 30', () => {
      let draft = load({ method: 'GET', destination: 'erp', path: '/' });
      draft = addHeaderRow(draft, 'h1')!;
      draft = setHeaderName(draft, 'h1', 'X-Api-Key');
      draft = setHeaderValue(draft, 'h1', '{{secret:erp_api_key}}');

      expect(saved(draft)['headers']).toEqual({ 'X-Api-Key': '{{secret:erp_api_key}}' });
      expect(saved(removeHeaderRow(draft, 'h1'))).toEqual({ method: 'GET', destination: 'erp', path: '/' });

      const full = load({ method: 'GET', destination: 'erp', path: '/', headers: Object.fromEntries(Array.from({ length: MAX_HEADERS }, (_, i) => [`X-${i}`, 'v'])) });
      expect(addHeaderRow(full, 'more')).toBeNull();
    });

    it('lets two headers share a name while editing, and says that saving waits', () => {
      let draft = load({ method: 'GET', destination: 'erp', path: '/', headers: { Accept: 'application/json' } });
      draft = setHeaderName(addHeaderRow(draft, 'h')!, 'h', 'Accept');

      expect(repeatedName(draft)).toBe('Dois cabeçalhos se chamam Accept: renomeie ou remova um.');
      expect(repeatedName(setHeaderName(draft, 'h', 'accept'))).toBeNull(); // the JSON holds both; AU006 flags them
    });
  });

  describe('basic authentication (AS4b-2)', () => {
    it('is none or basic, with a username and a password', () => {
      const draft = load({ method: 'GET', destination: 'erp', path: '/' });

      const basic = setAuth(draft, 'basic');
      expect(saved(basic)['auth']).toEqual({ type: 'basic', username: '', password: '' });
      const filled = setAuthField(setAuthField(basic, 'username', 'chain'), 'password', '{{secret:erp_password}}');
      expect(saved(filled)['auth']).toEqual({ type: 'basic', username: 'chain', password: '{{secret:erp_password}}' });
      expect(saved(setAuth(filled, 'none'))['auth']).toBeNull();
    });

    it('leaves a missing auth missing, and keeps a basic one when basic is chosen again', () => {
      const draft = load({ method: 'GET', destination: 'erp', path: '/' });
      const basic = load({ method: 'GET', destination: 'erp', path: '/', auth: { type: 'basic', username: 'u', password: 'p' } });

      expect(setAuth(draft, 'none')).toBe(draft);
      expect(setAuth(basic, 'basic')).toBe(basic);
      expect(setAuthField(draft, 'username', 'x')).toBe(draft); // no fields without basic authentication
      expect(setAuthField(basic, 'username', 'u')).toBe(basic);
    });
  });
});
