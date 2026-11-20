import { AutomationResources } from '../automations-api';
import { readDocument } from './automation-document';
import { callProblems } from './call-checks';

/** The request of a test document, as the tests change it. */
interface RequestShape {
  method: string;
  destination: string;
  host?: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: { type: string; keys?: string[] } | null;
  auth?: { type: string; username: string; password: string } | null;
}

/** `Valid()` of AutomationDocumentTests.cs. */
function valid(): { request: RequestShape } & Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'http',
    inputs: [
      { key: 'cpf', type: 'text', required: true },
      { key: 'valor', type: 'number' },
      { key: 'itens', type: 'list<object>' },
    ],
    request: {
      method: 'POST',
      destination: 'erp',
      path: '/v1/clientes/{cpf}/consultas',
      query: { origem: 'chain', valor: '{valor}' },
      headers: { 'X-Api-Key': '{{secret:erp_api_key}}', Accept: 'application/json' },
      body: { type: 'json', keys: ['cpf', 'valor', 'itens'] },
    },
    response: { type: 'json' },
    outputs: [{ key: 'httpStatus', type: 'number', required: true, source: 'status' }],
  };
}

function withRequest(change: (request: RequestShape) => void): object {
  const document = valid();
  change(document.request);
  return document;
}

/** `Erp()` of the server's tests: https://api.erp.example with the prefix /v1, which erp_api_key allows. */
function erp(change: Partial<AutomationResources['destinations'][number]> = {}): AutomationResources {
  return {
    destinations: [{ name: 'erp', description: null, scheme: 'https', host: 'api.erp.example', port: null, pathPrefix: '/v1', ...change }],
    secrets: [{ name: 'erp_api_key', description: null, allowedDestinations: ['erp'] }],
  };
}

const problems = (json: object, resources: AutomationResources | null = erp()) => callProblems(readDocument(json), resources);
const codes = (json: object, resources: AutomationResources | null = erp()) => problems(json, resources).map((problem) => problem.code);

