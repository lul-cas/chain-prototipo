// As automações da onda 1 (mock.md §1). Contratos em sistemas-externos.md; regras do que eles deixam em aberto em mock.md §4.
import { listasRestritivas, somarAnos, somarDias, situacaoDocumento } from './massa.mjs';

const CONTAS = {
  liberacao_credito: ['1.6.1', '1.1.1'],
  renegociacao: ['1.6.2', '1.6.1'],
  provisao_perda: ['3.1.1', '1.6.9'],
  premio_seguro: ['1.1.1', '2.4.1'],
  indenizacao_seguro: ['2.4.1', '1.1.1'],
  comissao_seguro: ['1.1.1', '7.1.1'],
  taxa_adm_consorcio: ['1.1.1', '7.1.2'],
  faturamento_carta: ['2.5.1', '1.1.1'],
  iss_nfse: ['3.2.1', '2.3.1'],
  pagamento_fornecedor: ['3.3.1', '1.1.1'],
  folha_pagamento: ['3.4.1', '1.1.1'],
  rescisao: ['3.4.2', '1.1.1'],
};

const TAXAS_ANUAIS = { vida: 0.006, residencial: 0.003, auto: 0.04, prestamista: 0.012 };

const reais = (valor) => Math.round(valor * 100) / 100;

function proximo(estado, prefixo, inicio = 1) {
  const numero = (estado.sequencias.get(prefixo) ?? inicio - 1) + 1;
  estado.sequencias.set(prefixo, numero);
  return `${prefixo}-${String(numero).padStart(4, '0')}`;
}

function taxaPeloScore(score) {
  if (score >= 750) return 1.5;
  return score >= 600 ? 2.2 : 3.5;
}

function parcelaPrice(valor, prazo, taxa) {
  const i = taxa / 100;
  return i === 0 ? reais(valor / prazo) : reais((valor * i) / (1 - (1 + i) ** -prazo));
}

function contratosDe(estado, documento) {
  return [...estado.contratos.values()].filter((contrato) => contrato.documentoCliente === documento && contrato.liberado);
}

function clienteVisto(cliente) {
  const { idCliente, nomeCliente, tipoPessoa, situacaoCliente, dataValidadeCadastro, rendaMensal, endereco, email, telefone, numeroConta } = cliente;
  return { encontrado: true, idCliente, nomeCliente, tipoPessoa, situacaoCliente, dataValidadeCadastro, rendaMensal, endereco, email, telefone, numeroConta };
}

function semIndefinidos(objeto) {
  return Object.fromEntries(Object.entries(objeto).filter(([, valor]) => valor !== undefined));
}

