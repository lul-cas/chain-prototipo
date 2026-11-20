import { EditorDraft, documentOf, fromDraft } from './automation-edits';
import { addOutput, moveOutput, outputsOf, removeOutput, setOutputKey, setOutputPath, setOutputRequired, setOutputSource, setOutputType, setResponseType } from './output-edits';

function load(outputs: object[] | undefined, response: object = { type: 'json' }): EditorDraft {
  let n = 0;
  return fromDraft(
    { schemaVersion: 1, kind: 'http', request: { method: 'GET', destination: 'erp', path: '/' }, response, ...(outputs ? { outputs } : {}) },
    () => `o${++n}`,
  );
}

const SITUACAO = { key: 'situacao', type: 'text', required: true, source: 'body', path: ['resultado', 'situacao'] };
const STATUS = { key: 'httpStatus', type: 'number', required: true, source: 'status' };

describe('output edits (automation-ui.md §7.4)', () => {
  it('gives each output an id in memory only', () => {
    expect(load([SITUACAO, STATUS]).outputIds).toEqual(['o1', 'o2']);
  });

  it('adds a body output with an empty key and path, of type text, optional; up to 50', () => {
    const added = addOutput(load(undefined), 'novo')!;

    expect(Object.keys(documentOf(added))).toEqual(['schemaVersion', 'kind', 'request', 'response', 'outputs']);
    expect(outputsOf(added.json)).toEqual([{ key: '', type: 'text', required: false, source: 'body', path: [] }]);
    expect(added.outputIds).toEqual(['novo']);
    const full = load(Array.from({ length: 50 }, (_, i) => ({ ...STATUS, key: `k${i}` })));
    expect(addOutput(full, 'x')).toBeNull();
  });

  it('moves and removes outputs with their ids', () => {
    const draft = load([SITUACAO, STATUS]);

    const moved = moveOutput(draft, 1, -1)!;
    expect(outputsOf(moved.json).map((output) => output['key'])).toEqual(['httpStatus', 'situacao']);
    expect(moved.outputIds).toEqual(['o2', 'o1']);
    expect(moveOutput(draft, 0, -1)).toBeNull();
    expect(removeOutput(draft, 0).outputIds).toEqual(['o2']);
  });

  it('changes only the member it edits', () => {
    const draft = load([SITUACAO]);

    expect(outputsOf(setOutputKey(draft, 0, 'estado').json)[0]).toEqual({ ...SITUACAO, key: 'estado' });
    expect(outputsOf(setOutputType(draft, 0, 'list<text>').json)[0]).toEqual({ ...SITUACAO, type: 'list<text>' });
    expect(outputsOf(setOutputRequired(draft, 0, false).json)[0]).toEqual({ ...SITUACAO, required: false });
    expect(outputsOf(setOutputPath(draft, 0, ['itens', 0]).json)[0]).toEqual({ ...SITUACAO, path: ['itens', 0] });
    expect(setOutputKey(draft, 0, 'situacao')).toBe(draft);
    expect(setOutputPath(draft, 0, ['resultado', 'situacao'])).toBe(draft); // the same segments
  });

  it('makes a status output a number without a path, and a body output gets an empty path', () => {
    const status = setOutputSource(load([SITUACAO]), 0, 'status');
    expect(outputsOf(status.json)[0]).toEqual({ key: 'situacao', type: 'number', required: true, source: 'status' });

    expect(outputsOf(setOutputSource(status, 0, 'body').json)[0]).toEqual({ key: 'situacao', type: 'number', required: true, source: 'body', path: [] });
    expect(setOutputSource(status, 0, 'status')).toBe(status);
  });

  it('sets the response type', () => {
    const draft = load([SITUACAO]);

    expect(documentOf(setResponseType(draft, 'none'))['response']).toEqual({ type: 'none' });
    expect(setResponseType(draft, 'json')).toBe(draft);
  });
});
