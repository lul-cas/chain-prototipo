// Critério 1 de mock.md §6: o mock é conferido contra os contratos, lidos direto das specs. Se uma automação mudar lá, o teste falha.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { criarMock } from '../app.mjs';
import { cpf } from '../massa.mjs';

const LAB = new URL('../../../specs/experiments/laboratorio/', import.meta.url).pathname;
const ONDA_1 = ['ctb-01', 'cad-01', 'cad-02', 'cad-03', 'seg-01', 'cre-02', 'cre-01', 'cre-03'];
const CHAVE = 'chave-de-teste';

function contratos() {
  const lista = new Map();
  for (const linha of readFileSync(join(LAB, 'sistemas-externos.md'), 'utf8').split('\n')) {
    if (!linha.startsWith('| `AUT-')) continue;
    const celulas = linha.split('|').map((c) => c.trim());
    const [metodo, caminho] = celulas[3].replaceAll('`', '').split(' ');
    const campos = (celula) => [...celula.matchAll(/`(\w+):([\w<>]+)(\*?)`/g)].map(([, chave, tipo, obrigatorio]) => ({ chave, tipo, obrigatorio: obrigatorio === '*' }));
    lista.set(celulas[1].replaceAll('`', ''), { metodo, caminho, entradas: campos(celulas[4]), saidas: campos(celulas[5]) });
  }
  return lista;
}

function automacoesDaOnda1() {
  const usadas = new Set();
  const pasta = join(LAB, 'processos');
  for (const arquivo of readdirSync(pasta).filter((nome) => ONDA_1.some((id) => nome.startsWith(id)))) {
    for (const [id] of readFileSync(join(pasta, arquivo), 'utf8').matchAll(/AUT-[A-Z]+-\d+/g)) usadas.add(id);
  }
  return [...usadas].sort();
}

const AMOSTRAS = {
  documentoCliente: cpf('000000002'),
  numeroContrato: 'CT-1001',
  idEnvelope: null,
  eventoContabil: 'liberacao_credito',
  tipoSeguro: 'vida',
  produto: 'pessoal',
  tipoPessoa: 'pf',
  tipoConta: 'corrente',
  decisao: 'aprovado',
};

function valorDe(campo) {
  if (campo.chave in AMOSTRAS && AMOSTRAS[campo.chave] !== null) return AMOSTRAS[campo.chave];
  switch (campo.tipo) {
    case 'number': return 1000;
    case 'boolean': return true;
    case 'date': return '2026-12-01';
    case 'object': return { cep: '01001000' };
    case 'list<text>': return ['core'];
    default: return 'texto';
  }
}

function tipoConfere(valor, tipo) {
  if (tipo === 'text') return typeof valor === 'string';
  if (tipo === 'number') return typeof valor === 'number';
  if (tipo === 'boolean') return typeof valor === 'boolean';
  if (tipo === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(valor);
  if (tipo === 'object') return typeof valor === 'object' && valor !== null;
  return true;
}

async function chamar(mock, contrato, valores, chave) {
  const corpo = {};
  let caminho = contrato.caminho;
  for (const campo of contrato.entradas) {
    const valor = valores[campo.chave] ?? valorDe(campo);
    if (caminho.includes(`{${campo.chave}}`)) caminho = caminho.replace(`{${campo.chave}}`, encodeURIComponent(valor));
    else corpo[campo.chave] = valor;
  }
  return mock.tratar({
    metodo: contrato.metodo,
    caminho,
    cabecalhos: { 'x-api-key': CHAVE, 'idempotency-key': chave },
    corpo: contrato.metodo === 'GET' ? undefined : JSON.stringify(corpo),
  });
}

const lista = contratos();

test('a onda 1 usa as 28 automações que mock.md §1 lista', () => {
  assert.equal(automacoesDaOnda1().length, 28);
});

for (const id of automacoesDaOnda1()) {
  test(`${id} responde o contrato`, async () => {
    const contrato = lista.get(id);
    assert.ok(contrato, `${id} não está em sistemas-externos.md`);
    const mock = criarMock({ chave: CHAVE, hoje: '2026-11-06' });
    const valores = {};
    if (id === 'AUT-ASS-02') {
      const envelope = await chamar(mock, lista.get('AUT-ASS-01'), {}, 'preparo');
      valores.idEnvelope = envelope.corpo.idEnvelope;
    }
    if (id === 'AUT-SEG-02') {
      const cotacao = await chamar(mock, lista.get('AUT-SEG-01'), {}, 'preparo');
      valores.idCotacao = cotacao.corpo.idCotacao;
    }
    if (id === 'AUT-CORE-09') {
      const gerado = await chamar(mock, lista.get('AUT-CORE-08'), {}, 'preparo');
      valores.numeroContrato = gerado.corpo.numeroContrato;
    }
    if (id === 'AUT-CORE-02') valores.documentoCliente = cpf('000000101');

    const resposta = await chamar(mock, contrato, valores, `teste-${id}`);

    assert.equal(resposta.status, 200, JSON.stringify(resposta.corpo));
    for (const saida of contrato.saidas) {
      const valor = resposta.corpo[saida.chave];
      if (saida.obrigatorio) assert.notEqual(valor, undefined, `falta ${saida.chave}`);
      if (valor !== undefined) assert.ok(tipoConfere(valor, saida.tipo), `${saida.chave}: ${JSON.stringify(valor)} não é ${saida.tipo}`);
    }
  });
}
