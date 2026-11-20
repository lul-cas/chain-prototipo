import { readDocument } from './automation-document';
import { outputProblems } from './output-checks';

/** The outputs and response of `Valid()` in AutomationDocumentTests.cs. */
function valid(): { outputs: Record<string, unknown>[]; response: { type: string } } & Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'http',
    inputs: [{ key: 'cpf', type: 'text', required: true }],
    request: { method: 'GET', destination: 'erp', path: '/v1' },
    response: { type: 'json' },
    outputs: [
      { key: 'situacao', type: 'text', required: true, source: 'body', path: ['resultado', 'situacao'] },
      { key: 'primeiro', type: 'unknown', source: 'body', path: ['itens', 0] },
      { key: 'httpStatus', type: 'number', required: true, source: 'status' },
    ],
  };
}

function changed(change: (document: ReturnType<typeof valid>) => void): object {
  const document = valid();
  change(document);
  return document;
}

const problems = (json: object) => outputProblems(readDocument(json));
const codes = (json: object) => problems(json).map((problem) => problem.code);

describe('the local checks of the response and the outputs (automation-ui.md §7.9; AutomationDocumentTests.cs)', () => {
  it('passes the valid document', () => {
    expect(problems(valid())).toEqual([]);
  });

  describe('AU001 and AU002 of the outputs', () => {
    it('flag keys and types as for inputs, in their own list', () => {
      for (const key of ['1cpf', 'cpf-x', 'cpf\n', 'ação']) {
        expect(problems(changed((d) => (d.outputs[2]['key'] = key)))).toEqual([
          { code: 'AU001', path: 'outputs[2].key', text: 'A chave começa com uma letra, seguida de até 63 letras, dígitos ou _.' },
        ]);
      }
      expect(problems(changed((d) => (d.outputs[1]['key'] = 'situacao')))).toEqual([
        { code: 'AU001', path: 'outputs[1].key', text: 'A chave situacao já é usada por outra saída.' },
      ]);
      expect(problems(changed((d) => (d.outputs[1]['type'] = 'string')))).toEqual([
        { code: 'AU002', path: 'outputs[1].type', text: 'O tipo string não existe: escolha um da lista.' },
      ]);
      expect(codes(changed((d) => (d.outputs[0]['key'] = 'cpf')))).toEqual([]); // the lists are separate
    });

    it('flag more than 50 outputs', () => {
      const many = changed((d) => (d.outputs = Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, type: 'number', source: 'status' }))));
      expect(problems(many)).toEqual([{ code: 'AU001', path: 'outputs', text: 'Uma automação tem no máximo 50 saídas.' }]);
    });
  });

  describe('AU010', () => {
    it('reads the body by a path of 1 to 20 names or positions, or the status as a number', () => {
      const cases: [(d: ReturnType<typeof valid>) => void, string, string][] = [
        [(d) => (d.outputs[0]['source'] = 'header'), 'outputs[0].source', 'A origem de uma saída é o corpo da resposta ou o status HTTP.'],
        [(d) => delete d.outputs[0]['path'], 'outputs[0].path', 'Uma saída do corpo lê um caminho de 1 a 20 nomes ou posições.'],
        [(d) => (d.outputs[0]['path'] = []), 'outputs[0].path', 'Uma saída do corpo lê um caminho de 1 a 20 nomes ou posições.'],
        [(d) => (d.outputs[0]['path'] = Array.from({ length: 21 }, (_, i) => `p${i}`)), 'outputs[0].path', 'Uma saída do corpo lê um caminho de 1 a 20 nomes ou posições.'],
        [(d) => (d.outputs[0]['path'] = ['a', -1]), 'outputs[0].path', 'Cada trecho do caminho é um nome ou a posição de um item, a partir de 0.'],
        [(d) => (d.outputs[0]['path'] = ['a', 1.5]), 'outputs[0].path', 'Cada trecho do caminho é um nome ou a posição de um item, a partir de 0.'],
        [(d) => (d.outputs[0]['path'] = ['a', '']), 'outputs[0].path', 'Cada trecho do caminho é um nome ou a posição de um item, a partir de 0.'],
        [(d) => (d.outputs[0]['path'] = ['a', null]), 'outputs[0].path', 'Cada trecho do caminho é um nome ou a posição de um item, a partir de 0.'],
        [(d) => (d.outputs[0]['path'] = ['a', true]), 'outputs[0].path', 'Cada trecho do caminho é um nome ou a posição de um item, a partir de 0.'],
        [(d) => (d.outputs[2]['type'] = 'text'), 'outputs[2].type', 'O status HTTP é uma saída de número.'],
        [(d) => (d.outputs[2]['path'] = ['a']), 'outputs[2].path', 'Uma saída do status HTTP não tem caminho.'],
      ];
      for (const [change, path, text] of cases) {
        expect(problems(changed(change))).toEqual([{ code: 'AU010', path, text }]);
      }
    });

    it('needs a JSON response for outputs read from the body', () => {
      expect(problems(changed((d) => (d.response.type = 'none')))).toEqual([
        { code: 'AU010', path: 'outputs[0].source', text: 'Saídas lidas do corpo pedem a resposta JSON.' },
        { code: 'AU010', path: 'outputs[1].source', text: 'Saídas lidas do corpo pedem a resposta JSON.' },
      ]);
      expect(problems(changed((d) => (d.response.type = 'xml')))).toContainEqual({ code: 'AU010', path: 'response.type', text: 'A resposta é JSON ou nenhuma.' });
      expect(codes(changed((d) => ((d.response.type = 'none'), (d.outputs = [{ key: 'httpStatus', type: 'number', source: 'status' }]))))).toEqual([]);
    });

    it('passes the near misses', () => {
      expect(codes(changed((d) => (d.outputs[0]['path'] = Array.from({ length: 20 }, (_, i) => `p${i}`))))).toEqual([]);
      expect(codes(changed((d) => (d.outputs[0]['path'] = ['itens', 0, 'nome'])))).toEqual([]);
    });
  });
});
