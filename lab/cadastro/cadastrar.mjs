// Leva a onda 1 das specs para o Chain da stack do laboratório (cadastro.md). Pode rodar de novo: reaproveita o que já existe.
// Uso, com a stack no ar: node lab/cadastro/cadastrar.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Api, ErroDaApi, precisaDeToken } from './api.mjs';
import { lerAutomacoes, lerBotsDeIntegracao, lerGrupos, lerPermissoes, lerProcessos, ONDA_1 } from './documentos.mjs';
import { montarAutomacao, montarFormulario, montarProcesso } from './modelos.mjs';

const SEGREDOS = new URL('../.segredos/', import.meta.url).pathname;
const ADMIN = 'lab-admin';

export const BASE = process.env.CHAIN_LAB_API ?? 'http://localhost:56080';
export const ORIGEM = process.env.CHAIN_LAB_ORIGIN ?? 'http://localhost:54300';

function lerEnv(arquivo) {
  if (!existsSync(arquivo)) return {};
  return Object.fromEntries(readFileSync(arquivo, 'utf8').split('\n').filter(Boolean).map((linha) => {
    const posicao = linha.indexOf('=');
    return [linha.slice(0, posicao), linha.slice(posicao + 1)];
  }));
}

function guardar(nome, conteudo) {
  mkdirSync(SEGREDOS, { recursive: true, mode: 0o700 });
  writeFileSync(`${SEGREDOS}${nome}`, conteudo, { mode: 0o600 });
}

export const lerBots = () => (existsSync(`${SEGREDOS}bots.json`) ? JSON.parse(readFileSync(`${SEGREDOS}bots.json`, 'utf8')) : {});
export const chaveDoMock = () => lerEnv(`${SEGREDOS}stack.env`).CHAIN_LAB_MOCK_KEY;

/** O admin nasce com senha provisória, e precisa trocá-la para administrar (identity.md, I1). */
async function entrarComoAdmin() {
  const stack = lerEnv(`${SEGREDOS}stack.env`);
  if (!stack.CHAIN_LAB_ADMIN_INITIAL_PASSWORD) throw new Error('Suba a stack antes: lab/stack.sh up');
  const api = new Api({ base: BASE, origem: ORIGEM });
  const salva = lerEnv(`${SEGREDOS}admin.env`).CHAIN_LAB_ADMIN_PASSWORD;
  if (salva) {
    await api.entrar(ADMIN, salva);
    return api;
  }
  await api.entrar(ADMIN, stack.CHAIN_LAB_ADMIN_INITIAL_PASSWORD);
  const nova = `lab-${randomBytes(16).toString('hex')}`;
  await api.post('/api/auth/change-password', { currentPassword: stack.CHAIN_LAB_ADMIN_INITIAL_PASSWORD, newPassword: nova });
  guardar('admin.env', `CHAIN_LAB_ADMIN_PASSWORD=${nova}\n`);
  await api.entrar(ADMIN, nova);
  return api;
}

const slug = (nome) => nome.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Os grupos da onda 1: os das raias e os que têm alguma permissão nos seus processos. */
function gruposDaOnda(processos, permissoes) {
  const nomes = new Set();
  for (const id of ONDA_1) {
    for (const { nome } of processos.get(id).raias) if (nome !== 'Solicitantes') nomes.add(nome);
    for (const lista of Object.values(permissoes.get(id))) for (const nome of lista) nomes.add(nome);
  }
  return nomes;
}

async function garantirGrupos(api, nomes) {
  const existentes = new Map((await api.get('/api/admin/groups')).map((grupo) => [grupo.name, grupo.id]));
  for (const nome of nomes) {
    if (!existentes.has(nome)) existentes.set(nome, (await api.post('/api/admin/groups', { name: nome })).id);
  }
  return existentes;
}

