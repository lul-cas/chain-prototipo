// cadastro.md §3.3: uma linha de sistemas-externos.md vira o documento de automation.md §5.2.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { montarAutomacao } from '../modelos.mjs';

const DESTINO = { nome: 'core-bancario', credencial: 'core_api_key' };

test('um GET usa as entradas no caminho e não tem corpo', () => {
  const documento = montarAutomacao({
    metodo: 'GET',
    caminho: '/core/v1/clientes/{documentoCliente}',
    entradas: [{ chave: 'documentoCliente', tipo: 'text', obrigatorio: true }],
    saidas: [{ chave: 'encontrado', tipo: 'boolean', obrigatorio: true }, { chave: 'nomeCliente', tipo: 'text', obrigatorio: false }],
  }, DESTINO);
  assert.deepEqual(documento, {
    schemaVersion: 1,
    kind: 'http',
    inputs: [{ key: 'documentoCliente', type: 'text', required: true }],
    request: {
      method: 'GET',
      destination: 'core-bancario',
      path: '/core/v1/clientes/{documentoCliente}',
      query: {},
      headers: { 'X-Api-Key': '{{secret:core_api_key}}', Accept: 'application/json' },
      auth: null,
      body: null,
    },
    response: { type: 'json' },
    outputs: [
      { key: 'encontrado', type: 'boolean', required: true, source: 'body', path: ['encontrado'] },
      { key: 'nomeCliente', type: 'text', required: false, source: 'body', path: ['nomeCliente'] },
    ],
  });
});

test('um POST manda no corpo o que não está no caminho', () => {
  const { request } = montarAutomacao({
    metodo: 'POST',
    caminho: '/core/v1/clientes/{documentoCliente}/apolices',
    entradas: [{ chave: 'documentoCliente', tipo: 'text', obrigatorio: true }, { chave: 'numeroApolice', tipo: 'text', obrigatorio: true }],
    saidas: [],
  }, DESTINO);
  assert.deepEqual(request.body, { type: 'json', keys: ['numeroApolice'] });
});

test('um POST sem entradas fora do caminho não tem corpo', () => {
  const { request } = montarAutomacao({
    metodo: 'POST',
    caminho: '/core/v1/contratos/{numeroContrato}/liberacao',
    entradas: [{ chave: 'numeroContrato', tipo: 'text', obrigatorio: true }],
    saidas: [],
  }, DESTINO);
  assert.equal(request.body, null);
});
