// Verifica a montagem (cadastro.md §4): caminhos reais pelas personas, com as automações batendo no mock.
// Não é o laboratório: as instâncias do laboratório são conduzidas por agentes (LQ-04).
// Uso, com a stack no ar e o cadastro feito: node lab/cadastro/verificar.mjs [trecho do nome do caminho]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cnpj, cpf } from '../mock/massa.mjs';
import { Api } from './api.mjs';
import { lerProcessos, ONDA_1 } from './documentos.mjs';
import { BASE, ORIGEM, lerBots } from './cadastrar.mjs';

const SEGREDOS = new URL('../.segredos/', import.meta.url).pathname;
const ESPERA = 60_000;

function processos() {
  const arquivo = `${SEGREDOS}cadastro.json`;
  if (!existsSync(arquivo)) throw new Error('Faça o cadastro antes: node lab/cadastro/cadastrar.mjs');
  return JSON.parse(readFileSync(arquivo, 'utf8'));
}

async function admin() {
  const senha = readFileSync(`${SEGREDOS}admin.env`, 'utf8').trim().split('=')[1];
  const api = new Api({ base: BASE, origem: ORIGEM });
  await api.entrar('lab-admin', senha);
  return api;
}

class Pedido {
  constructor(contexto, id) {
    this.contexto = contexto;
    this.id = id;
  }

  ver(id = this.id) {
    return this.contexto.admin.get(`/api/instances/${id}`);
  }

  /** O pedido e os filhos em andamento, do pai para o filho. */
  async cadeia(id = this.id) {
    const instancia = await this.ver(id);
    const filhos = instancia.children.filter(({ status }) => status !== 'completed' && status !== 'cancelled');
    const abaixo = await Promise.all(filhos.map((filho) => this.cadeia(filho.id)));
    return [instancia, ...abaixo.flat()];
  }

  /** Espera uma etapa abrir, em qualquer nível. Um pedido que falhou mostra o incidente. */
  async esperar(nodeId) {
    const limite = Date.now() + ESPERA;
    let ultima;
    while (Date.now() < limite) {
      const cadeia = await this.cadeia();
      for (const instancia of cadeia) {
        const tarefa = instancia.openTasks.find((aberta) => aberta.nodeId === nodeId);
        if (tarefa) return tarefa;
        const incidente = instancia.incidents.find(({ resolvedAt }) => !resolvedAt);
        if (incidente) throw new Error(`${instancia.definitionName} parou em ${incidente.nodeId}: ${incidente.code} ${incidente.message}`);
      }
      const raiz = cadeia[0];
      ultima = `${raiz.status} em ${cadeia.at(-1).currentNodeId}`;
      if (raiz.status !== 'running') throw new Error(`esperava ${nodeId}, e o pedido terminou: ${ultima}`);
      await new Promise((resolver) => { setTimeout(resolver, 200); });
    }
    throw new Error(`${nodeId} não abriu em ${ESPERA / 1000} s; está ${ultima}`);
  }

  /** Espera o fim e confere o nó em que o pedido terminou. */
  async terminar(fim) {
    const limite = Date.now() + ESPERA;
    while (Date.now() < limite) {
      const instancia = await this.ver();
      const incidente = instancia.incidents.find(({ resolvedAt }) => !resolvedAt);
      if (incidente) throw new Error(`parou em ${incidente.nodeId}: ${incidente.code} ${incidente.message}`);
      if (instancia.status === 'completed') {
        assert.equal(instancia.currentNodeId, fim);
        return instancia;
      }
      await new Promise((resolver) => { setTimeout(resolver, 200); });
    }
    const cadeia = await this.cadeia();
    const abertas = cadeia.flatMap(({ definitionName, openTasks }) => openTasks.map(({ nodeId }) => `${definitionName}: ${nodeId}`));
    throw new Error(`não terminou: ${cadeia[0].status} em ${cadeia[0].currentNodeId}, com as tarefas abertas ${abertas.join(', ') || 'nenhuma'}`);
  }

  async completar(persona, nodeId, data = {}) {
    const tarefa = await this.esperar(nodeId);
    await persona.comando(`/api/tasks/${tarefa.id}/complete`, { data }, randomUUID());
  }

  async decidir(persona, nodeId, outcome) {
    const tarefa = await this.esperar(nodeId);
    await persona.comando(`/api/tasks/${tarefa.id}/decide`, { outcome }, randomUUID());
  }
}