async function garantirBots(api, membros, integracoes, grupos) {
  const bots = lerBots();
  const existentes = new Map((await api.get('/api/admin/bots')).map((bot) => [bot.name, bot]));
  const garantir = async (nome, exibicao, mcp) => {
    let bot = existentes.get(nome);
    if (!bot) {
      bot = await api.post('/api/admin/bots', { name: nome, displayName: exibicao });
      existentes.set(nome, bot);
    }
    if (mcp) await api.post(`/api/admin/bots/${bot.id}/mcp/enable`);
    if (precisaDeToken(bots[nome], bot)) {
      const { value } = await api.post(`/api/admin/bots/${bot.id}/tokens`, { label: 'laboratório' });
      bots[nome] = { id: bot.id, token: value };
      guardar('bots.json', JSON.stringify(bots, null, 2));
    }
    return bot;
  };
  for (const [grupo, nomes] of membros) {
    for (const nome of nomes) {
      const bot = await garantir(`persona-${slug(nome)}`, nome, true);
      await api.put(`/api/admin/groups/${grupos.get(grupo)}/members/${bot.id}`);
    }
  }
  for (const [grupo, nome] of integracoes) {
    const bot = await garantir(nome, nome, false);
    await api.put(`/api/admin/groups/${grupos.get(grupo)}/members/${bot.id}`);
  }
}

async function garantirDestinos(api, destinos, chave) {
  const existentes = new Set((await api.get('/api/admin/automation/destinations')).map(({ name }) => name));
  const credenciais = new Set((await api.get('/api/admin/automation/secrets')).map(({ name }) => name));
  for (const destino of destinos) {
    if (!existentes.has(destino.nome)) {
      await api.post('/api/admin/automation/destinations', {
        name: destino.nome, description: destino.sistema, scheme: 'http', host: 'mock', port: 8080, pathPrefix: destino.prefixo, internal: true, allowSecretsOverHttp: true,
      });
    }
    if (!credenciais.has(destino.credencial)) {
      await api.post('/api/admin/automation/secrets', { name: destino.credencial, description: destino.sistema, value: chave, allowedDestinations: [destino.nome] });
    }
  }
}

/** Forms e automações têm o mesmo ciclo (forms.md, automation.md §5.1): cria pelo nome, salva o rascunho e publica. */
async function publicar(api, colecao, itens) {
  const existentes = new Map((await api.get(colecao)).map(({ id, name }) => [name, id]));
  const ids = new Map();
  for (const { chave, nome, documento } of itens) {
    const id = existentes.get(nome) ?? (await api.post(colecao, { name: nome })).id;
    await api.comVersao('PUT', `${colecao}/${id}`, `${colecao}/${id}/draft`, { document: documento });
    await api.comVersao('POST', `${colecao}/${id}`, `${colecao}/${id}/publish`);
    ids.set(chave, id);
  }
  return ids;
}

function formulariosDaOnda(processos) {
  const formularios = new Map();
  for (const id of ONDA_1) for (const [nome, formulario] of processos.get(id).formularios) formularios.set(nome, formulario);
  const opcoesDe = (nome, chave) => {
    const opcoes = montarFormulario(formularios.get(nome).campos, opcoesDe).components.find(({ key }) => key === chave)?.options;
    if (!opcoes) throw new Error(`${nome} não tem as opções de ${chave}`);
    return opcoes;
  };
  return [...formularios.values()].map(({ id, titulo, campos }) => ({ chave: id, nome: `${id} ${titulo}`, documento: montarFormulario(campos, opcoesDe) }));
}

function automacoesDaOnda(processos, { automacoes, destinos }) {
  const usadas = new Set();
  for (const id of ONDA_1) for (const { usa } of processos.get(id).etapas.values()) if (usa.startsWith('AUT-')) usadas.add(usa);
  return [...usadas].sort().map((id) => {
    const automacao = automacoes.get(id);
    return { chave: id, nome: `${id} ${automacao.nome}`, documento: montarAutomacao(automacao, destinos.get(automacao.destino)) };
  });
}

