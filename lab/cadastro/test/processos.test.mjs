// cadastro.md §3.4, sobre os documentos reais da onda 1: é o critério 1 de cadastro.md §5.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lerAutomacoes, lerGrupos, lerPermissoes, lerProcessos, ONDA_1 } from '../documentos.mjs';
import { montarAutomacao, montarFormulario, montarProcesso } from '../modelos.mjs';

const LAB = new URL('../../../specs/experiments/laboratorio/', import.meta.url).pathname;
const processos = lerProcessos(LAB);
const referencias = {
  grupo: (nome) => `grupo:${nome}`,
  formulario: (id) => `form:${id}`,
  automacao: (id) => `auto:${id}`,
  processo: (id) => `proc:${id}`,
};

test('os oito processos da onda 1 são lidos, nesta ordem', () => {
  assert.deepEqual(ONDA_1, ['CTB-01', 'CAD-01', 'CAD-02', 'CAD-03', 'SEG-01', 'CRE-02', 'CRE-01', 'CRE-03']);
  for (const id of ONDA_1) assert.ok(processos.get(id), id);
});

test('CAD-01 vira um documento completo', () => {
  const documento = montarProcesso(processos.get('CAD-01'), referencias);
  assert.equal(documento.schemaVersion, 1);
  assert.deepEqual(documento.lanes.map(({ title }) => title), ['Solicitantes', 'Cadastro - Análise', 'Cadastro - Supervisão', 'Agência - Gerência']);
  assert.deepEqual(documento.lanes[0].group, { kind: 'requesters' });
  assert.deepEqual(documento.lanes[1].group, { kind: 'group', groupId: 'grupo:Cadastro - Análise' });

  const no = (id) => documento.nodes.find((node) => node.id === id);
  assert.equal(no('inicio').type, 'start');
  assert.deepEqual(no('inicio').form, { formId: 'form:F-CAD-01' });
  assert.equal(no('analisar_cadastro').taskKind, 'human');
  assert.deepEqual(no('analisar_cadastro').form, { formId: 'form:F-CAD-02' });
  assert.equal(no('fim_recusado').type, 'end');

  assert.equal(no('buscar_cliente').taskKind, 'automation');
  assert.equal(no('buscar_cliente').automation.automationId, 'auto:AUT-CORE-01');
  assert.deepEqual(no('buscar_cliente').automation.inputs, { documentoCliente: { kind: 'path', path: ['documentoCliente'] } });
  assert.deepEqual(no('buscar_cliente').automation.outputs, { clienteEncontrado: { kind: 'path', path: ['encontrado'] } });

  assert.equal(no('gw_ja_cliente').decisionMode, 'automatic');
  assert.equal(no('gw_ja_cliente').condition.operator, 'equals');
  assert.equal(no('aprovar_pld').decisionMode, 'human');
  assert.equal(no('aprovar_pld').question, 'Aceitar o cliente mesmo com o alerta de PLD ou a condição de PEP?');

  const fluxo = documento.flows.find(({ source, target }) => source === 'gw_ja_cliente' && target === 'fim_ja_cliente');
  assert.equal(fluxo.branch, 'true');
  assert.equal(documento.flows.find(({ source, target }) => source === 'inicio' && target === 'buscar_cliente').branch, undefined);
});

test('um mapeamento com valor fixo e data relativa', () => {
  const documento = montarProcesso(processos.get('CAD-01'), referencias);
  const { inputs } = documento.nodes.find(({ id }) => id === 'criar_conta').automation;
  assert.deepEqual(inputs.dataValidadeCadastro, { kind: 'system', name: 'currentDate', offset: { amount: 24, unit: 'months' } });
  const notificar = documento.nodes.find(({ id }) => id === 'notificar_recusa').automation.inputs;
  assert.deepEqual(notificar.modelo, { kind: 'literal', type: 'text', value: 'cadastro_recusado' });
  assert.deepEqual(notificar.destinatario, { kind: 'path', path: ['email'] });
});

test('um subprocesso aponta para o processo filho', () => {
  const documento = montarProcesso(processos.get('CRE-01'), referencias);
  const passo = documento.nodes.find(({ id }) => id === 'analisar_credito');
  assert.equal(passo.taskKind, 'subprocess');
  assert.equal(passo.workflow.workflowId, 'proc:CRE-02');
  assert.deepEqual(passo.workflow.inputs.origem, { kind: 'literal', type: 'text', value: 'agencia' });
  assert.deepEqual(passo.workflow.outputs.decisaoCredito, { kind: 'path', path: ['decisaoCredito'] });
  assert.deepEqual(documento.nodes.find(({ id }) => id === 'atualizar_cadastro').workflow.outputs, {});
});

test('uma etapa humana sem formulário não tem form', () => {
  const documento = montarProcesso(processos.get('CAD-03'), referencias);
  assert.equal(documento.nodes.find(({ id }) => id === 'conferir_encerramento').type, 'gateway');
});

