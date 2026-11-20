import { DEFAULT_EXECUTION, deadlineSeconds, durationText, readDocument } from './automation-document';
import { callPreview } from './call-preview';

const DRAFT = {
  schemaVersion: 1,
  kind: 'http',
  inputs: [
    { key: 'cpf', type: 'text', required: true },
    { key: 'valor', type: 'number', required: false },
  ],
  request: {
    method: 'POST',
    destination: 'erp',
    path: '/v1/clientes/{cpf}/consultas',
    query: { valor: '{valor}', origem: 'chain app' },
    headers: { 'X-Api-Key': '{{secret:erp_api_key}}', Accept: 'application/json' },
    auth: null,
    body: { type: 'json', keys: ['cpf', 'valor'] },
  },
  response: { type: 'json' },
  outputs: [],
};
const ERP = { scheme: 'https', host: 'api.erp.example', port: null };

describe('the call preview (automation-ui.md §7.6, automation-contract.md §3)', () => {
  it('builds the call in the contract order, with the inputs left as {chave}', () => {
    expect(callPreview(readDocument(DRAFT), ERP)).toBe(
      [
        'POST https://api.erp.example/v1/clientes/{cpf}/consultas?origem=chain%20app&valor={valor}',
        'Accept: application/json',
        'Content-Type: application/json',
        'X-Api-Key: {{secret:erp_api_key}}',
        'Idempotency-Key: (chave desta execução)',
        '',
        '{"cpf": {cpf}, "valor": {valor}}',
      ].join('\n'),
    );
  });

  it("shows a port that isn't the default, the wildcard's host, basic authentication, and no Content-Type a header sets", () => {
    const document = readDocument({
      ...DRAFT,
      request: { ...DRAFT.request, host: 'api.parceiro.example', query: {}, headers: { 'content-type': 'application/json; charset=utf-8' }, auth: { type: 'basic', username: 'u', password: '{{secret:p}}' }, body: { type: 'json' } },
      execution: { ...DEFAULT_EXECUTION, idempotency: { mode: 'none' } },
    });

    expect(callPreview(document, { scheme: 'https', host: '*.parceiro.example', port: 8443 }).split('\n')).toEqual([
      'POST https://api.parceiro.example:8443/v1/clientes/{cpf}/consultas',
      'content-type: application/json; charset=utf-8',
      'Authorization: Basic (usuário e senha)',
      '',
      '{"cpf": {cpf}, "valor": {valor}}', // every input when keys is absent
    ]);
  });

  it('percent-encodes every byte but the unreserved characters', () => {
    const document = readDocument({ ...DRAFT, request: { ...DRAFT.request, query: { "a(b)": "x!y*'é" }, headers: {}, body: null } });

    expect(callPreview(document, ERP).split('\n')[0]).toBe("POST https://api.erp.example/v1/clientes/{cpf}/consultas?a%28b%29=x%21y%2A%27%C3%A9");
  });

  it('says where the destination goes when there is none', () => {
    expect(callPreview(readDocument({ ...DRAFT, request: { ...DRAFT.request, destination: '' } }), null).split('\n')[0]).toMatch(/^POST \(destino\)\/v1/);
  });
});

describe("the step's deadline (automation.md §8.2)", () => {
  it('is 16 min 30 s with the defaults', () => {
    expect(deadlineSeconds(DEFAULT_EXECUTION)).toBe(990);
    expect(durationText(990)).toBe('16 min 30 s');
  });

  it('counts each wait as at least 60 s, and the waits double up to 5 minutes', () => {
    expect(deadlineSeconds({ ...DEFAULT_EXECUTION, timeoutSeconds: 10, retry: { maxAttempts: 1, initialDelaySeconds: 5 } })).toBe(610);
    expect(deadlineSeconds({ ...DEFAULT_EXECUTION, timeoutSeconds: 10, retry: { maxAttempts: 3, initialDelaySeconds: 60 } })).toBe(30 + 66 + 132 + 600);
    expect(durationText(3720)).toBe('1 h 2 min');
  });
});