async function publicarProcessos(api, processos, referencias, grupos, permissoes) {
  const existentes = new Map((await api.get('/api/workflows')).map(({ id, name }) => [name, id]));
  const ids = new Map();
  const falhas = [];
  for (const id of ONDA_1) {
    const processo = processos.get(id);
    const nome = `${id} ${processo.nome}`;
    const definicao = existentes.get(nome) ?? (await api.post('/api/workflows', { name: nome })).id;
    ids.set(id, definicao);
    const documento = montarProcesso(processo, { ...referencias, processo: (filho) => ids.get(filho) });
    await api.comVersao('PUT', `/api/workflows/${definicao}`, `/api/workflows/${definicao}/draft`, { document: documento });
    try {
      const publicado = await api.comVersao('POST', `/api/workflows/${definicao}`, `/api/workflows/${definicao}/publish`);
      console.log(`${nome}: versão ${publicado.versionNumber}`);
    } catch (erro) {
      if (!(erro instanceof ErroDaApi) || erro.status !== 422) throw erro;
      falhas.push({ id, erros: erro.corpo.errors });
      continue;
    }
    const { start, view, viewSensitive } = permissoes.get(id);
    const porGrupo = new Map();
    const conceder = (lista, ...capacidades) => {
      for (const grupo of lista) porGrupo.set(grupo, [...new Set([...(porGrupo.get(grupo) ?? []), ...capacidades])]);
    };
    conceder(start, 'start');
    conceder(view, 'view', 'comment');
    conceder(viewSensitive, 'view', 'viewSensitive');
    const corpo = [...porGrupo].map(([grupo, capabilities]) => ({ groupId: grupos.get(grupo), capabilities }));
    await api.comVersao('PUT', `/api/workflows/${definicao}`, `/api/workflows/${definicao}/grants`, corpo);
  }
  return { ids, falhas };
}

export async function cadastrar() {
  const processos = lerProcessos();
  const permissoes = lerPermissoes();
  const todosOsGrupos = lerGrupos();
  const integracoes = lerBotsDeIntegracao();
  const documentos = lerAutomacoes();
  const api = await entrarComoAdmin();

  const nomes = gruposDaOnda(processos, permissoes);
  const grupos = await garantirGrupos(api, nomes);
  await garantirBots(
    api,
    [...nomes].map((nome) => [nome, todosOsGrupos.get(nome) ?? []]),
    [...integracoes].filter(([grupo]) => nomes.has(grupo)),
    grupos,
  );

  const automacoes = automacoesDaOnda(processos, documentos);
  const destinos = new Set(automacoes.map(({ chave }) => documentos.automacoes.get(chave).destino));
  await garantirDestinos(api, [...destinos].map((nome) => documentos.destinos.get(nome)), chaveDoMock());

  const idsDeAutomacoes = await publicar(api, '/api/automations', automacoes);
  const idsDeFormularios = await publicar(api, '/api/forms', formulariosDaOnda(processos));
  console.log(`${nomes.size} grupos, ${destinos.size} destinos, ${idsDeAutomacoes.size} automações, ${idsDeFormularios.size} formulários`);

  const referencias = { grupo: (nome) => grupos.get(nome), formulario: (id) => idsDeFormularios.get(id), automacao: (id) => idsDeAutomacoes.get(id) };
  const { ids, falhas } = await publicarProcessos(api, processos, referencias, grupos, permissoes);
  guardar('cadastro.json', JSON.stringify(Object.fromEntries(ids), null, 2));
  for (const { id, erros } of falhas) {
    console.error(`${id} não publicou:`);
    for (const { code, message, elementId } of erros) console.error(`  ${code} ${elementId ?? ''}: ${message}`);
  }
  return falhas.length === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cadastrar().then((sucesso) => process.exit(sucesso ? 0 : 1), (erro) => {
    console.error(erro.message);
    process.exit(1);
  });
}
