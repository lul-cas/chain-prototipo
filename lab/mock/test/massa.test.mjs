// Critérios 2 a 4 de mock.md §6: cada linha da massa produz o resultado que a tabela diz.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criarMock } from '../app.mjs';
import { cnpj, cpf, documentoValido } from '../massa.mjs';

const CHAVE = 'chave-de-teste';
let sequencia = 0;

function novoMock() {
  return criarMock({ chave: CHAVE, hoje: '2026-11-06' });
}

async function pedir(mock, metodo, caminho, corpo) {
  sequencia += 1;
  return mock.tratar({
    metodo,
    caminho,
    cabecalhos: { 'x-api-key': CHAVE, 'idempotency-key': `massa-${sequencia}` },
    corpo: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
}

async function cliente(mock, base) {
  return (await pedir(mock, 'GET', `/core/v1/clientes/${cpf(base)}`)).corpo;
}

test('os documentos têm dígitos verificadores válidos', () => {
  assert.equal(cpf('000000001').length, 11);
  assert.ok(documentoValido(cpf('000000001')));
  assert.equal(cnpj('900000010001').length, 14);
  assert.ok(documentoValido(cnpj('900000010001')));
  assert.ok(!documentoValido('00000000100'));
});

test('os dígitos conferem com a fórmula clássica, em todos os restos', () => {
  const classico = (digitos, pesoInicial) => (digitos.reduce((soma, d, i) => soma + d * (pesoInicial - i), 0) * 10 % 11) % 10;
  for (let n = 1; n < 2000; n += 1) {
    const base = String(n).padStart(9, '0');
    const digitos = [...base].map(Number);
    const primeiro = classico(digitos, 10);
    const segundo = classico([...digitos, primeiro], 11);
    assert.equal(cpf(base), `${base}${primeiro}${segundo}`);
  }
  assert.equal(cpf('529982247'), '52998224725');
  assert.equal(cnpj('112223330001'), '11222333000181');
});

test('um cliente da massa vem completo, e um desconhecido só com o status', async () => {
  const mock = novoMock();
  const ana = await cliente(mock, '000000001');
  assert.equal(ana.encontrado, true);
  assert.equal(ana.nomeCliente, 'Ana Clara Moreira');
  assert.equal(ana.situacaoCliente, 'ativo');
  assert.equal(ana.tipoPessoa, 'pf');
  assert.equal(ana.rendaMensal, 12000);
  assert.ok(ana.dataValidadeCadastro >= '2026-11-06');
  assert.ok(ana.endereco.cep);
  assert.ok(ana.email && ana.telefone && ana.numeroConta);

  assert.deepEqual(await cliente(mock, '000000101'), { encontrado: false });
});

test('a empresa da massa é pessoa jurídica', async () => {
  const mock = novoMock();
  const empresa = (await pedir(mock, 'GET', `/core/v1/clientes/${cnpj('900000010001')}`)).corpo;
  assert.equal(empresa.nomeCliente, 'Oficina Boa Vista Ltda');
  assert.equal(empresa.tipoPessoa, 'pj');
  assert.equal(empresa.rendaMensal, 60000);
});

test('as particularidades da massa de clientes', async () => {
  const mock = novoMock();
  assert.ok((await cliente(mock, '000000005')).dataValidadeCadastro < '2026-11-06', 'Eduarda tem cadastro vencido');
  assert.equal((await cliente(mock, '000000006')).situacaoCliente, 'bloqueado');

  const exposicaoDiogo = (await pedir(mock, 'GET', `/core/v1/clientes/${cpf('000000004')}/exposicao`)).corpo;
  assert.equal(exposicaoDiogo.atrasoMaximoDias, 120);
  assert.equal(exposicaoDiogo.parcelasAtuais, 900);

  const exposicaoBruno = (await pedir(mock, 'GET', `/core/v1/clientes/${cpf('000000002')}/exposicao`)).corpo;
  assert.deepEqual(exposicaoBruno, { parcelasAtuais: 800, saldoDevedorTotal: 12000, atrasoMaximoDias: 45 }, 'os contratos da massa contam, sem dobrar');

  const exposicaoCarla = (await pedir(mock, 'GET', `/core/v1/clientes/${cpf('000000003')}/exposicao`)).corpo;
  assert.deepEqual(exposicaoCarla, { parcelasAtuais: 200, saldoDevedorTotal: 4800, atrasoMaximoDias: 0 }, 'sem contrato, 24 parcelas');

  const gabriela = (await pedir(mock, 'GET', `/core/v1/clientes/${cpf('000000007')}/pendencias`)).corpo;
  assert.deepEqual(gabriela, { possuiPendencia: true, saldoConta: 300, contratosAtivos: 1, apolicesAtivas: 1, cotasAtivas: 0 });

  const heitor = (await pedir(mock, 'GET', `/core/v1/clientes/${cpf('000000008')}/pendencias`)).corpo;
  assert.deepEqual(heitor, { possuiPendencia: false, saldoConta: 1500, contratosAtivos: 0, apolicesAtivas: 0, cotasAtivas: 0 });

  const iris = (await pedir(mock, 'GET', `/core/v1/clientes/${cpf('000000009')}/pendencias`)).corpo;
  assert.equal(iris.saldoConta, 0);
});

test('o score e as restrições de cada cliente', async () => {
  const mock = novoMock();
  const score = async (base) => (await pedir(mock, 'GET', `/bureau/v1/score/${cpf(base)}`)).corpo;
  assert.deepEqual(await score('000000001'), { score: 800, possuiRestricao: false, valorRestricoes: 0 });
  assert.equal((await score('000000003')).score, 350);
  assert.deepEqual(await score('000000012'), { score: 720, possuiRestricao: true, valorRestricoes: 2500 });
  assert.equal((await score('000000101')).score, 650, 'quem não está na massa tem score 650');
});

test('o validador segue a tabela, e um dígito errado é inexistente', async () => {
  const mock = novoMock();
  const situacao = async (documento) => (await pedir(mock, 'GET', `/validador/v1/documentos/${documento}`)).corpo.situacaoDocumento;
  assert.equal(await situacao(cpf('000000101')), 'regular');
  assert.equal(await situacao(cpf('000000102')), 'irregular');
  assert.equal(await situacao('00000010100'), 'inexistente');
  assert.equal(await situacao(cpf('000000001')), 'regular');
});

test('as listas restritivas seguem a tabela', async () => {
  const mock = novoMock();
  const pld = async (base) => (await pedir(mock, 'POST', '/pld/v1/consultas', { documentoCliente: cpf(base), nomeCliente: 'Fulano' })).corpo;
  assert.deepEqual(await pld('000000101'), { resultadoPld: 'limpo', pep: false });
  assert.deepEqual(await pld('000000103'), { resultadoPld: 'alerta', pep: false });
  assert.deepEqual(await pld('000000104'), { resultadoPld: 'bloqueio', pep: false });
  assert.deepEqual(await pld('000000105'), { resultadoPld: 'limpo', pep: true });
  assert.equal((await pld('000000011')).resultadoPld, 'alerta', 'Karina tem alerta');
});

test('os contratos da massa, e um desconhecido só com o status', async () => {
  const mock = novoMock();
  const contrato = async (numero) => (await pedir(mock, 'GET', `/core/v1/contratos/${numero}`)).corpo;
  const renegociacao = await contrato('CT-1001');
  assert.equal(renegociacao.encontrado, true);
  assert.equal(renegociacao.documentoCliente, cpf('000000002'));
  assert.equal(renegociacao.nomeCliente, 'Bruno Teixeira');
  assert.equal(renegociacao.saldoDevedor, 12000);
  assert.equal(renegociacao.valorParcela, 600);
  assert.equal(renegociacao.diasAtraso, 45);
  assert.ok(renegociacao.email);
  assert.equal((await contrato('CT-1002')).diasAtraso, 400);
  assert.equal((await contrato('CT-1003')).diasAtraso, 0);
  assert.deepEqual(await contrato('CT-9999'), { encontrado: false });
});

test('o Motor calcula a taxa pelo score e a parcela pela tabela Price', async () => {
  const mock = novoMock();
  const simular = async (score) => (await pedir(mock, 'POST', '/motor/v1/simulacoes', { produto: 'pessoal', valorSolicitado: 10000, prazoMeses: 12, score })).corpo;
  assert.equal((await simular(800)).taxaMensal, 1.5);
  assert.equal((await simular(650)).taxaMensal, 2.2);
  assert.equal((await simular(350)).taxaMensal, 3.5);
  assert.equal((await simular(750)).taxaMensal, 1.5, 'a partir de 750');
  assert.equal((await simular(749)).taxaMensal, 2.2);
  assert.equal((await simular(600)).taxaMensal, 2.2, 'a partir de 600');
  assert.equal((await simular(599)).taxaMensal, 3.5);
  const resultado = await simular(800);
  assert.equal(resultado.valorParcela, 916.8);
  assert.equal(resultado.cetAnual, 19.56);
});

test('o Motor devolve a decisão que recebeu', async () => {
  const mock = novoMock();
  const aprovada = (await pedir(mock, 'POST', '/motor/v1/decisoes', {
    documentoCliente: cpf('000000001'), produto: 'pessoal', decisao: 'aprovado', origemDecisao: 'automatica',
    valorAprovado: 15000, prazoAprovado: 24, taxaAprovada: 1.5, validadeAprovacao: '2026-11-21',
  })).corpo;
  assert.deepEqual(aprovada, { decisaoCredito: 'aprovado', valorAprovado: 15000, prazoAprovado: 24, taxaAprovada: 1.5, validadeAprovacao: '2026-11-21' });

  const recusa = (await pedir(mock, 'POST', '/motor/v1/decisoes', { documentoCliente: cpf('000000003'), produto: 'pessoal', decisao: 'recusado', origemDecisao: 'analise' })).corpo;
  assert.deepEqual(recusa, { decisaoCredito: 'recusado' });
});

test('a aprovação de Nestor volta vencida, e a recusa dele não ganha validade', async () => {
  const mock = novoMock();
  const decisao = async (corpo) => (await pedir(mock, 'POST', '/motor/v1/decisoes', { documentoCliente: cpf('000000014'), produto: 'pessoal', origemDecisao: 'automatica', ...corpo })).corpo;
  assert.equal((await decisao({ decisao: 'aprovado', validadeAprovacao: '2026-11-21' })).validadeAprovacao, '2026-11-05');
  assert.deepEqual(await decisao({ decisao: 'recusado' }), { decisaoCredito: 'recusado' });
});

test('o envelope está assinado na primeira consulta, exceto o de Júlio', async () => {
  const mock = novoMock();
  const enviar = async (base) => (await pedir(mock, 'POST', '/assinador/v1/envelopes', { documentoCliente: cpf(base), referencia: 'CT-1', email: 'a@b.c' })).corpo.idEnvelope;
  const consultar = async (id) => (await pedir(mock, 'GET', `/assinador/v1/envelopes/${id}`)).corpo.assinaturaConcluida;

  assert.equal(await consultar(await enviar('000000001')), true);
  const julio = await enviar('000000010');
  assert.equal(await consultar(julio), false);
  assert.equal(await consultar(julio), true);
});

test('o seguro de vida a partir de R$ 100 mil exige subscrição', async () => {
  const mock = novoMock();
  const cotar = async (tipoSeguro, capitalSegurado) => (await pedir(mock, 'POST', '/seguradora/v1/cotacoes', { documentoCliente: cpf('000000001'), tipoSeguro, capitalSegurado })).corpo;
  assert.equal((await cotar('vida', 100000)).exigeSubscricao, true);
  assert.equal((await cotar('vida', 99999)).exigeSubscricao, false);
  assert.equal((await cotar('auto', 500000)).exigeSubscricao, false);
  assert.equal((await cotar('vida', 120000)).premioMensal, 60);
  assert.equal((await cotar('prestamista', 15000)).premioMensal, 15);
});

test('a apólice vale por um ano a partir de hoje', async () => {
  const mock = novoMock();
  const { idCotacao } = (await pedir(mock, 'POST', '/seguradora/v1/cotacoes', { documentoCliente: cpf('000000001'), tipoSeguro: 'vida', capitalSegurado: 1000 })).corpo;
  const apolice = (await pedir(mock, 'POST', '/seguradora/v1/apolices', { idCotacao, documentoCliente: cpf('000000001') })).corpo;
  assert.equal(apolice.vigenciaInicio, '2026-11-06');
  assert.equal(apolice.vigenciaFim, '2027-11-06');
  assert.match(apolice.numeroApolice, /^AP-\d{4}$/);
});

test('o regulador recebe a comunicação de uma operação e devolve o protocolo', async () => {
  const mock = novoMock();
  const corpo = { numeroContrato: 'CT-2001', documentoCliente: cpf('000000001'), valorLiberado: 15000, dataLiberacao: '2026-11-06' };
  const resposta = await pedir(mock, 'POST', '/regulador/v1/operacoes-credito', corpo);
  assert.equal(resposta.status, 200);
  assert.match(resposta.corpo.protocoloComunicacao, /^REG-\d{4}$/);
  const estado = (await pedir(mock, 'GET', '/__mock/estado')).corpo;
  assert.deepEqual(estado.comunicacoes, [{ protocoloComunicacao: resposta.corpo.protocoloComunicacao, ...corpo }]);
});

test('o razão classifica tudo, exceto o ajuste manual', async () => {
  const mock = novoMock();
  const classificar = async (eventoContabil) => (await pedir(mock, 'POST', '/razao/v1/classificacoes', { eventoContabil, valor: 100 })).corpo;
  const liberacao = await classificar('liberacao_credito');
  assert.equal(liberacao.classificado, true);
  assert.match(liberacao.contaDebito, /^[0-9]{1,2}(\.[0-9]{1,3}){2,4}$/);
  assert.match(liberacao.contaCredito, /^[0-9]{1,2}(\.[0-9]{1,3}){2,4}$/);
  assert.deepEqual(await classificar('ajuste_manual'), { classificado: false });
});
