import { TestBed } from '@angular/core/testing';
import { AutomationDraftEditor } from './automation-draft-editor';
import { documentOf, inputsOf, requestOf } from './automation-edits';
import { outputsOf } from './output-edits';

function draft(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'http',
    inputs: [
      { key: 'cpf', type: 'text', required: true },
      { key: 'valor', type: 'number', required: false },
    ],
    request: { method: 'POST', destination: 'erp', path: '/v1/{cpf}', body: { type: 'json', keys: ['cpf'] } },
    response: { type: 'json' },
  };
}

function setup(json: unknown = draft()): AutomationDraftEditor {
  TestBed.configureTestingModule({ providers: [AutomationDraftEditor] });
  const editor = TestBed.inject(AutomationDraftEditor);
  editor.load(json);
  return editor;
}

const keys = (editor: AutomationDraftEditor) => inputsOf(editor.draft().json).map((input) => input['key']);
const ids = (editor: AutomationDraftEditor) => editor.draft().inputIds;

describe('AutomationDraftEditor (automation-ui.md §5.4)', () => {
  it('loads the draft as it is, with nothing to save, undo or redo', () => {
    const json = draft();
    const editor = setup(json);

    expect(editor.draft().json).toBe(json);
    expect(ids(editor)).toHaveLength(2);
    expect(editor.dirty()).toBe(false);
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
  });

  it('says what each change did, in the status line', () => {
    const editor = setup();
    const [cpf, valor] = ids(editor);

    const added = editor.addInput()!;
    expect(editor.notice()).toBe('Entrada adicionada.');
    editor.setInputKey(added, 'nome');
    expect(editor.notice()).toBe('Chave alterada para nome.');
    editor.setInputKey(cpf, 'documento');
    expect(editor.notice()).toBe('Chave alterada para documento, também no caminho e no corpo.');
    editor.setInputType(valor, 'list<number>');
    expect(editor.notice()).toBe('Tipo de valor: lista de números.');
    editor.setInputRequired(valor, true);
    expect(editor.notice()).toBe('Entrada valor obrigatória.');
    editor.setInputRequired(valor, false);
    expect(editor.notice()).toBe('Entrada valor opcional.');
    editor.moveInput(valor, -1);
    expect(editor.notice()).toBe('Entrada movida para cima: valor.');
    editor.moveInput(valor, 1);
    expect(editor.notice()).toBe('Entrada movida para baixo: valor.');
    editor.removeInput(added);
    expect(editor.notice()).toBe('Entrada removida: nome.');
    editor.undo();
    expect(editor.notice()).toBe('Alteração desfeita.');
    editor.redo();
    expect(editor.notice()).toBe('Alteração refeita.');
    editor.setInputKey(cpf, '');
    expect(editor.notice()).toBe('Chave apagada.');
  });

  it('undoes and redoes each change, and a new change drops what could be redone', () => {
    const editor = setup();
    const [cpf] = ids(editor);

    editor.setInputKey(cpf, 'documento');
    editor.removeInput(ids(editor)[1]);
    expect(keys(editor)).toEqual(['documento']);

    editor.undo();
    expect(keys(editor)).toEqual(['documento', 'valor']);
    editor.undo();
    expect(keys(editor)).toEqual(['cpf', 'valor']);
    expect(editor.dirty()).toBe(false);
    expect(editor.canUndo()).toBe(false);

    editor.redo();
    expect(keys(editor)).toEqual(['documento', 'valor']);
    editor.setInputType(cpf, 'number');
    expect(editor.canRedo()).toBe(false);
  });

  it('ignores a change that changes nothing, and moves past an end', () => {
    const editor = setup();
    const [cpf, valor] = ids(editor);

    editor.setInputType(cpf, 'text');
    editor.moveInput(cpf, -1);
    editor.moveInput(valor, 1);

    expect(editor.canUndo()).toBe(false);
    expect(editor.dirty()).toBe(false);
  });

  it('keeps up to 200 steps', () => {
    const editor = setup();
    const [cpf] = ids(editor);
    for (let n = 1; n <= 201; n++) {
      editor.setInputKey(cpf, `k${n}`);
    }

    for (let n = 0; n < 200; n++) {
      editor.undo();
    }

    expect(keys(editor)[0]).toBe('k1');
    expect(editor.canUndo()).toBe(false);
  });

  it('refuses a 51st input and says why', () => {
    const editor = setup({ ...draft(), inputs: Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, type: 'text', required: false })) });

    expect(editor.addInput()).toBeNull();
    expect(editor.notice()).toBe('Uma automação tem no máximo 50 entradas.');
    expect(editor.canUndo()).toBe(false);
  });

  it('is clean again when it returns to what was saved, and keeps edits made while saving unsaved', () => {
    const editor = setup();
    const [cpf] = ids(editor);

    editor.setInputKey(cpf, 'documento');
    const sent = editor.draft();
    editor.setInputRequired(cpf, false);
    editor.markSaved(sent);
    expect(editor.dirty()).toBe(true);

    editor.undo();
    expect(editor.dirty()).toBe(false);
  });

  it('discards back to the saved draft, with nothing to undo', () => {
    const editor = setup();
    const saved = editor.draft();

    editor.setInputKey(ids(editor)[0], 'documento');
    editor.discard();

    expect(editor.draft()).toBe(saved);
    expect(editor.canUndo()).toBe(false);
    expect(editor.notice()).toBeNull();
  });

  it('edits the call and says what changed (§7.3)', () => {
    const editor = setup({ ...draft(), request: { method: 'GET', destination: '', path: '/' } });
    const erp = { name: 'erp', description: null, scheme: 'https', host: 'api.erp.example', port: null, pathPrefix: '/v1' };
    const request = () => requestOf(documentOf(editor.draft()));

    editor.setDestination('erp', erp);
    expect(editor.notice()).toBe('Destino: erp. O caminho passou a ser /v1, o prefixo do destino.');
    editor.setMethod('POST');
    expect(editor.notice()).toBe('Método: POST.');
    editor.setPath('/v1/{cpf}');
    expect(editor.notice()).toBe('Caminho: /v1/{cpf}.');
    editor.setHost('api.erp.example');
    expect(editor.notice()).toBe('Host: api.erp.example.');
    editor.setHost('');
    expect(editor.notice()).toBe('Host removido.');

    const row = editor.addQueryRow();
    expect(editor.notice()).toBe('Parâmetro adicionado.');
    editor.setQueryName(row, 'origem');
    expect(editor.notice()).toBe('Nome do parâmetro: origem.');
    editor.setQueryValue(row, '{cpf}');
    expect(editor.notice()).toBe('Valor de origem: {cpf}.');

    editor.setBody('some');
    expect(editor.notice()).toBe('Corpo: JSON com só estas entradas.');
    editor.setBodyKey('valor', false);
    expect(editor.notice()).toBe('Entrada valor fora do corpo.');
    editor.setBodyKey('valor', true);
    expect(editor.notice()).toBe('Entrada valor no corpo.');
    editor.setBody('all');
    expect(editor.notice()).toBe('Corpo: JSON com todas as entradas.');
    editor.removeQueryRow(row);
    expect(editor.notice()).toBe('Parâmetro removido: origem.');
    editor.setBody('none');
    expect(editor.notice()).toBe('Corpo: sem corpo.');

    expect(request()).toEqual({ method: 'POST', destination: 'erp', path: '/v1/{cpf}', body: null });
    for (let n = 0; n < 15; n++) {
      editor.undo();
    }
    expect(request()).toEqual({ method: 'GET', destination: '', path: '/' });
    expect(editor.dirty()).toBe(false);
  });

  it('edits the headers and the authentication, never repeating a value in the status line (AS4b-2)', () => {
    const editor = setup({ ...draft(), request: { method: 'GET', destination: 'erp', path: '/' } });
    const request = () => requestOf(documentOf(editor.draft()));

    const row = editor.addHeaderRow()!;
    expect(editor.notice()).toBe('Cabeçalho adicionado.');
    editor.setHeaderName(row, 'X-Api-Key');
    expect(editor.notice()).toBe('Nome do cabeçalho: X-Api-Key.');
    editor.setHeaderValue(row, 'segredo-literal');
    expect(editor.notice()).toBe('Valor de X-Api-Key alterado.');
    editor.setAuth('basic');
    expect(editor.notice()).toBe('Autenticação: básica.');
    editor.setAuthField('username', 'chain');
    expect(editor.notice()).toBe('Usuário alterado.');
    editor.setAuthField('password', 'hunter2');
    expect(editor.notice()).toBe('Senha alterada.');
    expect(request()).toEqual({
      method: 'GET',
      destination: 'erp',
      path: '/',
      headers: { 'X-Api-Key': 'segredo-literal' },
      auth: { type: 'basic', username: 'chain', password: 'hunter2' },
    });

    editor.setAuth('none');
    expect(editor.notice()).toBe('Autenticação: nenhuma.');
    editor.removeHeaderRow(row);
    expect(editor.notice()).toBe('Cabeçalho removido: X-Api-Key.');
  });

  it('refuses a 31st header and says why', () => {
    const headers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`X-${i}`, 'v']));
    const editor = setup({ ...draft(), request: { method: 'GET', destination: 'erp', path: '/', headers } });

    expect(editor.addHeaderRow()).toBeNull();
    expect(editor.notice()).toBe('Uma automação envia no máximo 30 cabeçalhos.');
    expect(editor.canUndo()).toBe(false);
  });

  it('edits the response and the outputs and says what changed (AS5a)', () => {
    const editor = setup({ ...draft(), outputs: [{ key: 'situacao', type: 'text', required: true, source: 'body', path: ['resultado', 'situacao'] }] });
    const [situacao] = editor.draft().outputIds;
    const outputs = () => outputsOf(documentOf(editor.draft()));

    const added = editor.addOutput()!;
    expect(editor.notice()).toBe('Saída adicionada.');
    editor.setOutputKey(added, 'httpStatus');
    expect(editor.notice()).toBe('Chave da saída alterada para httpStatus.');
    editor.setOutputSource(added, 'status');
    expect(editor.notice()).toBe('Origem de httpStatus: status HTTP.');
    editor.setOutputPath(situacao, ['itens', 0, 'nome.completo']);
    expect(editor.notice()).toBe('Caminho de situacao: itens[0]["nome.completo"].');
    editor.setOutputType(situacao, 'unknown');
    expect(editor.notice()).toBe('Tipo de situacao: tipo desconhecido.');
    editor.setOutputRequired(situacao, false);
    expect(editor.notice()).toBe('Saída situacao opcional.');
    editor.moveOutput(added, -1);
    expect(editor.notice()).toBe('Saída movida para cima: httpStatus.');
    editor.setResponseType('none');
    expect(editor.notice()).toBe('Resposta: nenhuma.');

    expect(outputs()).toEqual([
      { key: 'httpStatus', type: 'number', required: false, source: 'status' },
      { key: 'situacao', type: 'unknown', required: false, source: 'body', path: ['itens', 0, 'nome.completo'] },
    ]);
    editor.removeOutput(added);
    expect(editor.notice()).toBe('Saída removida: httpStatus.');
  });

  it('refuses a 51st output and says why', () => {
    const editor = setup({ ...draft(), outputs: Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, type: 'number', source: 'status' })) });

    expect(editor.addOutput()).toBeNull();
    expect(editor.notice()).toBe('Uma automação tem no máximo 50 saídas.');
  });

  it('remembers each input key from when the draft was opened, for the rename warning', () => {
    const editor = setup();
    const [cpf] = ids(editor);

    editor.setInputKey(cpf, 'documento');
    const added = editor.addInput()!;

    expect(editor.keyAtLoad(cpf)).toBe('cpf');
    expect(editor.keyAtLoad(added)).toBeUndefined();
  });
});