function criarContexto(apiAdmin) {
  const definicoes = processos();
  const bots = lerBots();
  const pessoas = new Map();
  const persona = (nome) => {
    if (!pessoas.has(nome)) pessoas.set(nome, new Api({ base: BASE, token: bots[nome].token }));
    return pessoas.get(nome);
  };
  const contexto = {
    admin: apiAdmin,
    marina: persona('persona-marina'),
    rafael: persona('persona-rafael'),
    beatriz: persona('persona-beatriz'),
    caio: persona('persona-caio'),
    livia: persona('persona-livia'),
    otavio: persona('persona-otavio'),
    priscila: persona('persona-priscila'),
    tomas: persona('persona-tomas'),
    vera: persona('persona-vera'),
    sofia: persona('persona-sofia'),
    davi: persona('persona-davi'),
    gustavo: persona('persona-gustavo'),
    antonio: persona('persona-antonio'),
    core: persona('bot-core-bancario'),
    async abrir(quem, processo, data) {
      const { id } = await quem.comando('/api/instances', { definitionId: definicoes[processo], data }, randomUUID());
      return new Pedido(contexto, id);
    },
    async arquivo(quem) {
      const { id } = await quem.enviarArquivo('documento.pdf', 'application/pdf', '%PDF-1.4\n%laboratorio\n', randomUUID());
      return [{ fileId: id }];
    },
  };
  return contexto;
}

