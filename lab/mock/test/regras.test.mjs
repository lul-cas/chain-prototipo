// Critérios 5 a 7 de mock.md §6, e o que mock.md §2 diz sobre respostas fora dos contratos.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { criarMock } from '../app.mjs';
import { cpf } from '../massa.mjs';
import { criarServidor } from '../server.mjs';

const CHAVE = 'chave-de-teste';
const COM_CHAVE = { 'x-api-key': CHAVE };

function novoMock() {
  return criarMock({ chave: CHAVE, hoje: '2026-11-06' });
}

const CLIENTE_NOVO = {
  documentoCliente: cpf('000000101'), tipoPessoa: 'pf', nomeCliente: 'Nina Souza', rendaMensal: 4000, endereco: { cep: '01001000' },
  email: 'nina@exemplo.test', telefone: '11999990000', tipoConta: 'corrente', dataValidadeCadastro: '2028-11-06',
};

test('sem a chave certa a resposta é 401, em qualquer caminho', async () => {
  const mock = novoMock();
  for (const caminho of [`/core/v1/clientes/${cpf('000000001')}`, '/nada', '/__mock/estado']) {
    assert.equal((await mock.tratar({ metodo: 'GET', caminho, cabecalhos: {} })).status, 401);
    assert.equal((await mock.tratar({ metodo: 'GET', caminho, cabecalhos: { 'x-api-key': 'errada' } })).status, 401);
  }
});

test('um caminho desconhecido é 404', async () => {
  assert.equal((await novoMock().tratar({ metodo: 'GET', caminho: '/core/v1/nada', cabecalhos: COM_CHAVE })).status, 404);
});

test('um corpo que não é JSON é 400', async () => {
  const resposta = await novoMock().tratar({ metodo: 'POST', caminho: '/pld/v1/consultas', cabecalhos: COM_CHAVE, corpo: '{nao-e-json' });
  assert.equal(resposta.status, 400);
});

test('repetir a Idempotency-Key devolve a mesma resposta, sem repetir o efeito', async () => {
  const mock = novoMock();
  const pedido = {
    metodo: 'POST',
    caminho: '/pagamentos/v1/pagamentos',
    cabecalhos: { ...COM_CHAVE, 'idempotency-key': 'pagamento-1' },
    corpo: JSON.stringify({ favorecido: 'Heitor Lima', contaDestino: '123-4', valor: 1500, referencia: 'X' }),
  };
  const primeira = await mock.tratar(pedido);
  const segunda = await mock.tratar(pedido);
  assert.deepEqual(segunda, primeira);
  const estado = (await mock.tratar({ metodo: 'GET', caminho: '/__mock/estado', cabecalhos: COM_CHAVE })).corpo;
  assert.equal(estado.pagamentos.length, 1);

  const outra = await mock.tratar({ ...pedido, cabecalhos: { ...COM_CHAVE, 'idempotency-key': 'pagamento-2' } });
  assert.notEqual(outra.corpo.idPagamento, primeira.corpo.idPagamento);
});

test('depois do reinício, a mesma Idempotency-Key executa de novo', async () => {
  const mock = novoMock();
  const pedido = { metodo: 'POST', caminho: '/notificacoes/v1/mensagens', cabecalhos: { ...COM_CHAVE, 'idempotency-key': 'n' }, corpo: JSON.stringify({ destinatario: 'a@b.c', modelo: 'm', referencia: 'r' }) };
  await mock.tratar(pedido);
  await mock.tratar({ metodo: 'POST', caminho: '/__mock/reiniciar', cabecalhos: COM_CHAVE });
  await mock.tratar(pedido);
  const estado = (await mock.tratar({ metodo: 'GET', caminho: '/__mock/estado', cabecalhos: COM_CHAVE })).corpo;
  assert.equal(estado.mensagens.length, 1);
});

test('o cliente criado é lido depois, e o reinício apaga o que foi gravado', async () => {
  const mock = novoMock();
  const criado = await mock.tratar({ metodo: 'POST', caminho: '/core/v1/clientes', cabecalhos: { ...COM_CHAVE, 'idempotency-key': 'novo' }, corpo: JSON.stringify(CLIENTE_NOVO) });
  assert.equal(criado.status, 200);
  assert.match(criado.corpo.idCliente, /^CLI-\d{4}$/);
  assert.ok(criado.corpo.numeroConta);

  const lido = (await mock.tratar({ metodo: 'GET', caminho: `/core/v1/clientes/${CLIENTE_NOVO.documentoCliente}`, cabecalhos: COM_CHAVE })).corpo;
  assert.equal(lido.encontrado, true);
  assert.equal(lido.nomeCliente, 'Nina Souza');
  assert.equal(lido.situacaoCliente, 'ativo');
  assert.equal(lido.dataValidadeCadastro, '2028-11-06');

  assert.equal((await mock.tratar({ metodo: 'POST', caminho: '/__mock/reiniciar', cabecalhos: COM_CHAVE })).status, 200);
  const depois = (await mock.tratar({ metodo: 'GET', caminho: `/core/v1/clientes/${CLIENTE_NOVO.documentoCliente}`, cabecalhos: COM_CHAVE })).corpo;
  assert.deepEqual(depois, { encontrado: false });
});

