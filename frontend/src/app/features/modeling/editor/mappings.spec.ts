import { AutomationContract } from '../automations-api';
import { CatalogEntry } from './conditions';
import { SUBPROCESS_TEXTS, StepContract, StepMappings, holdsFiles, keptText, mappingProblems, readMappings, writeMappings } from './mappings';

const CONTRACT: AutomationContract = {
  version: 2,
  inputs: [
    { key: 'cpf', type: 'text', required: true },
    { key: 'valor', type: 'number', required: false },
    { key: 'desde', type: 'date', required: false },
  ],
  outputs: [
    { key: 'situacao', type: 'text', required: true },
    { key: 'score', type: 'number', required: false },
  ],
};

const CATALOG: CatalogEntry[] = [
  { path: ['cpf'], type: 'text', presence: 'definite', sources: ['start'] },
  { path: ['limite'], type: 'number', presence: 'definite', sources: ['start'] },
  { path: ['valor'], type: 'number', presence: 'definite', sources: ['start'] },
];

const path = (...segments: string[]) => ({ kind: 'path', path: segments });

describe("an automatic step's mappings (workflow-editor.md §10.9, automation.md §5.6)", () => {
  it('reads a value per declared input and a key per declared output, in the contract order, and writes them back', () => {
    const reference = {
      automationId: 'a-2',
      inputs: { valor: path('limite'), cpf: path('cpf'), desde: { kind: 'system', name: 'currentDate', offset: { amount: -30, unit: 'days' } } },
      outputs: { situacaoCpf: path('situacao') },
    };

    const mappings = readMappings(reference, CONTRACT);
    expect(mappings.inputs.map((input) => [input.field.key, input.value])).toEqual([
      ['cpf', { kind: 'path', path: ['cpf'] }],
      ['valor', { kind: 'path', path: ['limite'] }],
      ['desde', { kind: 'system', name: 'currentDate', offset: { sign: '-', amount: '30', unit: 'days' } }],
    ]);
    expect(mappings.outputs.map((output) => [output.field.key, output.target])).toEqual([
      ['situacao', 'situacaoCpf'],
      ['score', ''],
    ]);
    expect(writeMappings(mappings)).toEqual({ inputs: reference.inputs, outputs: reference.outputs });
    expect(readMappings({ automationId: 'a-2' }, CONTRACT).inputs.every((input) => input.value === null)).toBe(true);
  });

  it('keeps, as they are, inputs the version no longer declares and outputs of another shape', () => {
    const sum = { kind: 'arithmetic', op: 'add', left: path('score'), right: { kind: 'literal', type: 'number', value: '1' } };
    const reference = {
      automationId: 'a-2',
      inputs: { cpf: path('cpf'), antigo: path('valor') },
      outputs: { pontos: sum, nota: path('score'), outraNota: path('score'), extra: path('naoDeclarada') },
    };

    const mappings = readMappings(reference, CONTRACT);
    expect(mappings.otherInputs).toEqual([{ key: 'antigo', json: path('valor') }]);
    expect(mappings.outputs.map((output) => output.target)).toEqual(['', 'nota']);
    expect(mappings.otherOutputs.map((mapping) => mapping.key)).toEqual(['pontos', 'outraNota', 'extra']);
    expect(writeMappings(mappings)).toEqual({ inputs: reference.inputs, outputs: reference.outputs });
    expect(keptText(mappings.otherOutputs[0])).toBe('pontos ← (data.score + 1)');
  });

  it('warns about a required input not sent and an input the version lacks, and checks values against the input type', () => {
    const problems = (mappings: StepMappings) => Object.fromEntries(mappingProblems(mappings, CATALOG));
    const read = (inputs: Record<string, unknown>) => readMappings({ automationId: 'a-2', inputs }, CONTRACT);

    expect(problems(read({}))).toEqual({ 'input:cpf': { warning: 'Entrada obrigatória: publicar exige um valor.' } });
    expect(problems(read({ cpf: path('cpf'), antigo: path('cpf') }))).toEqual({ 'input:antigo': { warning: 'A automação não declara esta entrada.' } });
    expect(problems(read({ cpf: path('cpf'), valor: path('cpf') }))).toEqual({ 'input:valor': { warning: 'Os tipos não combinam.' } });
    expect(problems(read({ cpf: { kind: 'literal', type: 'text', value: '' } }))).toEqual({ 'input:cpf': { error: 'Informe o valor.' } });
    expect(problems(read({ cpf: path('cpf'), valor: { kind: 'literal', type: 'number', value: '1,5' } }))).toEqual({ 'input:valor': { error: 'Número inválido.' } });
    expect(writeMappings(read({ cpf: { kind: 'literal', type: 'text', value: '' } }))).toBeNull();
  });

  it('refuses an output key that is not valid, or that another output already writes', () => {
    const mappings = (targets: string[], others: string[] = []): StepMappings => ({
      inputs: [],
      otherInputs: [],
      freeInputs: [],
      outputs: CONTRACT.outputs.map((field, index) => ({ field, target: targets[index] ?? '' })),
      otherOutputs: others.map((key) => ({ key, json: path('x') })),
    });
    const invalid = { error: 'Use uma letra e depois letras sem acento, dígitos ou _, até 64 caracteres.' };

    for (const key of ['1a', 'situação', 'a-b', 'a'.repeat(65), ' a']) {
      expect(mappingProblems(mappings([key]), [])).toEqual(new Map([['output:situacao', invalid]]));
    }
    expect(mappingProblems(mappings(['a'.repeat(64), 'x_1']), []).size).toBe(0);
    expect(mappingProblems(mappings(['nota', 'nota']), [])).toEqual(new Map([['output:score', { error: 'Outra saída já é guardada com esta chave.' }]]));
    expect(mappingProblems(mappings(['pontos'], ['pontos']), [])).toEqual(new Map([['output:situacao', { error: 'Outra saída já é guardada com esta chave.' }]]));
    expect(writeMappings(mappings(['nota', 'nota']))).toBeNull();
  });

  it("warns with each step's texts: a sub-workflow's start form refuses at run time what publishing lets through", () => {
    const read = readMappings({ workflowId: 'w-2', inputs: { antigo: path('cpf') } }, CONTRACT);
    expect(Object.fromEntries(mappingProblems(read, CATALOG, SUBPROCESS_TEXTS))).toEqual({
      'input:cpf': { warning: 'Campo obrigatório: sem ele, a subsolicitação é recusada.' },
      'input:antigo': { warning: 'O formulário inicial do processo não tem este campo.' },
    });
  });

  it('takes any keys from a child without a start form (TC-5), and checks each key', () => {
    const free: StepContract = { version: 1, inputs: null, outputs: [] };
    const reference = { workflowId: 'w-2', inputs: { cliente: path('cpf'), valor: { kind: 'literal', type: 'text', value: '10' } } };

    const mappings = readMappings(reference, free);
    expect(mappings.inputs).toEqual([]);
    expect(mappings.otherInputs).toEqual([]);
    expect(mappings.freeInputs).toEqual([
      { key: 'cliente', value: { kind: 'path', path: ['cpf'] } },
      { key: 'valor', value: { kind: 'literal', type: 'text', value: '10' } },
    ]);
    expect(writeMappings(mappings)).toEqual({ inputs: reference.inputs, outputs: {} });

    const keyed = (...keys: string[]): StepMappings => ({ ...mappings, freeInputs: keys.map((key) => ({ key, value: { kind: 'path', path: ['cpf'] } })) });
    expect(Object.fromEntries(mappingProblems(keyed('', '1x', 'a', 'a'), CATALOG, SUBPROCESS_TEXTS))).toEqual({
      'free:0': { error: 'Informe a chave.' },
      'free:1': { error: 'Use uma letra e depois letras sem acento, dígitos ou _, até 64 caracteres.' },
      'free:3': { error: 'Outra entrada já usa esta chave.' },
    });
    expect(writeMappings(keyed('a', 'a'))).toBeNull();
    expect(Object.fromEntries(mappingProblems({ ...mappings, freeInputs: [{ key: 'x', value: { kind: 'literal', type: 'text', value: '' } }] }, CATALOG))).toEqual({
      'free:0': { error: 'Informe o valor.' },
    });
  });
});

