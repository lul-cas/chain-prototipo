// cadastro.md §3.1: a notação dos documentos vira as árvores de expression-language.md §5.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { condicao, valor } from '../expressao.mjs';

const caminho = (...path) => ({ kind: 'path', path });
const texto = (value) => ({ kind: 'literal', type: 'text', value });
const numero = (value) => ({ kind: 'literal', type: 'number', value });
const booleano = (value) => ({ kind: 'literal', type: 'boolean', value });
const comparar = (left, operator, right) => ({ kind: 'compare', left, operator, right });

test('comparações de texto, número e booleano', () => {
  assert.deepEqual(condicao('tipoPessoa = "pj"'), comparar(caminho('tipoPessoa'), 'equals', texto('pj')));
  assert.deepEqual(condicao('parecer ≠ "aprovado"'), comparar(caminho('parecer'), 'notEquals', texto('aprovado')));
  assert.deepEqual(condicao('saldoConta > 0'), comparar(caminho('saldoConta'), 'greaterThan', numero('0')));
  assert.deepEqual(condicao('score < 400'), comparar(caminho('score'), 'lessThan', numero('400')));
  assert.deepEqual(condicao('score >= 750'), comparar(caminho('score'), 'greaterOrEqual', numero('750')));
  assert.deepEqual(condicao('valor <= 0.3'), comparar(caminho('valor'), 'lessOrEqual', numero('0.3')));
  assert.deepEqual(condicao('pep = true'), comparar(caminho('pep'), 'equals', booleano('true')));
  assert.deepEqual(condicao('possuiRestricao ≠ true'), comparar(caminho('possuiRestricao'), 'notEquals', booleano('true')));
});

test('contém e vazio', () => {
  assert.deepEqual(condicao('sistemas contém "core"'), comparar(caminho('sistemas'), 'contains', texto('core')));
  assert.deepEqual(condicao('numeroNota não está vazio'), { kind: 'compare', left: caminho('numeroNota'), operator: 'isNotEmpty' });
  assert.deepEqual(condicao('numeroNota está vazio'), { kind: 'compare', left: caminho('numeroNota'), operator: 'isEmpty' });
});

test('E liga mais forte que OU', () => {
  assert.deepEqual(condicao('a = 1 E b = 2'), {
    kind: 'group', op: 'and', items: [comparar(caminho('a'), 'equals', numero('1')), comparar(caminho('b'), 'equals', numero('2'))],
  });
  assert.deepEqual(condicao('a = 1 OU b = 2 E c = 3'), {
    kind: 'group',
    op: 'or',
    items: [
      comparar(caminho('a'), 'equals', numero('1')),
      { kind: 'group', op: 'and', items: [comparar(caminho('b'), 'equals', numero('2')), comparar(caminho('c'), 'equals', numero('3'))] },
    ],
  });
});

test('três termos ficam em um só grupo', () => {
  const grupo = condicao('a = 1 E b = 2 E c = 3');
  assert.equal(grupo.items.length, 3);
});

test('datas relativas', () => {
  assert.deepEqual(valor('hoje'), { kind: 'system', name: 'currentDate' });
  assert.deepEqual(valor('hoje + 15 dias'), { kind: 'system', name: 'currentDate', offset: { amount: 15, unit: 'days' } });
  assert.deepEqual(valor('hoje + 24 meses'), { kind: 'system', name: 'currentDate', offset: { amount: 24, unit: 'months' } });
  assert.deepEqual(valor('hoje − 18 anos'), { kind: 'system', name: 'currentDate', offset: { amount: -18, unit: 'years' } });
  assert.deepEqual(condicao('validade >= hoje'), comparar(caminho('validade'), 'greaterOrEqual', { kind: 'system', name: 'currentDate' }));
});

test('aritmética respeita a precedência e os parênteses', () => {
  assert.deepEqual(valor('a + b ÷ c'), {
    kind: 'arithmetic', op: 'add', left: caminho('a'), right: { kind: 'arithmetic', op: 'divide', left: caminho('b'), right: caminho('c') },
  });
  assert.deepEqual(valor('(a + b) ÷ c'), {
    kind: 'arithmetic', op: 'divide', left: { kind: 'arithmetic', op: 'add', left: caminho('a'), right: caminho('b') }, right: caminho('c'),
  });
  assert.deepEqual(valor('a − b'), { kind: 'arithmetic', op: 'subtract', left: caminho('a'), right: caminho('b') });
  assert.deepEqual(valor('a × b'), { kind: 'arithmetic', op: 'multiply', left: caminho('a'), right: caminho('b') });
  assert.deepEqual(valor('a − b − c'), {
    kind: 'arithmetic', op: 'subtract', left: { kind: 'arithmetic', op: 'subtract', left: caminho('a'), right: caminho('b') }, right: caminho('c'),
  });
});

test('a condição de aprovação automática de CRE-02', () => {
  const arvore = condicao('score >= 750 E possuiRestricao ≠ true E valorSolicitado <= 20000 E (parcelasAtuais + valorParcela) ÷ rendaMensal <= 0.3');
  assert.equal(arvore.op, 'and');
  assert.equal(arvore.items.length, 4);
  assert.deepEqual(arvore.items[3], comparar(
    { kind: 'arithmetic', op: 'divide', left: { kind: 'arithmetic', op: 'add', left: caminho('parcelasAtuais'), right: caminho('valorParcela') }, right: caminho('rendaMensal') },
    'lessOrEqual',
    numero('0.3'),
  ));
});

test('chamadas de função', () => {
  assert.deepEqual(valor('round(a × 100, 2)'), {
    kind: 'call', function: 'round', args: [{ kind: 'arithmetic', op: 'multiply', left: caminho('a'), right: numero('100') }, numero('2')],
  });
});

test('caminhos aninhados e literais em mapeamentos', () => {
  assert.deepEqual(valor('garantia.valorVeiculo'), caminho('garantia', 'valorVeiculo'));
  assert.deepEqual(valor('"Liberação de crédito"'), texto('Liberação de crédito'));
  assert.deepEqual(valor('10'), numero('10'));
});

test('o que a notação não prevê é um erro', () => {
  assert.throws(() => condicao('a ='), /esperava/);
  assert.throws(() => condicao('a = 1 b'), /sobrou/);
  assert.throws(() => condicao('a'), /comparação/);
  assert.throws(() => valor('hoje + 3 semanas'), /unidade/);
  assert.throws(() => valor('a @ b'), /caractere/);
});
