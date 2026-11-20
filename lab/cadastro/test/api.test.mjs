// O cliente da API de cadastro.md §2: sessão, CSRF e versões (identity.md, ADR-0008).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, ErroDaApi, precisaDeToken } from '../api.mjs';

function falsa(respostas) {
  const pedidos = [];
  const fetch = async (url, opcoes) => {
    pedidos.push({ url, ...opcoes });
    const { status = 200, corpo, cabecalhos = {} } = respostas.shift();
    return new Response(corpo === undefined ? null : JSON.stringify(corpo), { status, headers: cabecalhos });
  };
  return { fetch, pedidos };
}

const ORIGEM = 'http://localhost:54300';

test('o login guarda o cookie, e os pedidos seguintes o enviam, com o Origin', async () => {
  const { fetch, pedidos } = falsa([{ status: 204, cabecalhos: { 'set-cookie': 'chain_session=abc; Path=/; HttpOnly' } }, { corpo: [] }]);
  const api = new Api({ base: 'http://api', origem: ORIGEM, fetch });
  await api.entrar('lab-admin', 'senha');
  assert.equal(pedidos[0].url, 'http://api/api/auth/login');
  assert.deepEqual(JSON.parse(pedidos[0].body), { username: 'lab-admin', password: 'senha' });
  assert.equal(pedidos[0].headers.Origin, ORIGEM);

  await api.get('/api/admin/groups');
  assert.equal(pedidos[1].headers.Cookie, 'chain_session=abc');
});

test('um erro traz o método, o caminho, o status e o corpo', async () => {
  const { fetch } = falsa([{ status: 422, corpo: { code: 'publish_validation_failed', errors: [{ code: 'WF201' }] } }]);
  const api = new Api({ base: 'http://api', origem: ORIGEM, fetch });
  await assert.rejects(api.post('/api/workflows/1/publish'), (erro) => {
    assert.ok(erro instanceof ErroDaApi);
    assert.equal(erro.status, 422);
    assert.equal(erro.corpo.errors[0].code, 'WF201');
    assert.match(erro.message, /POST \/api\/workflows\/1\/publish: 422/);
    return true;
  });
});

test('uma escrita com versão lê o ETag e o manda em If-Match', async () => {
  const { fetch, pedidos } = falsa([{ corpo: { id: '1' }, cabecalhos: { etag: '"7"' } }, { corpo: {} }]);
  const api = new Api({ base: 'http://api', origem: ORIGEM, fetch });
  await api.comVersao('PUT', '/api/forms/1', '/api/forms/1/draft', { document: {} });
  assert.equal(pedidos[0].method, 'GET');
  assert.equal(pedidos[1].method, 'PUT');
  assert.equal(pedidos[1].url, 'http://api/api/forms/1/draft');
  assert.equal(pedidos[1].headers['If-Match'], '"7"');
});

test('um token de bot vai em Authorization, e sem Origin', async () => {
  const { fetch, pedidos } = falsa([{ corpo: [] }]);
  const api = new Api({ base: 'http://api', token: 'chn_x', fetch });
  await api.get('/api/tasks');
  assert.equal(pedidos[0].headers.Authorization, 'Bearer chn_x');
  assert.equal(pedidos[0].headers.Origin, undefined);
});

test('um comando leva a Idempotency-Key', async () => {
  const { fetch, pedidos } = falsa([{ status: 201, corpo: { id: 'i' } }]);
  const api = new Api({ base: 'http://api', token: 't', fetch });
  await api.comando('/api/instances', { definitionId: 'd', data: {} }, 'chave-1');
  assert.equal(pedidos[0].headers['Idempotency-Key'], 'chave-1');
});

test('um arquivo vai como formulário, com a Idempotency-Key e o token', async () => {
  const { fetch, pedidos } = falsa([{ status: 201, corpo: { id: 'arquivo-1' } }]);
  const api = new Api({ base: 'http://api', token: 't', fetch });
  const arquivo = await api.enviarArquivo('a.txt', 'text/plain', 'oi', 'chave-2');
  assert.equal(arquivo.id, 'arquivo-1');
  assert.equal(pedidos[0].url, 'http://api/api/files');
  assert.equal(pedidos[0].headers['Idempotency-Key'], 'chave-2');
  assert.equal(pedidos[0].headers.Authorization, 'Bearer t');
  assert.equal(pedidos[0].headers['Content-Type'], undefined, 'quem põe o boundary é o fetch');
  assert.equal(pedidos[0].body.get('file').name, 'a.txt');
});

test('uma resposta sem corpo vira undefined', async () => {
  const { fetch } = falsa([{ status: 204 }]);
  const api = new Api({ base: 'http://api', origem: ORIGEM, fetch });
  assert.equal(await api.put('/api/admin/groups/1/members/2'), undefined);
});

test('um token salvo só vale para o mesmo bot: depois de recriar a stack, o id muda', () => {
  assert.equal(precisaDeToken(undefined, { id: 'a' }), true);
  assert.equal(precisaDeToken({ id: 'a', token: 't' }, { id: 'a' }), false);
  assert.equal(precisaDeToken({ id: 'velho', token: 't' }, { id: 'a' }), true);
});