async function cadastroDoCliente(c, documento, nome) {
  return {
    tipoPessoa: 'pf',
    documentoCliente: documento,
    nomeCliente: nome,
    dadosPf: { dataNascimento: '1990-05-20', estadoCivil: 'solteiro', profissao: 'Arquiteta' },
    rendaMensal: 6500,
    endereco: { cep: '01001000', logradouro: 'Rua das Flores', numero: '10', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' },
    email: 'nina@exemplo.test',
    telefone: '11999990000',
    tipoConta: 'corrente',
    documentoIdentidade: await c.arquivo(c.marina),
    comprovanteEndereco: await c.arquivo(c.marina),
  };
}

async function empresa(c, documento, nome) {
  const { dadosPf, ...base } = await cadastroDoCliente(c, documento, nome);
  return {
    ...base,
    tipoPessoa: 'pj',
    dadosPj: {
      dataConstituicao: '2015-03-10',
      atividadePrincipal: 'Comércio',
      socios: [{ nome: 'Dono Único', cpf: cpf('000000303'), participacao: 100 }],
    },
    contratoSocial: await c.arquivo(c.marina),
  };
}

const atualizacao = async (c) => ({
  rendaMensal: 6800,
  endereco: { cep: '03003000', logradouro: 'Rua Azul', numero: '30', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' },
  email: 'karina@exemplo.test',
  telefone: '11977770000',
  comprovanteEndereco: await c.arquivo(c.rafael),
  comprovanteRenda: await c.arquivo(c.rafael),
});

const proposta = async (c, base, produto, valor, prazo, extras = {}) => ({
  documentoCliente: cpf(base),
  produto,
  valorSolicitado: valor,
  prazoMeses: prazo,
  finalidade: 'Reforma',
  comprovanteRenda: await c.arquivo(c.marina),
  ...extras,
});

const ACEITA = { resultadoNegociacao: 'aceita' };

/** Da assinatura à liberação de CRE-01. */
async function formalizar(c, pedido) {
  await pedido.completar(c.marina, 'colher_assinatura');
  await pedido.completar(c.tomas, 'conferir_formalizacao', { formalizacaoConforme: 'sim' });
}

export const CAMINHOS = {
  async 'CAD-01: aprovado até a conta aberta'(c, mock) {
    const documento = cpf('000000201');
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, documento, 'Nina Souza'));
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    const fim = await pedido.terminar('fim_conta_aberta');
    assert.ok(fim.data.numeroConta);
    assert.equal(await mock.cliente(documento), 'Nina Souza');
  },
  async 'CAD-01: documento irregular volta para a agência, que corrige'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000102'), 'Olga Pires'));
    const dados = await cadastroDoCliente(c, cpf('000000202'), 'Olga Pires');
    await pedido.completar(c.marina, 'ajustar_cadastro', dados);
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    await pedido.terminar('fim_conta_aberta');
  },
  async 'CAD-01: o Cadastro devolve, e a agência ajusta'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000203'), 'Paula Reis'));
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'ajustar', pendencias: ['endereco_divergente'], observacaoCadastro: 'CEP não confere' });
    await pedido.completar(c.marina, 'ajustar_cadastro', await cadastroDoCliente(c, cpf('000000203'), 'Paula Reis'));
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    await pedido.terminar('fim_conta_aberta');
  },
  async 'CAD-01: bloqueio nas listas recusa sem análise'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000104'), 'Quirino Sá'));
    await pedido.terminar('fim_recusado');
  },
  async 'CAD-01: alerta de PLD passa pela Supervisão'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000103'), 'Rita Paz'));
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    await pedido.decidir(c.livia, 'aprovar_pld', true);
    await pedido.terminar('fim_conta_aberta');
  },
  async 'CAD-01: quem já é cliente não abre outro cadastro'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000001'), 'Ana Clara Moreira'));
    await pedido.terminar('fim_ja_cliente');
  },
  async 'CAD-03: encerra com devolução de saldo'(c, mock) {
    const pedido = await c.abrir(c.marina, 'CAD-03', {
      documentoCliente: cpf('000000008'), motivoEncerramento: 'pedido_cliente', contaDestino: '999-1', termoEncerramento: await c.arquivo(c.marina),
    });
    await pedido.decidir(c.caio, 'conferir_encerramento', true);
    await pedido.terminar('fim_encerrada');
    assert.ok((await mock.estado()).pagamentos.some(({ valor }) => valor === 1500));
  },
  async 'CAD-03: pendência segura o encerramento'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-03', {
      documentoCliente: cpf('000000007'), motivoEncerramento: 'pedido_cliente', contaDestino: '999-2', termoEncerramento: await c.arquivo(c.marina),
    });
    await pedido.completar(c.marina, 'resolver_pendencias', { acaoPendencias: 'cliente_desistiu' });
    await pedido.terminar('fim_desistencia');
  },
  async 'CRE-01: aprovação automática até o crédito liberado'(c, mock) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000001', 'pessoal', 15000, 24));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 15000, prazoMeses: 24, ...ACEITA });
    await pedido.decidir(c.marina, 'aceitar_aprovacao', true);
    await formalizar(c, pedido);
    const fim = await pedido.terminar('fim_liberado');
    assert.equal(fim.data.decisaoCredito, 'aprovado');
    assert.equal(fim.data.valorLiberado, 15000);
    assert.ok((await mock.estado()).lancamentos.some(({ eventoContabil, documentoReferencia }) => eventoContabil === 'liberacao_credito' && documentoReferencia === fim.data.numeroContrato));
  },
  async 'CRE-01: recusa automática por score'(c, mock) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000003', 'pessoal', 5000, 12));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 5000, prazoMeses: 12, ...ACEITA });
    const fim = await pedido.terminar('fim_recusada');
    assert.equal(fim.data.decisaoCredito, 'recusado');
    assert.ok((await mock.estado()).mensagens.some(({ modelo }) => modelo === 'credito_recusado'));
  },
  async 'CRE-01: recusa automática por atraso'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000004', 'pessoal', 5000, 12));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 5000, prazoMeses: 12, ...ACEITA });
    await pedido.terminar('fim_recusada');
  },
  async 'CRE-01: analista, gerência, prestamista e veículo'(c, mock) {
    const garantia = { descricaoVeiculo: 'Utilitário', placa: 'ABC1D23', valorVeiculo: 90000 };
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000002', 'veiculo', 80000, 48, { garantia }));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 80000, prazoMeses: 48, seguroPrestamista: true, ...ACEITA });
    await pedido.completar(c.otavio, 'analisar_credito', {
      ratingInterno: 'B', parecerAnalista: 'aprovar', valorAprovado: 80000, prazoAprovado: 48, taxaAprovada: 2.2, justificativaAnalista: 'Bom histórico',
    });
    await pedido.decidir(c.priscila, 'aprovar_gerencia', true);
    await pedido.decidir(c.marina, 'aceitar_aprovacao', true);
    await pedido.decidir(c.marina, 'aceitar_cotacao', true);
    await formalizar(c, pedido);
    const fim = await pedido.terminar('fim_liberado');
    assert.ok(fim.data.numeroGravame);
    assert.ok(fim.data.numeroApolice, 'o prestamista volta para a proposta');
    assert.ok((await mock.estado()).gravames.some(({ referencia }) => referencia === fim.data.numeroContrato));
  },
  async 'CRE-01: o analista pede informações, e o comitê decide acima da alçada'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000012', 'capital_giro', 300000, 36));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 300000, prazoMeses: 36, ...ACEITA });
    await pedido.completar(c.otavio, 'analisar_credito', {
      ratingInterno: 'C', parecerAnalista: 'solicitar_informacoes', informacoesSolicitadas: 'Balanço do último ano', justificativaAnalista: 'Falta balanço',
    });
    await pedido.completar(c.rafael, 'complementar_informacoes', { respostaAgencia: 'Enviado' });
    await pedido.completar(c.otavio, 'analisar_credito', {
      ratingInterno: 'C', parecerAnalista: 'aprovar', valorAprovado: 300000, prazoAprovado: 36, taxaAprovada: 2.2, justificativaAnalista: 'Balanço bom',
    });
    await pedido.completar(c.antonio, 'deliberar_comite', { decisaoComite: 'recusado', ataComite: 'Exposição alta' });
    const fim = await pedido.terminar('fim_recusada');
    assert.equal(fim.data.decisaoCredito, 'recusado');
  },
  async 'CRE-01: cadastro vencido passa por CAD-02 antes de seguir'(c, mock) {
    const documento = cpf('000000005');
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000005', 'pessoal', 8000, 12));
    await pedido.completar(c.rafael, 'atualizar_dados', {
      rendaMensal: 7500,
      endereco: { cep: '02002000', logradouro: 'Rua Nova', numero: '20', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' },
      email: 'eduarda@exemplo.test',
      telefone: '11988880000',
      comprovanteEndereco: await c.arquivo(c.rafael),
      comprovanteRenda: await c.arquivo(c.rafael),
    });
    await pedido.completar(c.caio, 'conferir_atualizacao', { parecerAtualizacao: 'aprovado' });
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 8000, prazoMeses: 12, resultadoNegociacao: 'desiste' });
    await pedido.terminar('fim_desistencia');
    assert.ok((await mock.validade(documento)) > '2027-01-01', 'o Core recebeu a nova validade');
  },
  async 'CRE-01: cliente bloqueado não contrata'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000006', 'pessoal', 5000, 12));
    await pedido.terminar('fim_sem_conta');
  },
  async 'CRE-01: a assinatura demora, e a tarefa volta'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000010', 'pessoal', 10000, 12));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 10000, prazoMeses: 12, ...ACEITA });
    await pedido.decidir(c.marina, 'aceitar_aprovacao', true);
    await pedido.completar(c.marina, 'colher_assinatura');
    await formalizar(c, pedido);
    await pedido.terminar('fim_liberado');
  },
  async 'CRE-03: o Core abre a cobrança, e o cliente aceita o acordo'(c, mock) {
    const pedido = await c.abrir(c.core, 'CRE-03', { numeroContrato: 'CT-1001', origem: 'atraso' });
    await pedido.completar(c.vera, 'elaborar_proposta', { descontoPercentual: 25, valorEntrada: 500, quantidadeParcelas: 12 });
    await pedido.decidir(c.priscila, 'aprovar_desconto', true);
    await pedido.completar(c.rafael, 'negociar_cliente', { respostaCliente: 'aceita' });
    const fim = await pedido.terminar('fim_acordo');
    assert.equal(fim.data.valorAcordo, 9000);
    assert.ok(fim.data.numeroAcordo && fim.data.linhaDigitavel);
    assert.ok((await mock.estado()).lancamentos.some(({ eventoContabil }) => eventoContabil === 'renegociacao'));
  },
  async 'CRE-03: atraso longo vai para a cobrança judicial'(c) {
    const pedido = await c.abrir(c.core, 'CRE-03', { numeroContrato: 'CT-1002', origem: 'atraso' });
    await pedido.decidir(c.priscila, 'avaliar_judicial', true);
    await pedido.terminar('fim_judicial');
  },
  async 'CRE-03: contrato em dia não abre cobrança'(c) {
    const pedido = await c.abrir(c.core, 'CRE-03', { numeroContrato: 'CT-1003', origem: 'atraso' });
    await pedido.terminar('fim_sem_atraso');
  },
  async 'CTB-01: lançamento alto passa pelo analista e pela Controladoria'(c, mock) {
    const pedido = await c.abrir(c.davi, 'CTB-01', {
      eventoContabil: 'ajuste_manual', valor: 2000000, dataCompetencia: '2026-11-06', documentoReferencia: 'AJ-1', historico: 'Ajuste de abertura',
    });
    await pedido.completar(c.davi, 'conferir_lancamento', { contaDebito: '1.1.1', contaCredito: '2.1.1' });
    await pedido.decidir(c.gustavo, 'aprovar_lancamento', true);
    await pedido.terminar('fim_lancado');
    assert.ok((await mock.estado()).lancamentos.some(({ documentoReferencia }) => documentoReferencia === 'AJ-1'));
  },
  async 'CAD-01: o Cadastro recusa'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000204'), 'Sara Dutra'));
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'recusado', observacaoCadastro: 'Suspeita de fraude' });
    await pedido.terminar('fim_recusado');
  },
  async 'CAD-01: a Supervisão recusa uma pessoa politicamente exposta'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000105'), 'Túlio Assis'));
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    await pedido.decidir(c.livia, 'aprovar_pld', false);
    await pedido.terminar('fim_recusado');
  },
  async 'CAD-01: a gerência aceita uma empresa'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await empresa(c, cnpj('900000020001'), 'Padaria Sol Ltda'));
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    await pedido.decidir(c.beatriz, 'aprovar_empresa', true);
    await pedido.terminar('fim_conta_aberta');
  },
  async 'CAD-01: a gerência recusa uma empresa'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await empresa(c, cnpj('900000030001'), 'Bar da Esquina Ltda'));
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    await pedido.decidir(c.beatriz, 'aprovar_empresa', false);
    await pedido.terminar('fim_recusado');
  },
  async 'CAD-02: documento sem cadastro'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-02', { documentoCliente: cpf('000000301'), origem: 'agencia' });
    await pedido.terminar('fim_nao_encontrado');
  },
  async 'CAD-02: o Core abre, o Cadastro devolve, e a Supervisão mantém o cliente'(c) {
    const pedido = await c.abrir(c.core, 'CAD-02', { documentoCliente: cpf('000000011'), origem: 'vencimento' });
    await pedido.completar(c.rafael, 'atualizar_dados', await atualizacao(c));
    await pedido.completar(c.caio, 'conferir_atualizacao', { parecerAtualizacao: 'ajustar', pendencias: ['renda_nao_comprovada'], observacaoCadastro: 'Falta holerite' });
    await pedido.completar(c.rafael, 'atualizar_dados', await atualizacao(c));
    await pedido.completar(c.caio, 'conferir_atualizacao', { parecerAtualizacao: 'aprovado' });
    await pedido.decidir(c.livia, 'avaliar_pld', true);
    await pedido.terminar('fim_atualizado');
  },
  async 'CAD-02: a Supervisão bloqueia o cliente'(c, mock) {
    const pedido = await c.abrir(c.marina, 'CAD-02', { documentoCliente: cpf('000000011'), origem: 'agencia' });
    await pedido.completar(c.rafael, 'atualizar_dados', await atualizacao(c));
    await pedido.completar(c.caio, 'conferir_atualizacao', { parecerAtualizacao: 'aprovado' });
    await pedido.decidir(c.livia, 'avaliar_pld', false);
    await pedido.terminar('fim_bloqueado');
    assert.equal(await mock.situacao(cpf('000000011')), 'bloqueado');
  },
  async 'CAD-03: documento sem cadastro'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-03', {
      documentoCliente: cpf('000000301'), motivoEncerramento: 'outro', contaDestino: '999-3', termoEncerramento: await c.arquivo(c.marina),
    });
    await pedido.terminar('fim_nao_encontrado');
  },
  async 'CAD-03: a pendência continua depois da nova consulta'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-03', {
      documentoCliente: cpf('000000007'), motivoEncerramento: 'mudanca_banco', contaDestino: '999-4', termoEncerramento: await c.arquivo(c.marina),
    });
    await pedido.completar(c.marina, 'resolver_pendencias', { acaoPendencias: 'resolvidas' });
    await pedido.completar(c.marina, 'resolver_pendencias', { acaoPendencias: 'cliente_desistiu' });
    await pedido.terminar('fim_desistencia');
  },
  async 'CAD-03: a documentação volta, e a conta sem saldo encerra'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-03', {
      documentoCliente: cpf('000000009'), motivoEncerramento: 'insatisfacao', contaDestino: '999-5', termoEncerramento: await c.arquivo(c.marina),
    });
    await pedido.decidir(c.caio, 'conferir_encerramento', false);
    await pedido.completar(c.marina, 'resolver_pendencias', { acaoPendencias: 'resolvidas', termoEncerramento: await c.arquivo(c.marina) });
    await pedido.decidir(c.caio, 'conferir_encerramento', true);
    await pedido.terminar('fim_encerrada');
  },
  async 'CRE-01: refaz a simulação, e o cliente desiste'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000002', 'pessoal', 30000, 24));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 20000, prazoMeses: 36, resultadoNegociacao: 'ajustar' });
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 20000, prazoMeses: 36, resultadoNegociacao: 'desiste' });
    await pedido.terminar('fim_desistencia');
  },
  async 'CRE-01: aprovado na alçada do analista, e o cliente não aceita'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000002', 'pessoal', 30000, 24));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 30000, prazoMeses: 24, ...ACEITA });
    await pedido.completar(c.otavio, 'analisar_credito', {
      ratingInterno: 'B', parecerAnalista: 'aprovar', valorAprovado: 25000, prazoAprovado: 24, taxaAprovada: 2.2, justificativaAnalista: 'Reduzi o valor',
    });
    await pedido.decidir(c.marina, 'aceitar_aprovacao', false);
    const fim = await pedido.terminar('fim_desistencia');
    assert.equal(fim.data.valorAprovado, 25000);
  },
  async 'CRE-01: o analista recusa'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000002', 'pessoal', 30000, 24));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 30000, prazoMeses: 24, ...ACEITA });
    await pedido.completar(c.otavio, 'analisar_credito', { ratingInterno: 'D', parecerAnalista: 'recusar', justificativaAnalista: 'Comprometimento alto' });
    await pedido.terminar('fim_recusada');
  },
  async 'CRE-01: a gerência recusa'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000002', 'pessoal', 100000, 48));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 100000, prazoMeses: 48, ...ACEITA });
    await pedido.completar(c.otavio, 'analisar_credito', {
      ratingInterno: 'C', parecerAnalista: 'aprovar', valorAprovado: 100000, prazoAprovado: 48, taxaAprovada: 2.2, justificativaAnalista: 'Na alçada da gerência',
    });
    await pedido.decidir(c.priscila, 'aprovar_gerencia', false);
    await pedido.terminar('fim_recusada');
  },
  async 'CRE-01: o comitê aprova, e a formalização volta uma vez'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000012', 'capital_giro', 300000, 36));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 300000, prazoMeses: 36, ...ACEITA });
    await pedido.completar(c.otavio, 'analisar_credito', {
      ratingInterno: 'B', parecerAnalista: 'aprovar', valorAprovado: 300000, prazoAprovado: 36, taxaAprovada: 2.2, justificativaAnalista: 'Empresa sólida',
    });
    await pedido.completar(c.antonio, 'deliberar_comite', { decisaoComite: 'aprovado', valorAprovado: 280000, prazoAprovado: 36, taxaAprovada: 2, ataComite: 'Aprovado com redução' });
    await pedido.decidir(c.marina, 'aceitar_aprovacao', true);
    await pedido.completar(c.marina, 'colher_assinatura');
    await pedido.completar(c.tomas, 'conferir_formalizacao', { formalizacaoConforme: 'nao', pendenciasFormalizacao: 'Falta a rubrica' });
    await formalizar(c, pedido);
    await pedido.completar(c.davi, 'conferir_lancamento', { contaDebito: '1.6.1', contaCredito: '1.1.1' });
    const fim = await pedido.terminar('fim_liberado');
    assert.equal(fim.data.valorLiberado, 280000, 'vale o valor do comitê');
  },
  async 'CRE-01: a aprovação vence antes da assinatura'(c, mock) {
    const pedido = await c.abrir(c.marina, 'CRE-01', await proposta(c, '000000014', 'pessoal', 15000, 24));
    await pedido.completar(c.marina, 'negociar_condicoes', { valorSolicitado: 15000, prazoMeses: 24, ...ACEITA });
    await pedido.decidir(c.marina, 'aceitar_aprovacao', true);
    await pedido.completar(c.marina, 'colher_assinatura');
    await pedido.terminar('fim_expirada');
    assert.ok((await mock.estado()).mensagens.some(({ modelo }) => modelo === 'aprovacao_expirada'));
  },
  async 'CRE-03: desconto negado, contraproposta e recusa'(c) {
    const pedido = await c.abrir(c.marina, 'CRE-03', { numeroContrato: 'CT-1001', origem: 'cliente' });
    await pedido.completar(c.vera, 'elaborar_proposta', { descontoPercentual: 30, valorEntrada: 500, quantidadeParcelas: 12 });
    await pedido.decidir(c.priscila, 'aprovar_desconto', false);
    await pedido.completar(c.vera, 'elaborar_proposta', { descontoPercentual: 10, valorEntrada: 500, quantidadeParcelas: 12 });
    await pedido.completar(c.rafael, 'negociar_cliente', { respostaCliente: 'contraproposta', contraproposta: 'Entrada menor' });
    await pedido.completar(c.vera, 'elaborar_proposta', { descontoPercentual: 10, valorEntrada: 200, quantidadeParcelas: 18 });
    await pedido.completar(c.rafael, 'negociar_cliente', { respostaCliente: 'recusa' });
    await pedido.terminar('fim_sem_acordo');
  },
  async 'CRE-03: a gerência não envia para a cobrança judicial'(c) {
    const pedido = await c.abrir(c.core, 'CRE-03', { numeroContrato: 'CT-1002', origem: 'atraso' });
    await pedido.decidir(c.priscila, 'avaliar_judicial', false);
    await pedido.completar(c.vera, 'elaborar_proposta', { descontoPercentual: 15, valorEntrada: 1000, quantidadeParcelas: 24 });
    await pedido.completar(c.rafael, 'negociar_cliente', { respostaCliente: 'recusa' });
    await pedido.terminar('fim_sem_acordo');
  },
  async 'CTB-01: valor médio só passa pelo analista'(c) {
    const pedido = await c.abrir(c.davi, 'CTB-01', {
      eventoContabil: 'liberacao_credito', valor: 150000, dataCompetencia: '2026-11-06', documentoReferencia: 'AJ-2', historico: 'Conferência',
    });
    await pedido.completar(c.davi, 'conferir_lancamento', { contaDebito: '1.6.1', contaCredito: '1.1.1' });
    await pedido.terminar('fim_lancado');
  },
  async 'CTB-01: a Controladoria devolve para o analista'(c) {
    const pedido = await c.abrir(c.davi, 'CTB-01', {
      eventoContabil: 'liberacao_credito', valor: 3000000, dataCompetencia: '2026-11-06', documentoReferencia: 'AJ-3', historico: 'Valor alto',
    });
    await pedido.completar(c.davi, 'conferir_lancamento', { contaDebito: '1.6.1', contaCredito: '1.1.1' });
    await pedido.decidir(c.gustavo, 'aprovar_lancamento', false);
    await pedido.completar(c.davi, 'conferir_lancamento', { contaDebito: '1.6.2', contaCredito: '1.1.1' });
    await pedido.decidir(c.gustavo, 'aprovar_lancamento', true);
    await pedido.terminar('fim_lancado');
  },
  async 'SEG-01: cliente bloqueado não contrata'(c) {
    const pedido = await c.abrir(c.marina, 'SEG-01', { documentoCliente: cpf('000000006'), tipoSeguro: 'auto', capitalSegurado: 50000, bemSegurado: { descricao: 'Carro', valor: 50000 } });
    await pedido.terminar('fim_sem_conta');
  },
  async 'SEG-01: o cliente recusa a cotação'(c) {
    const pedido = await c.abrir(c.marina, 'SEG-01', { documentoCliente: cpf('000000001'), tipoSeguro: 'auto', capitalSegurado: 50000, bemSegurado: { descricao: 'Carro', valor: 50000 } });
    await pedido.decidir(c.marina, 'aceitar_cotacao', false);
    await pedido.terminar('fim_desistencia');
  },
  async 'SEG-01: o risco é recusado'(c, mock) {
    const pedido = await c.abrir(c.marina, 'SEG-01', {
      documentoCliente: cpf('000000002'), tipoSeguro: 'vida', capitalSegurado: 400000, beneficiarios: [{ nome: 'Clara Teixeira', cpf: cpf('000000302'), percentual: 100 }], declaracaoSaude: 'Hipertensão',
    });
    await pedido.decidir(c.marina, 'aceitar_cotacao', true);
    await pedido.completar(c.sofia, 'analisar_risco', { parecerRisco: 'recusar', justificativaRisco: 'Risco alto' });
    await pedido.terminar('fim_recusado');
    assert.ok((await mock.estado()).mensagens.some(({ modelo }) => modelo === 'seguro_recusado'));
  },
  async 'Segurança: a renda fica escondida de quem não pode vê-la'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000205'), 'Ulla Paiva'));
    const tarefa = await pedido.esperar('analisar_cadastro');

    const solicitante = await c.marina.get(`/api/instances/${pedido.id}`);
    assert.equal(solicitante.data.rendaMensal, undefined, 'quem abriu não vê, embora tenha digitado (sensitive-data.md §4)');
    assert.ok(solicitante.maskedKeys.includes('rendaMensal'));

    const noFormulario = await c.caio.get(`/api/tasks/${tarefa.id}`);
    assert.equal(noFormulario.prefill.rendaMensal, 6500, 'quem analisa vê no formulário da tarefa');

    const comPermissao = await c.livia.get(`/api/instances/${pedido.id}`);
    assert.equal(comPermissao.data.rendaMensal, 6500, 'Cadastro - Supervisão tem viewSensitive');

    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    await pedido.terminar('fim_conta_aberta');
  },
  async 'Segurança: quem é de outro setor não vê o pedido nem age nele'(c) {
    const pedido = await c.abrir(c.marina, 'CAD-01', await cadastroDoCliente(c, cpf('000000206'), 'Vitor Leal'));
    const tarefa = await pedido.esperar('analisar_cadastro');
    await assert.rejects(c.vera.get(`/api/instances/${pedido.id}`), ({ status }) => status === 404);
    await assert.rejects(c.vera.comando(`/api/tasks/${tarefa.id}/complete`, { data: { parecerCadastro: 'aprovado' } }, randomUUID()), ({ status }) => status === 403 || status === 404);
    await assert.rejects(c.marina.comando(`/api/tasks/${tarefa.id}/complete`, { data: { parecerCadastro: 'aprovado' } }, randomUUID()), ({ status }) => status === 403 || status === 404, 'quem abriu não aprova o próprio cadastro');
    await pedido.completar(c.caio, 'analisar_cadastro', { parecerCadastro: 'aprovado' });
    await pedido.terminar('fim_conta_aberta');
  },
  async 'Segurança: uma persona sem permissão não abre o processo'(c) {
    const definicoes = processos();
    await assert.rejects(c.caio.comando('/api/instances', { definitionId: definicoes['CRE-01'], data: {} }, randomUUID()), ({ status }) => status === 403);
    await assert.rejects(c.core.comando('/api/instances', { definitionId: definicoes['CTB-01'], data: {} }, randomUUID()), ({ status }) => status === 403);
  },
  async 'SEG-01: seguro de vida com subscrição e exames'(c) {
    const pedido = await c.abrir(c.marina, 'SEG-01', {
      documentoCliente: cpf('000000001'),
      tipoSeguro: 'vida',
      capitalSegurado: 150000,
      beneficiarios: [{ nome: 'Beto Moreira', cpf: cpf('000000301'), percentual: 100 }],
      declaracaoSaude: 'Sem restrições',
    });
    await pedido.decidir(c.marina, 'aceitar_cotacao', true);
    await pedido.completar(c.sofia, 'analisar_risco', { parecerRisco: 'exigir_exames', examesExigidos: 'Check-up', justificativaRisco: 'Capital alto' });
    await pedido.completar(c.marina, 'anexar_exames', { examesAnexos: await c.arquivo(c.marina) });
    await pedido.completar(c.sofia, 'analisar_risco', { parecerRisco: 'aceitar', justificativaRisco: 'Exames em ordem' });
    const fim = await pedido.terminar('fim_emitida');
    assert.ok(fim.data.numeroApolice);
  },
};

