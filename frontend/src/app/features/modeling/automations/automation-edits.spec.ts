import { MAX_INPUTS } from './automation-checks';
import { EditorDraft, addInput, documentOf, fromDraft, inputsOf, moveInput, removeInput, setInputKey, setInputRequired, setInputType } from './automation-edits';

/** The example of automation.md §5.2, with a second reference to cpf in the path. */
function example(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'http',
    inputs: [
      { key: 'cpf', type: 'text', required: true },
      { key: 'valor', type: 'number', required: false },
    ],
    request: {
      method: 'POST',
      destination: 'erp',
      path: '/v1/clientes/{cpf}/consultas/{cpf}',
      query: { origem: 'chain', valor: '{valor}', doc: '{cpf}', texto: 'x{cpf}' },
      headers: { 'X-Api-Key': '{{secret:erp_api_key}}' },
      auth: null,
      body: { type: 'json', keys: ['cpf', 'valor'] },
    },
    response: { type: 'json' },
    outputs: [{ key: 'httpStatus', type: 'number', required: true, source: 'status' }],
  };
}

function load(json: unknown = example()): EditorDraft {
  let n = 0;
  return fromDraft(json, () => `i${++n}`);
}

/** The request as it would be saved, with the query written from its rows. */
function request(draft: EditorDraft): Record<string, unknown> {
  return documentOf(draft)['request'] as Record<string, unknown>;
}