export const ROTAS = [
  // Core Bancário
  ['GET', '/core/v1/clientes/:documento', (estado, { documento }) => {
    const cliente = estado.clientes.get(documento);
    return cliente ? clienteVisto(cliente) : { encontrado: false };
  }],
  ['POST', '/core/v1/clientes', (estado, _, corpo) => {
    const numero = estado.clientes.size + 1;
    const cliente = {
      ...corpo,
      idCliente: `CLI-${String(numero).padStart(4, '0')}`,
      situacaoCliente: 'ativo',
      numeroAgencia: '0001',
      numeroConta: `10${String(numero).padStart(4, '0')}-0`,
      saldoConta: 0,
      score: 650,
      valorRestricoes: 0,
      parcelasAtuais: 0,
      atrasoDias: 0,
      contratosForaDaMassa: 0,
      apolicesAtivas: 0,
      cotasAtivas: 0,
      assinaturaDemora: false,
    };
    estado.clientes.set(corpo.documentoCliente, cliente);
    return { idCliente: cliente.idCliente, numeroAgencia: cliente.numeroAgencia, numeroConta: cliente.numeroConta };
  }],
  ['PUT', '/core/v1/clientes/:documento', (estado, { documento }, corpo) => {
    const { rendaMensal, endereco, email, telefone, dataValidadeCadastro } = corpo;
    Object.assign(estado.clientes.get(documento), { rendaMensal, endereco, email, telefone, dataValidadeCadastro });
    return { atualizado: true };
  }],
  ['POST', '/core/v1/clientes/:documento/bloqueio', (estado, { documento }) => {
    estado.clientes.get(documento).situacaoCliente = 'bloqueado';
    return { situacaoCliente: 'bloqueado' };
  }],
  ['GET', '/core/v1/clientes/:documento/pendencias', (estado, { documento }) => {
    const cliente = estado.clientes.get(documento);
    const contratosAtivos = cliente.contratosForaDaMassa + contratosDe(estado, documento).length;
    const { saldoConta, apolicesAtivas, cotasAtivas } = cliente;
    return { possuiPendencia: contratosAtivos + apolicesAtivas + cotasAtivas > 0, saldoConta, contratosAtivos, apolicesAtivas, cotasAtivas };
  }],
  ['POST', '/core/v1/clientes/:documento/encerramento', (estado, { documento }, _, { hoje }) => {
    estado.clientes.get(documento).situacaoCliente = 'encerrado';
    return { dataEncerramento: hoje };
  }],
  ['GET', '/core/v1/clientes/:documento/exposicao', (estado, { documento }) => {
    const cliente = estado.clientes.get(documento);
    const contratos = contratosDe(estado, documento);
    const novos = contratos.filter((contrato) => !contrato.daMassa);
    const daMassa = contratos.length - novos.length;
    const saldoDosContratos = contratos.reduce((soma, contrato) => soma + contrato.saldoDevedor, 0);
    return {
      parcelasAtuais: reais(cliente.parcelasAtuais + novos.reduce((soma, contrato) => soma + contrato.valorParcela, 0)),
      saldoDevedorTotal: reais(saldoDosContratos + (daMassa === 0 ? cliente.parcelasAtuais * 24 : 0)),
      atrasoMaximoDias: Math.max(cliente.atrasoDias, ...contratos.map((contrato) => contrato.diasAtraso)),
    };
  }],
  ['POST', '/core/v1/contratos', (estado, _, corpo) => {
    const numeroContrato = proximo(estado, 'CT', 2001);
    const { documentoCliente, produto, valorAprovado, prazoAprovado, taxaAprovada } = corpo;
    estado.contratos.set(numeroContrato, {
      numeroContrato,
      documentoCliente,
      produto,
      saldoDevedor: valorAprovado,
      valorParcela: parcelaPrice(valorAprovado, prazoAprovado, taxaAprovada),
      diasAtraso: 0,
      liberado: false,
    });
    return { numeroContrato };
  }],
  ['POST', '/core/v1/contratos/:numero/liberacao', (estado, { numero }, _, { hoje }) => {
    const contrato = estado.contratos.get(numero);
    contrato.liberado = true;
    return { valorLiberado: contrato.saldoDevedor, dataLiberacao: hoje };
  }],
  ['GET', '/core/v1/contratos/:numero', (estado, { numero }) => {
    const contrato = estado.contratos.get(numero);
    if (!contrato) return { encontrado: false };
    const { documentoCliente, saldoDevedor, diasAtraso, valorParcela } = contrato;
    const { nomeCliente, email } = estado.clientes.get(documentoCliente);
    return { encontrado: true, documentoCliente, nomeCliente, email, saldoDevedor, diasAtraso, valorParcela };
  }],
  ['POST', '/core/v1/contratos/:numero/acordos', (estado, { numero }, corpo) => {
    const numeroAcordo = proximo(estado, 'AC');
    estado.acordos.push({ numeroAcordo, numeroContrato: numero, ...corpo });
    return { numeroAcordo };
  }],
  ['POST', '/core/v1/contratos/:numero/cobranca-judicial', (estado, { numero }, _, { hoje }) => {
    estado.contratos.get(numero).cobrancaJudicial = true;
    return { dataMarcacao: hoje };
  }],
  ['POST', '/core/v1/clientes/:documento/apolices', (estado, { documento }) => {
    estado.clientes.get(documento).apolicesAtivas += 1;
    return { debitoProgramado: true };
  }],

  // Validador Cadastral, Serviço de PLD e Bureau de Crédito
  ['GET', '/validador/v1/documentos/:documento', (_, { documento }) => ({ situacaoDocumento: situacaoDocumento(documento) })],
  ['POST', '/pld/v1/consultas', (estado, _, { documentoCliente }) => {
    const cliente = estado.clientes.get(documentoCliente);
    return cliente?.pld ? { resultadoPld: cliente.pld, pep: false } : listasRestritivas(documentoCliente);
  }],
  ['GET', '/bureau/v1/score/:documento', (estado, { documento }) => {
    const cliente = estado.clientes.get(documento);
    const valorRestricoes = cliente?.valorRestricoes ?? 0;
    return { score: cliente?.score ?? 650, possuiRestricao: valorRestricoes > 0, valorRestricoes };
  }],

  // Motor de Crédito
  ['POST', '/motor/v1/simulacoes', (_, __, { valorSolicitado, prazoMeses, score }) => {
    const taxaMensal = taxaPeloScore(score);
    return {
      taxaMensal,
      valorParcela: parcelaPrice(valorSolicitado, prazoMeses, taxaMensal),
      cetAnual: reais(((1 + taxaMensal / 100) ** 12 - 1) * 100),
    };
  }],
  ['POST', '/motor/v1/decisoes', (estado, _, corpo, { hoje }) => {
    estado.decisoes.push(corpo);
    const { decisao, valorAprovado, prazoAprovado, taxaAprovada } = corpo;
    const vencida = estado.clientes.get(corpo.documentoCliente)?.aprovacaoVencida && corpo.validadeAprovacao;
    const validadeAprovacao = vencida ? somarDias(hoje, -1) : corpo.validadeAprovacao;
    return semIndefinidos({ decisaoCredito: decisao, valorAprovado, prazoAprovado, taxaAprovada, validadeAprovacao });
  }],

  // Assinador Eletrônico e Registro de Garantias
  ['POST', '/assinador/v1/envelopes', (estado, _, { documentoCliente, referencia }) => {
    const idEnvelope = proximo(estado, 'ENV');
    const consultasAteAssinar = estado.clientes.get(documentoCliente)?.assinaturaDemora ? 2 : 1;
    estado.envelopes.set(idEnvelope, { idEnvelope, referencia, consultas: 0, consultasAteAssinar });
    return { idEnvelope };
  }],
  ['GET', '/assinador/v1/envelopes/:id', (estado, { id }) => {
    const envelope = estado.envelopes.get(id);
    envelope.consultas += 1;
    return { assinaturaConcluida: envelope.consultas >= envelope.consultasAteAssinar };
  }],
  ['POST', '/garantias/v1/gravames', (estado, _, corpo) => {
    const numeroGravame = proximo(estado, 'GR');
    estado.gravames.push({ numeroGravame, ...corpo });
    return { numeroGravame };
  }],

  // Seguradora Parceira
  ['POST', '/seguradora/v1/cotacoes', (estado, _, { documentoCliente, tipoSeguro, capitalSegurado }) => {
    const idCotacao = proximo(estado, 'COT');
    estado.cotacoes.set(idCotacao, { idCotacao, documentoCliente, tipoSeguro, capitalSegurado });
    return {
      idCotacao,
      premioMensal: reais((capitalSegurado * TAXAS_ANUAIS[tipoSeguro]) / 12),
      exigeSubscricao: tipoSeguro === 'vida' && capitalSegurado >= 100000,
    };
  }],
  ['POST', '/seguradora/v1/apolices', (estado, _, corpo, { hoje }) => {
    const numeroApolice = proximo(estado, 'AP');
    const apolice = { numeroApolice, vigenciaInicio: hoje, vigenciaFim: somarAnos(hoje, 1) };
    estado.apolices.push({ ...corpo, ...apolice });
    return apolice;
  }],

  // Razão Contábil
  ['POST', '/razao/v1/classificacoes', (_, __, { eventoContabil }) => {
    const contas = CONTAS[eventoContabil];
    return contas ? { classificado: true, contaDebito: contas[0], contaCredito: contas[1] } : { classificado: false };
  }],
  ['POST', '/razao/v1/lancamentos', (estado, _, corpo) => {
    const numeroLancamento = proximo(estado, 'LC');
    estado.lancamentos.push({ numeroLancamento, ...corpo });
    return { numeroLancamento };
  }],

  // Regulador Fictício: a comunicação que NOR-06 exige
  ['POST', '/regulador/v1/operacoes-credito', (estado, _, corpo) => {
    const protocoloComunicacao = proximo(estado, 'REG');
    estado.comunicacoes.push({ protocoloComunicacao, ...corpo });
    return { protocoloComunicacao };
  }],

  // Pagamentos e Notificações
  ['POST', '/pagamentos/v1/pagamentos', (estado, _, corpo) => {
    const idPagamento = proximo(estado, 'PG');
    estado.pagamentos.push({ idPagamento, ...corpo });
    return { idPagamento };
  }],
  ['POST', '/pagamentos/v1/boletos', (estado, _, corpo) => {
    const idBoleto = proximo(estado, 'BL');
    const linhaDigitavel = `34191.79001 01043.510047 91020.150008 1 ${idBoleto.slice(-4)}0000000000`;
    estado.boletos.push({ idBoleto, linhaDigitavel, ...corpo });
    return { idBoleto, linhaDigitavel };
  }],
  ['POST', '/notificacoes/v1/mensagens', (estado, _, corpo) => {
    const idMensagem = proximo(estado, 'MSG');
    estado.mensagens.push({ idMensagem, ...corpo });
    return { idMensagem };
  }],
];
