// Monta os documentos do Chain a partir do que documentos.mjs leu (cadastro.md §3).
import { condicao, valor } from './expressao.mjs';

const TIPOS = new Set(['text', 'textarea', 'number', 'checkbox', 'select', 'radio', 'checklist', 'date', 'datetime', 'time', 'file', 'group', 'dynamicList', 'computed']);
const TIPOS_DE_DATA = new Set(['date', 'datetime', 'time']);

/** As regras de um campo, separadas por `;` fora do código. */
function separarRegras(texto) {
  if (texto === '—') return [];
  const regras = [];
  let atual = '';
  let emCodigo = false;
  for (const letra of texto) {
    if (letra === '`') emCodigo = !emCodigo;
    if (letra === ';' && !emCodigo) {
      regras.push(atual.trim());
      atual = '';
    } else {
      atual += letra;
    }
  }
  regras.push(atual.trim());
  return regras;
}

function lerOpcoes(texto, campo, opcoesDe) {
  const outro = /^as de `(F-[A-Z]+-\d+)`$/.exec(texto);
  if (outro) return opcoesDe(outro[1], campo.chave);
  return [...texto.matchAll(/`([^`]+)`(?: ([^,]+))?/g)].map(([, value, label]) => ({ value, label: label?.trim() ?? value }));
}

function limite(texto, tipo) {
  if (!TIPOS_DE_DATA.has(tipo)) return Number(texto.replace(',', '.'));
  const { name: system, offset } = valor(texto);
  return offset ? { system, offset } : { system };
}

const semCrases = (texto) => texto.replaceAll('`', '');

const REGRAS = [
  [/^obrigatório$/, (c) => { c.validate.required = true; }],
  [/^somente leitura$/, (c) => { c.componente.readOnly = true; }],
  [/^sensível$/, (c) => { c.componente.sensitive = true; }],
  [/^visível quando (.+)$/, (c, texto) => { c.componente.visibleWhen = condicao(semCrases(texto)); }],
  [/^obrigatório quando (.+)$/, (c, texto) => { c.componente.requiredWhen = condicao(semCrases(texto)); }],
  [/^opções: (.+)$/, (c, texto) => { c.componente.options = lerOpcoes(texto, c.campo, c.opcoesDe); }],
  [/^máx\. (\d+) caracteres$/, (c, n) => { c.validate.maxLength = Number(n); }],
  [/^máx\. (\d+) arquivos?$/, (c, n) => { c.validate.maxFiles = Number(n); }],
  [/^mín\. (\d+) linhas?$/, (c, n) => { c.validate.minRows = Number(n); }],
  [/^máx\. (\d+) linhas?$/, (c, n) => { c.validate.maxRows = Number(n); }],
  [/^(\d+) casas$/, (c, n) => { c.validate.decimalDigits = Number(n); }],
  [/^formato `(.+)`$/, (c, formato) => { c.validate.format = formato; }],
  [/^padrão `(.+)`$/, (c, padrao) => { c.validate.pattern = padrao; }],
  [/^mín\. (.+)$/, (c, texto) => { c.validate.min = limite(texto, c.campo.tipo); }],
  [/^máx\. (.+)$/, (c, texto) => { c.validate.max = limite(texto, c.campo.tipo); }],
  [/^`= (.+)`$/, (c, texto) => { c.componente.expression = valor(texto); }],
];

function montarCampo(campo, opcoesDe) {
  if (!TIPOS.has(campo.tipo)) throw new Error(`tipo desconhecido em ${campo.chave}: ${campo.tipo}`);
  const key = campo.chave.replaceAll('[]', '').split('.').at(-1);
  const contexto = { campo, opcoesDe, componente: { type: campo.tipo, key, label: campo.rotulo }, validate: {} };
  for (const regra of separarRegras(campo.regras)) {
    const achada = REGRAS.find(([padrao]) => padrao.test(regra));
    if (!achada) throw new Error(`regra desconhecida em ${campo.chave}: ${regra}`);
    achada[1](contexto, ...achada[0].exec(regra).slice(1));
  }
  if (Object.keys(contexto.validate).length > 0) contexto.componente.validate = contexto.validate;
  return contexto.componente;
}

/** `opcoesDe(formulario, chave)` resolve `opções: as de F-X`. */
export function montarFormulario(campos, opcoesDe) {
  const components = [];
  const porCaminho = new Map();
  for (const campo of campos) {
    const componente = montarCampo(campo, opcoesDe);
    const caminho = campo.chave.replaceAll('[]', '');
    const pai = caminho.split('.').slice(0, -1).join('.');
    if (pai) {
      const grupo = porCaminho.get(pai);
      if (!grupo) throw new Error(`${campo.chave} não tem grupo ou lista antes dele`);
      grupo.components ??= [];
      grupo.components.push(componente);
    } else {
      components.push(componente);
    }
    porCaminho.set(caminho, componente);
  }
  return { schemaVersion: 1, components };
}

export function montarAutomacao({ metodo, caminho, entradas, saidas }, destino) {
  const noCaminho = new Set([...caminho.matchAll(/\{(\w+)\}/g)].map(([, chave]) => chave));
  const keys = entradas.map(({ chave }) => chave).filter((chave) => !noCaminho.has(chave));
  const temCorpo = (metodo === 'POST' || metodo === 'PUT') && keys.length > 0;
  return {
    schemaVersion: 1,
    kind: 'http',
    inputs: entradas.map(({ chave, tipo, obrigatorio }) => ({ key: chave, type: tipo, required: obrigatorio })),
    request: {
      method: metodo,
      destination: destino.nome,
      path: caminho,
      query: {},
      headers: { 'X-Api-Key': `{{secret:${destino.credencial}}}`, Accept: 'application/json' },
      auth: null,
      body: temCorpo ? { type: 'json', keys } : null,
    },
    response: { type: 'json' },
    outputs: saidas.map(({ chave, tipo, obrigatorio }) => ({ key: chave, type: tipo, required: obrigatorio, source: 'body', path: [chave] })),
  };
}

const TAMANHOS = { 'Início': [64, 64], Fim: [64, 64], 'Decisão automática': [70, 70], 'Decisão humana': [70, 70] };
const COLUNA = 190;
const LINHA = 110;
const FAIXA = 60;
const MARGEM = 40;
const VAO = 10;

/** A coluna de cada nó: a maior distância até o início, sem contar as voltas. */
function colunas(processo) {
  const saidas = new Map();
  for (const { origem, destino } of processo.fluxos) saidas.set(origem, [...(saidas.get(origem) ?? []), destino]);
  const inicio = [...processo.nos.values()].find(({ tipo }) => tipo === 'Início').id;

  const voltas = new Set();
  const naPilha = new Set();
  const vistos = new Set();
  const visitar = (no) => {
    vistos.add(no);
    naPilha.add(no);
    for (const proximo of saidas.get(no) ?? []) {
      if (naPilha.has(proximo)) voltas.add(`${no}>${proximo}`);
      else if (!vistos.has(proximo)) visitar(proximo);
    }
    naPilha.delete(no);
  };
  visitar(inicio);

  const coluna = new Map([[inicio, 0]]);
  for (let mudou = true; mudou;) {
    mudou = false;
    for (const { origem, destino } of processo.fluxos) {
      if (voltas.has(`${origem}>${destino}`) || !coluna.has(origem)) continue;
      const nova = coluna.get(origem) + 1;
      if (nova > (coluna.get(destino) ?? -1)) {
        coluna.set(destino, nova);
        mudou = true;
      }
    }
  }
  return coluna;
}

function calcularLayout(processo) {
  const coluna = colunas(processo);
  const linhaDe = new Map();
  const ocupadas = new Map();
  for (const no of processo.nos.values()) {
    const chave = `${no.raia}|${coluna.get(no.id)}`;
    const linha = ocupadas.get(chave) ?? 0;
    linhaDe.set(no.id, linha);
    ocupadas.set(chave, linha + 1);
  }

  const largura = FAIXA + MARGEM * 2 + (Math.max(...coluna.values()) + 1) * COLUNA;
  const raias = new Map();
  let y = 30;
  for (const { codigo } of processo.raias) {
    const linhas = Math.max(1, ...[...processo.nos.values()].filter(({ raia }) => raia === codigo).map(({ id }) => linhaDe.get(id) + 1));
    const h = linhas * LINHA + 20;
    raias.set(codigo, { x: 40, y, w: largura, h });
    y += h + VAO;
  }

  const nos = new Map();
  for (const no of processo.nos.values()) {
    const [w, h] = TAMANHOS[no.tipo] ?? [140, 70];
    const raia = raias.get(no.raia);
    nos.set(no.id, {
      x: raia.x + FAIXA + MARGEM + coluna.get(no.id) * COLUNA + Math.round((140 - w) / 20) * 10,
      y: raia.y + 20 + linhaDe.get(no.id) * LINHA + Math.round((70 - h) / 20) * 10,
      w,
      h,
    });
  }
  return { raias, nos };
}

function arvores(lista) {
  return Object.fromEntries(lista.map(({ destino, origem }) => [destino, valor(origem)]));
}

function montarNo(no, processo, referencias, layout) {
  const etapa = processo.etapas.get(no.id);
  if (!etapa) throw new Error(`${processo.id}: ${no.id} não está em Etapas`);
  const base = { id: no.id, label: etapa.rotulo, laneId: `lane_${no.raia.toLowerCase()}`, layout };
  const mapeamento = processo.mapeamentos.get(no.id);
  const formulario = etapa.usa.startsWith('F-') ? { form: { formId: referencias.formulario(etapa.usa) } } : {};
  switch (no.tipo) {
    case 'Início':
      return { ...base, type: 'start', ...formulario };
    case 'Fim':
      return { ...base, type: 'end' };
    case 'Humana':
      return { ...base, type: 'task', taskKind: 'human', ...formulario };
    case 'Automática':
      return {
        ...base,
        type: 'task',
        taskKind: 'automation',
        automation: { automationId: referencias.automacao(etapa.usa), inputs: arvores(mapeamento.entradas), outputs: arvores(mapeamento.saidas) },
      };
    case 'Subprocesso':
      return {
        ...base,
        type: 'task',
        taskKind: 'subprocess',
        workflow: { workflowId: referencias.processo(etapa.usa), inputs: arvores(mapeamento.entradas), outputs: arvores(mapeamento.saidas) },
      };
    case 'Decisão humana':
      return { ...base, type: 'gateway', decisionMode: 'human', question: processo.decisoes.get(no.id) };
    case 'Decisão automática':
      return { ...base, type: 'gateway', decisionMode: 'automatic', condition: condicao(semCrases(processo.decisoes.get(no.id))) };
    default:
      throw new Error(`${processo.id}: tipo desconhecido em ${no.id}`);
  }
}

/** `referencias` resolve grupo, formulário, automação e processo para os ids do Chain. */
export function montarProcesso(processo, referencias) {
  const layout = calcularLayout(processo);
  return {
    schemaVersion: 1,
    lanes: processo.raias.map(({ codigo, nome }) => ({
      id: `lane_${codigo.toLowerCase()}`,
      title: nome,
      group: nome === 'Solicitantes' ? { kind: 'requesters' } : { kind: 'group', groupId: referencias.grupo(nome) },
      layout: layout.raias.get(codigo),
    })),
    nodes: [...processo.nos.values()].map((no) => montarNo(no, processo, referencias, layout.nos.get(no.id))),
    flows: processo.fluxos.map(({ origem, destino, ramo }, indice) => ({
      id: `f_${indice + 1}`,
      source: origem,
      target: destino,
      ...(ramo ? { branch: ramo === 'sim' ? 'true' : 'false' } : {}),
    })),
  };
}