describe('automation edits (automation-ui.md §7.2)', () => {
  it('keeps the draft as it came, with an id for each input in memory only', () => {
    const json = example();
    const draft = load(json);

    expect(draft.json).toBe(json);
    expect(documentOf(draft)).toBe(json); // the rows say what the JSON holds
    expect(draft.inputIds).toEqual(['i1', 'i2']);
    expect(draft.outputIds).toEqual(['i3']);
    expect(draft.query.map((row) => [row.id, row.name, row.value])).toEqual([
      ['i4', 'origem', 'chain'],
      ['i5', 'valor', '{valor}'],
      ['i6', 'doc', '{cpf}'],
      ['i7', 'texto', 'x{cpf}'],
    ]);
    expect(draft.headers.map((row) => row.name)).toEqual(['X-Api-Key']);
    expect(inputsOf(draft.json).map((input) => input['key'])).toEqual(['cpf', 'valor']);
    expect(load({ schemaVersion: 1, kind: 'http' }).inputIds).toEqual([]);
  });

  describe('adding', () => {
    it('adds an empty key of type text, optional, at the end', () => {
      const draft = load();
      const added = addInput(draft, 'novo')!;

      expect(inputsOf(added.json).at(-1)).toEqual({ key: '', type: 'text', required: false });
      expect(added.inputIds).toEqual(['i1', 'i2', 'novo']);
      expect(added.json['request']).toBe(draft.json['request']);
    });

    it('puts a new inputs list where §5.2 has it, after kind', () => {
      const added = addInput(load({ schemaVersion: 1, kind: 'http', request: { method: 'GET', destination: '', path: '/' }, response: { type: 'none' } }), 'a')!;

      expect(Object.keys(added.json)).toEqual(['schemaVersion', 'kind', 'inputs', 'request', 'response']);
      expect(added.json['inputs']).toEqual([{ key: '', type: 'text', required: false }]);
    });

    it('refuses a 51st input', () => {
      const full = { ...example(), inputs: Array.from({ length: MAX_INPUTS }, (_, i) => ({ key: `k${i}`, type: 'text', required: false })) };

      expect(addInput(load(full), 'x')).toBeNull();
    });
  });

  it('removes an input and its id, and leaves its references for the checks to flag', () => {
    const removed = removeInput(load(), 0);

    expect(inputsOf(removed.json)).toEqual([{ key: 'valor', type: 'number', required: false }]);
    expect(removed.inputIds).toEqual(['i2']);
    expect(request(removed)['path']).toBe('/v1/clientes/{cpf}/consultas/{cpf}');
  });

  it('moves an input with its id, and not past either end', () => {
    const moved = moveInput(load(), 1, -1)!;

    expect(inputsOf(moved.json).map((input) => input['key'])).toEqual(['valor', 'cpf']);
    expect(moved.inputIds).toEqual(['i2', 'i1']);
    expect(moveInput(load(), 0, -1)).toBeNull();
    expect(moveInput(load(), 1, 1)).toBeNull();
  });

  it('changes only the member it edits, and keeps members it does not know in place', () => {
    const json: Record<string, unknown> = { ...example(), inputs: [{ key: 'cpf', type: 'text' }] };
    const typed = setInputType(load(json), 0, 'list<text>');
    const required = setInputRequired(load(json), 0, true);

    expect(inputsOf(typed.json)).toEqual([{ key: 'cpf', type: 'list<text>' }]);
    expect(inputsOf(required.json)).toEqual([{ key: 'cpf', type: 'text', required: true }]);
    expect(typed.json['request']).toBe(json['request']);
    expect(typed.json['outputs']).toBe(json['outputs']);
  });

  it('returns the same draft for a change that changes nothing', () => {
    const draft = load();

    expect(setInputType(draft, 0, 'text')).toBe(draft);
    expect(setInputRequired(draft, 0, true)).toBe(draft);
    expect(setInputKey(draft, 0, 'cpf').draft).toBe(draft);
  });

  describe('renaming (§7.2)', () => {
    it('renames the input in the path, a query value that is exactly its template, and the body list', () => {
      const { draft, places } = setInputKey(load(), 0, 'documento');

      expect(inputsOf(draft.json)[0]).toEqual({ key: 'documento', type: 'text', required: true });
      expect(request(draft)['path']).toBe('/v1/clientes/{documento}/consultas/{documento}');
      expect(request(draft)['query']).toEqual({ origem: 'chain', valor: '{valor}', doc: '{documento}', texto: 'x{cpf}' });
      expect(request(draft)['body']).toEqual({ type: 'json', keys: ['documento', 'valor'] });
      expect(request(draft)['headers']).toEqual({ 'X-Api-Key': '{{secret:erp_api_key}}' });
      expect(places).toEqual(['no caminho', 'na consulta', 'no corpo']);
    });

    it('reads the path as the server does: from a brace to the next one', () => {
      const json = { ...example(), request: { ...(example()['request'] as object), path: '/a/{cpfx}/{cpf}/{{cpf}/b' } };

      expect(request(setInputKey(load(json), 0, 'doc').draft)['path']).toBe('/a/{cpfx}/{doc}/{{cpf}/b');
    });

    it('names only the places it changed', () => {
      const json = { ...example(), request: { method: 'GET', destination: 'erp', path: '/v1', body: { type: 'json' } } };
      const draft = load(json);
      const renamed = setInputKey(draft, 1, 'quantia');

      expect(renamed.places).toEqual([]);
      expect(request(renamed.draft)).toBe(request(draft));
      expect(request(renamed.draft)['body']).toEqual({ type: 'json' }); // a body of every input follows by itself
    });

    it('leaves the references when either key is malformed or used by another input', () => {
      const twice = { ...example(), inputs: [...(example()['inputs'] as object[]), { key: 'cpf', type: 'text', required: false }] };
      const cases: [unknown, number, string][] = [
        [example(), 0, ''], // cleared, to be typed again
        [example(), 0, '9cpf'],
        [example(), 0, 'valor'], // the other input's key
        [twice, 2, 'documento'], // cpf is used by another input too
        [{ ...example(), inputs: [{ key: 'c pf', type: 'text', required: true }] }, 0, 'cpf'],
      ];

      for (const [json, index, key] of cases) {
        const renamed = setInputKey(load(json), index, key);

        expect(inputsOf(renamed.draft.json)[index]['key']).toBe(key);
        expect(renamed.places).toEqual([]);
        expect(request(renamed.draft)).toBe((json as Record<string, unknown>)['request']);
      }
    });
  });
});