describe("a sub-workflow step's inputs, which can't carry files (workflow-editor.md §10.10, WF206; card #202)", () => {
  const FILES: CatalogEntry[] = [
    ...CATALOG,
    { path: ['contato'], type: 'object', presence: 'optional', sources: ['start'] },
    { path: ['contato', 'email'], type: 'text', presence: 'optional', sources: ['start'] },
    { path: ['docs'], type: 'list<file>', presence: 'optional', sources: ['start'] },
    { path: ['endereco'], type: 'object', presence: 'optional', sources: ['start'] },
    { path: ['endereco', 'cep'], type: 'text', presence: 'optional', sources: ['start'] },
    { path: ['endereco', 'comprovante'], type: 'list<file>', presence: 'optional', sources: ['start'] },
    { path: ['socios'], type: 'list<object>', presence: 'optional', sources: ['start'] },
    { path: ['socios', '[]', 'documento'], type: 'list<list<file>>', presence: 'optional', sources: ['start'] },
    { path: ['socios', '[]', 'nome'], type: 'list<text>', presence: 'optional', sources: ['start'] },
  ];
  const CHILD: StepContract = {
    version: 3,
    inputs: [
      { key: 'anexos', type: 'list<file>', required: true },
      { key: 'endereco', type: 'object', required: false },
      { key: 'cpf', type: 'text', required: false },
    ],
    outputs: [],
  };
  const NO_FILES = { warning: 'Arquivos não passam para um subprocesso: publicar recusa esta entrada.' };
  const problems = (inputs: Record<string, unknown>, contract: StepContract = CHILD) =>
    Object.fromEntries(mappingProblems(readMappings({ workflowId: 'w-2', inputs }, contract), FILES, SUBPROCESS_TEXTS));

  it('tells the data that hold files: a file field, and a group or list with one', () => {
    expect(FILES.filter((entry) => holdsFiles(entry, FILES)).map((entry) => entry.path.join('.'))).toEqual([
      'docs',
      'endereco',
      'endereco.comprovante',
      'socios',
      'socios.[].documento',
    ]);
  });

  it('warns about an input into a file field, whatever its value, or one naming data that hold files, in place of the type check', () => {
    expect(problems({ anexos: path('docs'), endereco: path('endereco'), cpf: path('cpf') })).toEqual({ 'input:anexos': NO_FILES, 'input:endereco': NO_FILES });
    expect(problems({ anexos: { kind: 'literal', type: 'text', value: 'x' } })).toEqual({ 'input:anexos': NO_FILES });
    expect(problems({ endereco: path('contato') })).toEqual({ 'input:anexos': { warning: 'Campo obrigatório: sem ele, a subsolicitação é recusada.' } });
  });

  it('warns about a free input naming data that hold files, and not about one that only reads from them', () => {
    const free: StepContract = { version: 1, inputs: null, outputs: [] };
    const count = { kind: 'call', function: 'count', args: [path('docs')] };

    expect(problems({ a: path('socios', '[]', 'documento'), b: path('socios', '[]', 'nome'), c: count, d: path('contato') }, free)).toEqual({ 'free:0': NO_FILES });
  });

  it("leaves an automation step's inputs alone, since an automation takes files (WF204)", () => {
    const contract: StepContract = { version: 1, inputs: [{ key: 'arquivo', type: 'object', required: false }], outputs: [] };

    expect(mappingProblems(readMappings({ automationId: 'a-1', inputs: { arquivo: path('endereco') } }, contract), FILES).size).toBe(0);
  });
});