test('o layout põe cada nó dentro da raia, sem sobreposição', () => {
  for (const id of ONDA_1) {
    const documento = montarProcesso(processos.get(id), referencias);
    const raias = new Map(documento.lanes.map((raia) => [raia.id, raia.layout]));
    for (const no of documento.nodes) {
      const raia = raias.get(no.laneId);
      assert.ok(raia, `${id}: ${no.id} sem raia`);
      assert.ok(no.layout.y >= raia.y && no.layout.y + no.layout.h <= raia.y + raia.h, `${id}: ${no.id} fora da faixa da raia`);
      assert.ok(no.layout.x >= raia.x && no.layout.x + no.layout.w <= raia.x + raia.w, `${id}: ${no.id} fora da largura da raia`);
    }
    const nos = documento.nodes.map(({ id: nome, layout }) => ({ nome, ...layout }));
    for (const [i, a] of nos.entries()) {
      for (const b of nos.slice(i + 1)) {
        const separados = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(separados, `${id}: ${a.nome} sobre ${b.nome}`);
      }
    }
    const faixas = documento.lanes.map(({ layout }) => layout).sort((a, b) => a.y - b.y);
    for (const [i, faixa] of faixas.slice(1).entries()) assert.ok(faixa.y >= faixas[i].y + faixas[i].h, `${id}: raias sobrepostas`);
  }
});

test('todo formulário da onda 1 é traduzido', () => {
  const formularios = new Map();
  for (const id of ONDA_1) for (const [nome, formulario] of processos.get(id).formularios) formularios.set(nome, formulario);
  const opcoesDe = (nome, chave) => montarFormulario(formularios.get(nome).campos, opcoesDe).components.find(({ key }) => key === chave).options;
  assert.equal(formularios.size, 23);
  for (const [nome, formulario] of formularios) {
    const documento = montarFormulario(formulario.campos, opcoesDe);
    assert.ok(documento.components.length > 0, nome);
  }
});

test('o padrão de CPF ou CNPJ perde o escape da tabela', () => {
  const { campos } = processos.get('CAD-01').formularios.get('F-CAD-01');
  const documento = montarFormulario(campos, () => []).components.find(({ key }) => key === 'documentoCliente');
  assert.equal(documento.validate.pattern, '^([0-9]{11}|[0-9]{14})$');
});

test('toda opção da onda 1 com acento ou sublinhado tem rótulo', () => {
  for (const id of ONDA_1) {
    for (const [nome, { campos }] of processos.get(id).formularios) {
      for (const campo of campos) {
        for (const [, valor, rotulo] of campo.regras.matchAll(/`([a-z_]+)`( [^,;]+)?/g)) {
          if (campo.regras.includes('opções:') && campo.regras.indexOf(`\`${valor}\``) > campo.regras.indexOf('opções:')) {
            assert.ok(rotulo, `${nome}.${campo.chave}: ${valor} sem rótulo`);
          }
        }
      }
    }
  }
});

test('as automações da onda 1 têm destino', () => {
  const { automacoes, destinos } = lerAutomacoes(LAB);
  assert.equal(destinos.size, 17);
  const usadas = new Set();
  for (const id of ONDA_1) for (const etapa of processos.get(id).etapas.values()) if (etapa.usa.startsWith('AUT-')) usadas.add(etapa.usa);
  assert.equal(usadas.size, 28);
  for (const id of usadas) {
    const automacao = automacoes.get(id);
    assert.ok(automacao, id);
    const destino = destinos.get(automacao.destino);
    assert.ok(destino, `${id}: ${automacao.destino}`);
    assert.ok(automacao.caminho.startsWith(`${destino.prefixo}/`));
    const documento = montarAutomacao(automacao, destino);
    assert.equal(documento.request.destination, destino.nome);
  }
});

test('os grupos vêm dos setores, com os membros', () => {
  const grupos = lerGrupos(LAB);
  assert.deepEqual(grupos.get('Agência - Atendimento'), ['Marina', 'Rafael']);
  assert.deepEqual(grupos.get('Crédito - Comitê'), ['Priscila', 'Antônio', 'Zélia']);
  assert.deepEqual(grupos.get('Integração - Core Bancário'), []);
});

test('as permissões vêm do mapa', () => {
  const permissoes = lerPermissoes(LAB);
  assert.deepEqual(permissoes.get('CAD-02').start, ['Agência - Atendimento', 'Integração - Core Bancário']);
  assert.deepEqual(permissoes.get('CAD-01').viewSensitive, ['Cadastro - Supervisão']);
  assert.deepEqual(permissoes.get('CRE-02').start, []);
  assert.deepEqual(permissoes.get('SEG-01').view, ['Seguros - Subscrição', 'Seguros - Gerência']);
});