/** O mock só é visto pela rede do compose, então a verificação o consulta de dentro dela. */
function olharMock(executar) {
  return {
    estado: () => executar('/__mock/estado'),
    async cliente(documento) {
      return (await executar(`/core/v1/clientes/${documento}`)).nomeCliente;
    },
    async validade(documento) {
      return (await executar(`/core/v1/clientes/${documento}`)).dataValidadeCadastro;
    },
    async situacao(documento) {
      return (await executar(`/core/v1/clientes/${documento}`)).situacaoCliente;
    },
  };
}

async function todasAsInstancias(api) {
  const vistas = new Map();
  const ver = async (id) => {
    if (vistas.has(id)) return;
    const instancia = await api.get(`/api/instances/${id}`);
    vistas.set(id, instancia);
    for (const filho of instancia.children) await ver(filho.id);
  };
  for (const { id } of await api.get('/api/instances?scope=visible')) await ver(id);
  return [...vistas.values()];
}

/** O que as instâncias da stack percorreram, pelas linhas do tempo do próprio Chain. */
async function cobertura(api) {
  const nos = new Map(ONDA_1.map((id) => [id, new Set()]));
  const ramos = new Map(ONDA_1.map((id) => [id, new Set()]));
  for (const instancia of await todasAsInstancias(api)) {
    const id = instancia.definitionName.split(' ')[0];
    if (!nos.has(id)) continue;
    nos.get(id).add(instancia.currentNodeId);
    const tarefas = new Map();
    for (const { type, taskId, details } of instancia.timeline) {
      if (details?.nodeId) nos.get(id).add(details.nodeId);
      if (type === 'task.created') tarefas.set(taskId, details.nodeId);
      const decisao = details?.nodeId ?? tarefas.get(taskId);
      if (type === 'gateway.decided' || type === 'gateway.evaluated') ramos.get(id).add(`${decisao}:${details.outcome}`);
    }
  }

  const processos_ = lerProcessos();
  const faltam = [];
  let totalDeNos = 0;
  let totalDeRamos = 0;
  for (const id of ONDA_1) {
    for (const no of processos_.get(id).nos.values()) {
      if (no.tipo === 'Início') continue;
      totalDeNos += 1;
      if (!nos.get(id).has(no.id)) faltam.push(`${id} ${no.id}`);
      if (!no.tipo.startsWith('Decisão')) continue;
      for (const ramo of ['true', 'false']) {
        totalDeRamos += 1;
        if (!ramos.get(id).has(`${no.id}:${ramo}`)) faltam.push(`${id} ${no.id}:${ramo}`);
      }
    }
  }
  return { totalDeNos, totalDeRamos, faltam };
}

