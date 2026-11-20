import { inputProblems, isTypeName } from './automation-checks';
import { readDocument } from './automation-document';

function withInputs(...inputs: { key: string; type: string }[]) {
  return readDocument({ schemaVersion: 1, kind: 'http', inputs, request: { method: 'GET', destination: 'erp', path: '/' }, response: { type: 'none' } });
}

const many = (count: number) => Array.from({ length: count }, (_, i) => ({ key: `k${i}`, type: 'text' }));

/** The cases of AutomationDocumentTests.cs (AU001 and AU002), so the browser gives the server's code (automation-ui.md §7.9). */
describe('the local checks of the inputs', () => {
  it('flags a key that is not a letter followed by up to 63 letters, digits or underscores (AU001)', () => {
    for (const key of ['1cpf', 'cpf-x', 'cpf\n', 'ação', 'a'.repeat(65)]) {
      expect(inputProblems(withInputs({ key, type: 'text' }))).toEqual([
        { code: 'AU001', path: 'inputs[0].key', text: 'A chave começa com uma letra, seguida de até 63 letras, dígitos ou _.' },
      ]);
    }
    expect(inputProblems(withInputs({ key: '', type: 'text' }))).toEqual([{ code: 'AU001', path: 'inputs[0].key', text: 'Informe a chave.' }]);
  });

  it('flags a key used again, at the later input only (AU001)', () => {
    expect(inputProblems(withInputs({ key: 'cpf', type: 'text' }, { key: 'valor', type: 'number' }, { key: 'cpf', type: 'text' }))).toEqual([
      { code: 'AU001', path: 'inputs[2].key', text: 'A chave cpf já é usada por outra entrada.' },
    ]);
  });

  it('flags more than 50 inputs, at the list (AU001)', () => {
    expect(inputProblems(withInputs(...many(51)))).toEqual([{ code: 'AU001', path: 'inputs', text: 'Uma automação tem no máximo 50 entradas.' }]);
    expect(inputProblems(withInputs(...many(50)))).toEqual([]);
  });

  it('passes the near misses of the server', () => {
    expect(inputProblems(withInputs({ key: 'a' + 'b'.repeat(63), type: 'text' }, { key: 'Cpf_2', type: 'list<list<number>>' }))).toEqual([]);
  });

  it('flags a type that is no type name (AU002)', () => {
    for (const type of ['string', 'file', 'Text', 'list<>', 'list<text', 'list< text >', 'list<file>']) {
      expect(inputProblems(withInputs({ key: 'cpf', type }))).toEqual([{ code: 'AU002', path: 'inputs[0].type', text: `O tipo ${type} não existe: escolha um da lista.` }]);
    }
    expect(inputProblems(withInputs({ key: 'cpf', type: '' }))).toEqual([{ code: 'AU002', path: 'inputs[0].type', text: 'Escolha o tipo.' }]);
  });

  it('reads type names as the server does', () => {
    for (const type of ['text', 'number', 'boolean', 'date', 'datetime', 'time', 'object', 'unknown', 'list<list<number>>', 'list<unknown>']) {
      expect(isTypeName(type)).toBe(true);
    }
    const nested = (depth: number, element: string) => `${'list<'.repeat(depth)}${element}${'>'.repeat(depth)}`;
    expect(nested(16, 'text')).toHaveLength(100);
    expect(isTypeName(nested(16, 'text'))).toBe(true); // a list's name has at most 100 characters
    expect(isTypeName(nested(16, 'number'))).toBe(false); // 102
    expect(isTypeName('constructor')).toBe(false);
  });

  it('reports a key and a type of one input in the server order', () => {
    expect(inputProblems(withInputs({ key: '', type: 'x' })).map((problem) => problem.path)).toEqual(['inputs[0].key', 'inputs[0].type']);
  });
});