describe('the local checks of the call (automation-ui.md §7.9; AutomationDocumentTests.cs)', () => {
  it('passes the valid document', () => {
    expect(problems(valid())).toEqual([]);
  });

  describe('AU003: the method', () => {
    it('is one of five', () => {
      for (const method of ['get', 'HEAD', 'OPTIONS']) {
        expect(problems(withRequest((r) => (r.method = method)))).toEqual([
          { code: 'AU003', path: 'request.method', text: 'O método é GET, POST, PUT, PATCH ou DELETE.' },
        ]);
      }
      for (const method of ['PUT', 'PATCH']) {
        expect(codes(withRequest((r) => (r.method = method)))).toEqual([]);
      }
    });

    it('has no body with GET or DELETE', () => {
      for (const method of ['GET', 'DELETE']) {
        expect(problems(withRequest((r) => (r.method = method)))).toEqual([{ code: 'AU003', path: 'request.body', text: 'GET e DELETE não têm corpo.' }]);
        expect(codes(withRequest((r) => ((r.method = method), delete r.body)))).toEqual([]);
      }
    });
  });

  describe('AU004: the path', () => {
    it('is a URL path whose templates name scalar inputs', () => {
      const cases: [string, string][] = [
        ['v1/clientes', 'O caminho começa com / e tem no máximo 2000 caracteres.'],
        ['/v1/../admin', "O caminho não pode ter um trecho '..'."],
        ['/v1/..', "O caminho não pode ter um trecho '..'."],
        ['/v1?x=1', "O caminho não tem '?': use os parâmetros da consulta."],
        ['/v1#parte', "O caminho não tem '#'."],
        ['/v1/\u0001', 'O caminho não pode ter caracteres de controle.'],
        ['/v1/{{secret:erp_api_key}}', 'Chaves no caminho envolvem a chave de uma entrada, como {cpf}.'],
        ['/v1/{nope}', '{nope} não é uma entrada.'],
        [
          '/v1/{itens}',
          '{itens} é uma entrada do tipo lista de objetos: no caminho só cabem entradas de texto, número, sim ou não, data, data e hora ou hora.',
        ],
        ['/v1/{cpf', 'Chaves no caminho envolvem a chave de uma entrada, como {cpf}.'],
        ['/v1/{}', 'Chaves no caminho envolvem a chave de uma entrada, como {cpf}.'],
        ['/v1/a b', "' ' não pode aparecer no caminho: codifique-o (RFC 3986)."],
        ['/v1/relatórios', "'ó' não pode aparecer no caminho: codifique-o (RFC 3986)."],
        ['/v1/%2e%2e/admin', "O caminho não pode codificar '.', '/' ou '\\'."],
        ['/v1/a%2Fb', "O caminho não pode codificar '.', '/' ou '\\'."],
        ['/v1/a%5cb', "O caminho não pode codificar '.', '/' ou '\\'."],
        ['/v1/a\\b', "'\\' não pode aparecer no caminho: codifique-o (RFC 3986)."],
        ['/v1/%zz', 'Um % no caminho começa um byte codificado, como %20.'],
      ];
      for (const [path, text] of cases) {
        expect(problems(withRequest((r) => (r.path = path))).filter((problem) => problem.code === 'AU004')).toEqual([{ code: 'AU004', path: 'request.path', text }]);
      }
    });

    it('quotes the whole character, never half of a pair (#127)', () => {
      for (const [path, quoted] of [
        ['/v1/\u{1F600}', '\u{1F600}'],
        ['/v1/\u{1F1E7}\u{1F1F7}', '\u{1F1E7}\u{1F1F7}'],
        ['/v1/café', 'é'],
      ]) {
        expect(problems(withRequest((r) => (r.path = path)))[0].text).toBe(`'${quoted}' não pode aparecer no caminho: codifique-o (RFC 3986).`);
      }
    });

    it('has at most 2000 characters', () => {
      expect(codes(withRequest((r) => (r.path = '/v1/' + 'a'.repeat(1997))))).toContain('AU004');
      expect(codes(withRequest((r) => (r.path = '/v1/' + 'a'.repeat(1996))))).not.toContain('AU004');
    });

    it('passes the near misses', () => {
      for (const path of ['/v1/clientes/{cpf}/x-{valor}.json', '/v1', '/v1/a%20b', "/v1/..x/~a!$&'()*+,;=:@", '/v1/']) {
        expect(codes(withRequest((r) => (r.path = path)))).not.toContain('AU004');
      }
    });
  });

  describe('AU005: the query', () => {
    it('has names of 1 to 100 characters', () => {
      expect(problems(withRequest((r) => (r.query[''] = 'x')))).toEqual([
        { code: 'AU005', path: 'request.query.', text: 'O nome de um parâmetro tem de 1 a 100 caracteres.', part: 'name' },
      ]);
      expect(codes(withRequest((r) => (r.query['q'.repeat(101)] = 'x')))).toEqual(['AU005']);
      expect(codes(withRequest((r) => (r.query['q'.repeat(100)] = 'x')))).toEqual([]);
    });

    it('has values that are literal or exactly one scalar input', () => {
      const cases: [string, string][] = [
        ['{nope}', '{nope} não é uma entrada.'],
        ['{itens}', '{itens} é uma entrada do tipo lista de objetos: na consulta só cabem entradas de texto, número, sim ou não, data, data e hora ou hora.'],
        ['x{valor}', 'O valor é um texto fixo ou exatamente uma {entrada}.'],
        ['{valor}{cpf}', 'O valor é um texto fixo ou exatamente uma {entrada}.'],
        ['{{secret:erp_api_key}}', 'Credenciais não vão na consulta.'],
      ];
      for (const [value, text] of cases) {
        expect(problems(withRequest((r) => (r.query['q'] = value)))).toContainEqual({ code: 'AU005', path: 'request.query.q', text });
      }
      for (const value of ['{cpf}', 'chain', '{"a":1}', '']) {
        expect(codes(withRequest((r) => (r.query['q'] = value)))).toEqual([]);
      }
    });
  });

  describe('AU009: the body', () => {
    it('names inputs once, and is JSON', () => {
      expect(problems(withRequest((r) => (r.body!.keys = ['cpf', 'nope'])))).toEqual([{ code: 'AU009', path: 'request.body.keys[1]', text: 'nope não é uma entrada.' }]);
      expect(problems(withRequest((r) => (r.body!.keys = ['cpf', 'cpf'])))).toEqual([
        { code: 'AU009', path: 'request.body.keys[1]', text: 'cpf aparece mais de uma vez.' },
      ]);
      expect(problems(withRequest((r) => (r.body!.type = 'xml')))).toEqual([{ code: 'AU009', path: 'request.body.type', text: 'O corpo é JSON.' }]);
    });

    it('passes the near misses', () => {
      expect(codes(withRequest((r) => delete r.body!.keys))).toEqual([]);
      expect(codes(withRequest((r) => (r.body!.keys = [])))).toEqual([]);
      expect(codes(withRequest((r) => (r.body = null)))).toEqual([]);
    });
  });

  describe('against /resources', () => {
    it('AU101: the destination exists', () => {
      expect(problems(valid(), { destinations: [], secrets: [] })).toContainEqual({ code: 'AU101', path: 'request.destination', text: 'O destino erp não existe mais.' });
      expect(problems(withRequest((r) => (r.destination = '')))).toContainEqual({ code: 'AU101', path: 'request.destination', text: 'Escolha um destino.' });
    });

    it('AU105: the path stays within the prefix', () => {
      for (const path of ['/v2/clientes', '/v1x', '/v1{cpf}', '/']) {
        expect(problems(withRequest((r) => (r.path = path)))).toContainEqual({
          code: 'AU105',
          path: 'request.path',
          text: 'O caminho precisa ficar dentro de /v1, o prefixo do destino.',
        });
      }
      const near: [string | null, string][] = [
        ['/v1', '/v1'],
        ['/v1', '/v1/clientes/{cpf}'],
        [null, '/qualquer'],
        ['/', '/qualquer/{cpf}'],
        ['/v1/', '/v1/clientes'],
      ];
      for (const [prefix, path] of near) {
        expect(codes(withRequest((r) => (r.path = path)), erp({ pathPrefix: prefix }))).not.toContain('AU105');
      }
    });

    it('AU106: the host fits the destination', () => {
      const wildcard = erp({ host: '*.example.com', pathPrefix: '/v1' });
      for (const host of [undefined, 'example.com', 'api.other.com', 'API.example.com', 'evil.com/.example.com']) {
        expect(problems(withRequest((r) => (host === undefined ? delete r.host : (r.host = host))), wildcard)).toContainEqual({
          code: 'AU106',
          path: 'request.host',
          text: 'O destino cobre *.example.com: informe um dos seus subdomínios como host.',
        });
      }
      expect(problems(withRequest((r) => (r.host = 'other.erp.example')))).toContainEqual({
        code: 'AU106',
        path: 'request.host',
        text: 'O host é o do destino, api.erp.example, ou nenhum.',
      });
      expect(codes(withRequest((r) => (r.host = 'api.erp.example')))).toEqual([]);
      expect(codes(withRequest((r) => (r.host = 'api.example.com')), wildcard)).toEqual([]);
      expect(codes(withRequest((r) => (r.host = 'a.b.example.com')), wildcard)).toEqual([]);
    });

    it('waits for /resources before checking references', () => {
      expect(codes(withRequest((r) => (r.destination = 'sumiu')), null)).toEqual([]);
    });
  });

  describe('AU006: the headers (AS4b-2)', () => {
    it('have names that are tokens and not reserved', () => {
      const cases: [string, string][] = [
        ['X Api', "O nome de um cabeçalho é um token HTTP (RFC 9110): letras, dígitos e !#$%&'*+-.^_`|~."],
        ['', "O nome de um cabeçalho é um token HTTP (RFC 9110): letras, dígitos e !#$%&'*+-.^_`|~."],
        ['X-Ação', "O nome de um cabeçalho é um token HTTP (RFC 9110): letras, dígitos e !#$%&'*+-.^_`|~."],
        ['Host', 'O cliente HTTP define Host; uma automação não pode.'],
        ['content-length', 'O cliente HTTP define content-length; uma automação não pode.'],
        ['Proxy-Authorization', 'O cliente HTTP define Proxy-Authorization; uma automação não pode.'],
        ['idempotency-key', 'idempotency-key leva a chave de idempotência (Execução).'],
        ['accept', 'O cabeçalho accept aparece mais de uma vez.'],
      ];
      for (const [name, text] of cases) {
        expect(problems(withRequest((r) => (r.headers[name] = 'x')))).toContainEqual({ code: 'AU006', path: `request.headers.${name}`, text, part: 'name' });
      }
      for (const name of ['Transfer-Encoding', 'Connection', 'Upgrade', 'TE', 'Trailer']) {
        expect(codes(withRequest((r) => (r.headers[name] = 'x')))).toEqual(['AU006']);
      }
    });

    it('have values of visible ASCII, spaces and tabs, without inputs', () => {
      for (const value of ['a\r\nX-Injected: 1', 'a\nb', 'João', 'a b', 'a\u007Fb', 'a\u001Fb', 'a\vb']) {
        expect(problems(withRequest((r) => (r.headers['X-Nome'] = value)))).toEqual([
          { code: 'AU006', path: 'request.headers.X-Nome', text: 'O valor de um cabeçalho só tem caracteres ASCII visíveis, espaços e tabulações (RFC 9110).' },
        ]);
      }
      for (const value of ['{cpf}', 'Bearer {valor}', '{{erp_api_key}}']) {
        expect(problems(withRequest((r) => (r.headers['X-Value'] = value)))).toEqual([
          { code: 'AU006', path: 'request.headers.X-Value', text: 'Entradas não vão em cabeçalhos nesta versão.' },
        ]);
      }
      for (const value of ['Joao', 'a\tb', 'a b', '!~', '{{secret:erp_api_key}}']) {
        expect(codes(withRequest((r) => (r.headers['X-Nome'] = value)))).toEqual([]);
      }
    });

    it('are at most 30', () => {
      const headers = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`X-H${i}`, 'v']));
      expect(problems(withRequest((r) => (r.headers = headers(31))))).toContainEqual({ code: 'AU006', path: 'request.headers', text: 'Uma automação envia no máximo 30 cabeçalhos.' });
      expect(codes(withRequest((r) => (r.headers = headers(30))))).not.toContain('AU006');
    });

    it('pass the near misses', () => {
      expect(codes(withRequest((r) => (r.headers['X-Proxy'] = 'x')))).toEqual([]);
      expect(codes(withRequest((r) => (r.headers['Content-Type'] = 'application/json; charset=utf-8')))).toEqual([]);
      expect(codes(withRequest((r) => (r.headers['X-Template'] = '{"a": 1} { x }')))).toEqual([]);
      const document = withRequest((r) => (r.headers['Idempotency-Key'] = 'fixed')) as Record<string, unknown>;
      document['execution'] = { idempotency: { mode: 'none' } };
      expect(codes(document)).toEqual([]);
    });
  });

  describe('AU007: credential placeholders (AS4b-2)', () => {
    it('are well formed', () => {
      for (const value of ['{{secret:ERP}}', '{{secret:erp_api_key', '{{secret:}}', '{{secret: erp_api_key}}', 'Bearer {{secret:erp_api_key}} {{secret:-x}}']) {
        expect(problems(withRequest((r) => (r.headers['Authorization'] = value)))).toContainEqual({
          code: 'AU007',
          path: 'request.headers.Authorization',
          text: 'Escreva uma credencial como {{secret:nome}}, com o nome de uma credencial.',
        });
      }
    });

    it('appear only in header values and basic authentication', () => {
      const elsewhere = 'Credenciais só vão em valores de cabeçalho e na autenticação básica.';
      expect(problems(withRequest((r) => (r.query['key'] = '{{secret:erp_api_key}}')))).toContainEqual({ code: 'AU007', path: 'request.query.key', text: elsewhere });
      expect(problems(withRequest((r) => (r.path = '/v1/{{secret:erp_api_key}}')))).toContainEqual({ code: 'AU007', path: 'request.path', text: elsewhere });
      expect(problems(withRequest((r) => (r.host = '{{secret:erp_api_key}}')))).toContainEqual({ code: 'AU007', path: 'request.host', text: elsewhere });
      expect(problems(withRequest((r) => (r.headers['{{secret:erp_api_key}}'] = 'x')))).toContainEqual({ code: 'AU007', path: 'request.headers.{{secret:erp_api_key}}', text: elsewhere, part: 'name' });
      const output = valid();
      output['outputs'] = [{ key: 'situacao', type: 'text', source: 'body', path: ['resultado', '{{secret:erp_api_key}}'] }];
      expect(problems(output)).toContainEqual({ code: 'AU007', path: 'outputs[0].path[1]', text: elsewhere });
    });

    it('pass the near misses', () => {
      expect(codes(withRequest((r) => (r.headers['Authorization'] = 'Bearer {{secret:erp_api_key}}')))).toEqual([]);
      const auth = withRequest((r) => (r.auth = { type: 'basic', username: '{{secret:erp_user}}', password: 'pre-{{secret:erp_api_key}}' }));
      expect(codes(auth, { ...erp(), secrets: [...erp().secrets, { name: 'erp_user', description: null, allowedDestinations: ['erp'] }] })).toEqual([]);
    });
  });

  describe('AU008: basic authentication (AS4b-2)', () => {
    const basic = (username: string, password = '{{secret:erp_api_key}}', type = 'basic') => withRequest((r) => (r.auth = { type, username, password }));

    it('is basic, with a username and a password', () => {
      expect(problems(basic('u', 'p', 'digest'))).toContainEqual({ code: 'AU008', path: 'request.auth.type', text: 'A autenticação é básica.' });
      for (const [username, password] of [
        ['', 'p'],
        ['u', ''],
      ]) {
        expect(problems(basic(username, password))).toContainEqual({ code: 'AU008', path: 'request.auth', text: 'A autenticação básica tem usuário e senha.' });
      }
    });

    it("has no ':' in the username, but for a placeholder's", () => {
      for (const username of ['a:b', ':', '{{secret:erp_user}}:x']) {
        expect(problems(basic(username))).toContainEqual({ code: 'AU008', path: 'request.auth.username', text: "O usuário não pode ter ':' (RFC 7617)." });
      }
      expect(codes(basic('pre-{{secret:erp_api_key}}'))).toEqual([]);
      expect(codes(basic('ana.souza'))).toEqual([]);
      expect(codes(basic('u', 'a:b{{secret:erp_api_key}}'))).toEqual([]); // RFC 7617 allows ':' in the password
      expect(codes(basic('joão', 'senha com espaço e ç {{secret:erp_api_key}}'))).toEqual([]);
    });

    it('has no control characters (RFC 7617, card #128)', () => {
      expect(problems(basic('ana\nsouza'))).toContainEqual({ code: 'AU008', path: 'request.auth.username', text: 'O usuário não pode ter caracteres de controle (RFC 7617).' });
      for (const password of ['pass\tword', 'pass\u007f', 'pass\u0085']) {
        expect(problems(basic('u', password))).toContainEqual({ code: 'AU008', path: 'request.auth.password', text: 'A senha não pode ter caracteres de controle (RFC 7617).' });
      }
    });

    it('does not mix with an Authorization header', () => {
      const both = withRequest((r) => ((r.auth = { type: 'basic', username: 'u', password: '{{secret:erp_api_key}}' }), (r.headers['authorization'] = 'Bearer {{secret:erp_api_key}}')));
      expect(problems(both)).toContainEqual({ code: 'AU008', path: 'request.auth', text: 'Use a autenticação básica ou um cabeçalho Authorization, não os dois.' });
      expect(codes(withRequest((r) => (r.headers['Authorization'] = 'Bearer {{secret:erp_api_key}}')))).toEqual([]);
    });
  });

  describe('AU013: no literal credentials (Q-AS4 (c), card #235)', () => {
    const LITERAL = 'Este valor fica visível para quem modela, nas versões publicadas e nos pedidos de execução. Use uma credencial.';

    it('flags a credential header or a password with no placeholder', () => {
      for (const [name, value] of [
        ['Authorization', 'Bearer abc123'],
        ['authorization', 'abc'],
        ['Cookie', 'sessao=abc'],
        ['x-api-key', ''],
      ]) {
        expect(problems(withRequest((r) => (r.headers[name] = value)))).toContainEqual({ code: 'AU013', path: `request.headers.${name}`, text: LITERAL });
      }
      const password = withRequest((r) => (r.auth = { type: 'basic', username: 'u', password: 'hunter2' }));
      expect(problems(password)).toEqual([{ code: 'AU013', path: 'request.auth.password', text: LITERAL }]);
    });

    it('passes the near misses', () => {
      expect(codes(withRequest((r) => (r.headers['Authorization'] = 'Bearer {{secret:erp_api_key}}')))).toEqual([]);
      expect(codes(withRequest((r) => (r.headers['Accept'] = 'application/json')))).toEqual([]);
      expect(codes(withRequest((r) => (r.auth = { type: 'basic', username: 'chain', password: 'pre-{{secret:erp_api_key}}' })))).toEqual([]);
      expect(codes(withRequest((r) => (r.headers['Authorization'] = '{{secret:ERP}}')))).toEqual(['AU007']); // AU007's alone
      expect(codes(withRequest((r) => (r.auth = { type: 'basic', username: 'u', password: '' })))).not.toContain('AU013'); // AU008's
    });
  });

  describe('AU102 and AU103: credentials against /resources (AS4b-2)', () => {
    it('exist and allow the destination, shown at each field that uses them', () => {
      expect(problems(valid(), { ...erp(), secrets: [] })).toEqual([
        { code: 'AU102', path: 'request.headers.X-Api-Key', text: 'A credencial erp_api_key não existe.' },
      ]);
      expect(problems(valid(), { ...erp(), secrets: [{ name: 'erp_api_key', description: null, allowedDestinations: ['crm'] }] })).toEqual([
        { code: 'AU103', path: 'request.headers.X-Api-Key', text: 'A credencial erp_api_key não permite o destino erp.' },
      ]);
      const password = withRequest((r) => (r.auth = { type: 'basic', username: 'u', password: '{{secret:erp_password}}' }));
      expect(problems(password)).toEqual([{ code: 'AU102', path: 'request.auth.password', text: 'A credencial erp_password não existe.' }]);
    });

    it('are checked without a destination too, which only AU102 needs', () => {
      expect(problems(withRequest((r) => (r.destination = '')), { destinations: [], secrets: [] }).map((problem) => problem.code)).toEqual(['AU101', 'AU102']);
    });
  });
});
