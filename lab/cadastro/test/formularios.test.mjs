// cadastro.md §3.2: as linhas de um formulário viram o documento de forms.md F1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { montarFormulario } from '../modelos.mjs';

const campo = (chave, rotulo, tipo, regras = '—') => ({ chave, rotulo, tipo, regras });

function componentes(...linhas) {
  return montarFormulario(linhas, () => { throw new Error('sem formulários vizinhos'); }).components;
}

test('um campo simples', () => {
  assert.deepEqual(componentes(campo('nomeCliente', 'Nome', 'text', 'obrigatório; máx. 150 caracteres')), [
    { type: 'text', key: 'nomeCliente', label: 'Nome', validate: { required: true, maxLength: 150 } },
  ]);
});

test('sem regras não há validate', () => {
  assert.deepEqual(componentes(campo('complemento', 'Complemento', 'text')), [{ type: 'text', key: 'complemento', label: 'Complemento' }]);
});

test('o documento tem a versão do esquema', () => {
  assert.equal(montarFormulario([], () => null).schemaVersion, 1);
});

test('somente leitura e sensível', () => {
  assert.deepEqual(componentes(campo('rendaMensal', 'Renda', 'number', 'somente leitura; sensível')), [
    { type: 'number', key: 'rendaMensal', label: 'Renda', readOnly: true, sensitive: true },
  ]);
});

test('números: mínimo com vírgula, máximo e casas', () => {
  assert.deepEqual(componentes(campo('valor', 'Valor', 'number', 'obrigatório; mín. 0,01; máx. 5000000; 2 casas'))[0].validate, {
    required: true, min: 0.01, max: 5000000, decimalDigits: 2,
  });
});

test('datas: limites relativos', () => {
  assert.deepEqual(componentes(campo('nascimento', 'Nascimento', 'date', 'obrigatório; máx. hoje − 18 anos'))[0].validate, {
    required: true, max: { system: 'currentDate', offset: { amount: -18, unit: 'years' } },
  });
  assert.deepEqual(componentes(campo('emissao', 'Emissão', 'date', 'máx. hoje'))[0].validate, { max: { system: 'currentDate' } });
  assert.deepEqual(componentes(campo('inicio', 'Início', 'date', 'mín. hoje + 30 dias'))[0].validate, {
    min: { system: 'currentDate', offset: { amount: 30, unit: 'days' } },
  });
});

test('formato e padrão', () => {
  assert.deepEqual(componentes(campo('email', 'E-mail', 'text', 'obrigatório; formato `email`'))[0].validate, { required: true, format: 'email' });
  assert.deepEqual(componentes(campo('doc', 'Doc', 'text', 'padrão `^([0-9]{11}|[0-9]{14})$`'))[0].validate, { pattern: '^([0-9]{11}|[0-9]{14})$' });
});

test('um padrão com ponto e vírgula não quebra as regras', () => {
  assert.deepEqual(componentes(campo('x', 'X', 'text', 'padrão `^[a;b]$`; obrigatório'))[0].validate, { pattern: '^[a;b]$', required: true });
});

test('arquivos e listas', () => {
  assert.deepEqual(componentes(campo('doc', 'Doc', 'file', 'obrigatório; máx. 2 arquivos'))[0].validate, { required: true, maxFiles: 2 });
  assert.deepEqual(componentes(campo('uma', 'Uma', 'file', 'máx. 1 arquivo'))[0].validate, { maxFiles: 1 });
  assert.deepEqual(componentes(campo('socios', 'Sócios', 'dynamicList', 'mín. 1 linha; máx. 10 linhas'))[0].validate, { minRows: 1, maxRows: 10 });
});

test('opções com e sem rótulo', () => {
  const [comRotulo] = componentes(campo('tipo', 'Tipo', 'radio', 'obrigatório; opções: `pf` Pessoa física, `pj` Pessoa jurídica'));
  assert.deepEqual(comRotulo.options, [{ value: 'pf', label: 'Pessoa física' }, { value: 'pj', label: 'Pessoa jurídica' }]);
  const [semRotulo] = componentes(campo('nota', 'Nota', 'select', 'opções: `A`, `B`'));
  assert.deepEqual(semRotulo.options, [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }]);
});

test('opções de outro formulário', () => {
  const opcoes = [{ value: 'x', label: 'Xis' }];
  const { components } = montarFormulario([campo('pendencias', 'P', 'checklist', 'opções: as de `F-CAD-01`')], (formulario, chave) => {
    assert.deepEqual([formulario, chave], ['F-CAD-01', 'pendencias']);
    return opcoes;
  });
  assert.deepEqual(components[0].options, opcoes);
});

test('condições viram árvores', () => {
  const [componente] = componentes(campo('convenio', 'Convênio', 'text', 'visível quando `produto = "consignado"`; obrigatório quando `produto = "consignado"`'));
  const condicao = { kind: 'compare', left: { kind: 'path', path: ['produto'] }, operator: 'equals', right: { kind: 'literal', type: 'text', value: 'consignado' } };
  assert.deepEqual(componente.visibleWhen, condicao);
  assert.deepEqual(componente.requiredWhen, condicao);
  assert.equal(componente.validate, undefined);
});

test('`x` não está vazio, com a chave em código', () => {
  const [componente] = componentes(campo('s', 'S', 'text', 'somente leitura; visível quando `s` não está vazio'));
  assert.deepEqual(componente.visibleWhen, { kind: 'compare', left: { kind: 'path', path: ['s'] }, operator: 'isNotEmpty' });
});

test('campos calculados', () => {
  const [componente] = componentes(campo('total', 'Total', 'computed', 'sensível; `= round(a × b, 2)`'));
  assert.equal(componente.sensitive, true);
  assert.equal(componente.expression.kind, 'call');
});

test('grupos e listas aninham seus campos', () => {
  const [dados] = componentes(
    campo('dadosPj', 'PJ', 'group', 'visível quando `tipo = "pj"`'),
    campo('dadosPj.atividade', 'Atividade', 'text', 'obrigatório'),
    campo('dadosPj.socios', 'Sócios', 'dynamicList', 'máx. 10 linhas'),
    campo('dadosPj.socios[].nome', 'Nome', 'text', 'obrigatório'),
    campo('dadosPj.socios[].cpf', 'CPF', 'text', 'formato `cpf`'),
  );
  assert.equal(dados.type, 'group');
  assert.equal(dados.components.length, 2);
  assert.deepEqual(dados.components[0], { type: 'text', key: 'atividade', label: 'Atividade', validate: { required: true } });
  assert.equal(dados.components[1].type, 'dynamicList');
  assert.deepEqual(dados.components[1].components.map(({ key }) => key), ['nome', 'cpf']);
});

test('uma lista no primeiro nível', () => {
  const [lista] = componentes(
    campo('beneficiarios', 'Beneficiários', 'dynamicList', 'máx. 5 linhas'),
    campo('beneficiarios[].nome', 'Nome', 'text'),
  );
  assert.deepEqual(lista.components.map(({ key }) => key), ['nome']);
});

test('uma regra desconhecida é um erro', () => {
  assert.throws(() => componentes(campo('x', 'X', 'text', 'obrigatorio')), /regra/);
  assert.throws(() => componentes(campo('x', 'X', 'nada')), /tipo/);
  assert.throws(() => componentes(campo('a.b', 'B', 'text')), /grupo/);
});