test('um contrato liberado entra na exposição e nas pendências do cliente', async () => {
  const mock = novoMock();
  const documento = cpf('000000009');
  const post = (caminho, corpo, chave) => mock.tratar({ metodo: 'POST', caminho, cabecalhos: { ...COM_CHAVE, 'idempotency-key': chave }, corpo: corpo && JSON.stringify(corpo) });
  const { numeroContrato } = (await post('/core/v1/contratos', { documentoCliente: documento, produto: 'pessoal', valorAprovado: 5000, prazoAprovado: 10, taxaAprovada: 2 }, 'c1')).corpo;
  assert.match(numeroContrato, /^CT-2\d{3}$/);
  const liberado = (await post(`/core/v1/contratos/${numeroContrato}/liberacao`, undefined, 'c2')).corpo;
  assert.deepEqual(liberado, { valorLiberado: 5000, dataLiberacao: '2026-11-06' });

  const exposicao = (await mock.tratar({ metodo: 'GET', caminho: `/core/v1/clientes/${documento}/exposicao`, cabecalhos: COM_CHAVE })).corpo;
  assert.equal(exposicao.saldoDevedorTotal, 5000);
  const pendencias = (await mock.tratar({ metodo: 'GET', caminho: `/core/v1/clientes/${documento}/pendencias`, cabecalhos: COM_CHAVE })).corpo;
  assert.equal(pendencias.contratosAtivos, 1);
  assert.equal(pendencias.possuiPendencia, true);
});

test('uma apólice registrada entra nas pendências, e bloquear e encerrar mudam a situação', async () => {
  const mock = novoMock();
  const documento = cpf('000000008');
  const post = (caminho, corpo, chave) => mock.tratar({ metodo: 'POST', caminho, cabecalhos: { ...COM_CHAVE, 'idempotency-key': chave }, corpo: JSON.stringify(corpo) });
  const situacao = async () => (await mock.tratar({ metodo: 'GET', caminho: `/core/v1/clientes/${documento}`, cabecalhos: COM_CHAVE })).corpo.situacaoCliente;

  await post(`/core/v1/clientes/${documento}/apolices`, { documentoCliente: documento, numeroApolice: 'AP-1', premioMensal: 10 }, 'a1');
  assert.equal((await mock.tratar({ metodo: 'GET', caminho: `/core/v1/clientes/${documento}/pendencias`, cabecalhos: COM_CHAVE })).corpo.apolicesAtivas, 1);

  assert.deepEqual((await post(`/core/v1/clientes/${documento}/bloqueio`, { motivo: 'pld' }, 'a2')).corpo, { situacaoCliente: 'bloqueado' });
  assert.equal(await situacao(), 'bloqueado');

  const encerrado = await post(`/core/v1/clientes/${documento}/encerramento`, { motivoEncerramento: 'pedido_cliente' }, 'a3');
  assert.deepEqual(encerrado.corpo, { dataEncerramento: '2026-11-06' });
  assert.equal(await situacao(), 'encerrado');
});

test('atualizar um cliente muda o que o Core devolve', async () => {
  const mock = novoMock();
  const documento = cpf('000000005');
  const atualizado = await mock.tratar({
    metodo: 'PUT',
    caminho: `/core/v1/clientes/${documento}`,
    cabecalhos: { ...COM_CHAVE, 'idempotency-key': 'u1' },
    corpo: JSON.stringify({ rendaMensal: 7500, endereco: { cep: '02002000' }, email: 'novo@exemplo.test', telefone: '11988880000', dataValidadeCadastro: '2028-11-06' }),
  });
  assert.deepEqual(atualizado.corpo, { atualizado: true });
  const lido = (await mock.tratar({ metodo: 'GET', caminho: `/core/v1/clientes/${documento}`, cabecalhos: COM_CHAVE })).corpo;
  assert.equal(lido.rendaMensal, 7500);
  assert.equal(lido.dataValidadeCadastro, '2028-11-06');
  assert.equal(lido.email, 'novo@exemplo.test');
});

test('o estado mostra o que as automações gravaram', async () => {
  const mock = novoMock();
  await mock.tratar({ metodo: 'POST', caminho: '/notificacoes/v1/mensagens', cabecalhos: { ...COM_CHAVE, 'idempotency-key': 'n1' }, corpo: JSON.stringify({ destinatario: 'a@b.c', modelo: 'boas_vindas', referencia: 'X' }) });
  await mock.tratar({ metodo: 'POST', caminho: '/razao/v1/lancamentos', cabecalhos: { ...COM_CHAVE, 'idempotency-key': 'l1' }, corpo: JSON.stringify({ eventoContabil: 'renegociacao', valor: 10, dataCompetencia: '2026-11-06', documentoReferencia: 'AC-1', contaDebito: '1.1.1', contaCredito: '2.1.1', historico: 'x' }) });
  const estado = (await mock.tratar({ metodo: 'GET', caminho: '/__mock/estado', cabecalhos: COM_CHAVE })).corpo;
  assert.equal(estado.mensagens[0].modelo, 'boas_vindas');
  assert.equal(estado.lancamentos[0].eventoContabil, 'renegociacao');
  assert.ok(Array.isArray(estado.clientes) && estado.clientes.length >= 13);
});

test('o servidor fala HTTP de verdade, com corpo e cabeçalhos', async () => {
  const servidor = criarServidor(novoMock());
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const lido = await fetch(`${base}/pld/v1/consultas`, {
      method: 'POST',
      headers: { 'X-Api-Key': CHAVE, 'Idempotency-Key': 'h1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentoCliente: cpf('000000104'), nomeCliente: 'Fulano' }),
    });
    assert.equal(lido.status, 200);
    assert.match(lido.headers.get('content-type'), /application\/json/);
    assert.equal((await lido.json()).resultadoPld, 'bloqueio');

    assert.equal((await fetch(`${base}/core/v1/clientes/${cpf('000000001')}`)).status, 401);
  } finally {
    servidor.close();
  }
});