async function main() {
  const { execFileSync } = await import('node:child_process');
  const chave = readFileSync(`${SEGREDOS}stack.env`, 'utf8').match(/CHAIN_LAB_MOCK_KEY=(.+)/)[1];
  const script = 'fetch("http://localhost:8080"+process.argv[1],{method:process.argv[2],headers:{"X-Api-Key":process.env.K}}).then(r=>r.text()).then(t=>process.stdout.write(t))';
  const noMock = (metodo, caminho) => JSON.parse(execFileSync('docker', ['compose', '-p', 'chain-lab', 'exec', '-T', '-e', `K=${chave}`, 'mock', 'node', '-e', script, caminho, metodo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const mock = olharMock(async (caminho) => noMock('GET', caminho));
  noMock('POST', '/__mock/reiniciar');

  const contexto = criarContexto(await admin());
  const filtro = process.argv[2];
  const nomes = Object.keys(CAMINHOS).filter((nome) => !filtro || nome.includes(filtro));
  let falhas = 0;
  for (const nome of nomes) {
    const inicio = Date.now();
    try {
      await CAMINHOS[nome](contexto, mock);
      console.log(`ok    ${nome} (${((Date.now() - inicio) / 1000).toFixed(1)} s)`);
    } catch (erro) {
      falhas += 1;
      console.log(`FALHA ${nome}\n      ${erro.message}`);
    }
  }
  console.log(`${nomes.length - falhas} de ${nomes.length} caminhos`);
  if (filtro) process.exit(falhas ? 1 : 0);

  const { totalDeNos, totalDeRamos, faltam } = await cobertura(contexto.admin);
  console.log(`${totalDeNos} nós e ${totalDeRamos} ramos na onda 1; ${faltam.length} sem passar: ${faltam.join(', ') || 'nenhum'}`);
  process.exit(falhas || faltam.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
