// Lê as specs do laboratório. Elas são a fonte de verdade (cadastro.md §1): nada aqui repete o que está nelas.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LAB = new URL('../../specs/experiments/laboratorio/', import.meta.url).pathname;

/** As células de uma linha de tabela, com `\|` de volta a `|`. */
function celulas(linha) {
  return linha.trim().split(/(?<!\\)\|/).slice(1, -1).map((celula) => celula.trim().replaceAll('\\|', '|'));
}

const semCrases = (texto) => texto.replaceAll('`', '');

/** Uma seção `## título`, até a próxima do mesmo nível. */
function secao(texto, titulo) {
  const inicio = texto.indexOf(`\n## ${titulo}`);
  if (inicio < 0) return '';
  const fim = texto.indexOf('\n## ', inicio + 1);
  return texto.slice(inicio, fim < 0 ? undefined : fim);
}

function linhasDeTabela(texto) {
  return texto.split('\n').filter((linha) => linha.startsWith('| `')).map(celulas);
}

const FORMAS = [
  [/^(\w+)\(\["(.+)"\]\)$/, 'Início'],
  [/^(\w+)\[\["(.+)"\]\]$/, 'Subprocesso'],
  [/^(\w+)\[\/"(.+)"\/\]$/, 'Automática'],
  [/^(\w+)\{\{"(.+)"\}\}$/, 'Decisão humana'],
  [/^(\w+)\{"(.+)"\}$/, 'Decisão automática'],
  [/^(\w+)\(\("(.+)"\)\)$/, 'Fim'],
  [/^(\w+)\["(.+)"\]$/, 'Humana'],
];

function lerDiagrama(texto) {
  const bloco = /```mermaid\n([\s\S]*?)```/.exec(texto)?.[1];
  if (!bloco) throw new Error('o processo não tem diagrama');
  const raias = [];
  const nos = new Map();
  const fluxos = [];
  let raia = null;
  for (const bruta of bloco.split('\n')) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith('flowchart')) continue;
    const grafo = /^subgraph (\w+)\["(.+)"\]$/.exec(linha);
    if (grafo) {
      raia = { codigo: grafo[1], nome: grafo[2] };
      raias.push(raia);
      continue;
    }
    if (linha === 'end') {
      raia = null;
      continue;
    }
    const fluxo = /^(\w+) -->(?:\|(sim|não)\|)? (\w+)$/.exec(linha);
    if (fluxo) {
      fluxos.push({ origem: fluxo[1], destino: fluxo[3], ramo: fluxo[2] });
      continue;
    }
    const forma = FORMAS.find(([padrao]) => padrao.test(linha));
    if (!forma) throw new Error(`linha desconhecida no diagrama: ${linha}`);
    const [, id, rotulo] = forma[0].exec(linha);
    nos.set(id, { id, tipo: forma[1], rotulo, raia: raia?.codigo });
  }
  return { raias, nos, fluxos };
}

function lerMapeamento(celula) {
  return [...celula.matchAll(/`([^`]+)`/g)].map(([, item]) => {
    const [destino, origem] = item.split('←').map((parte) => parte.trim());
    return { destino, origem: origem ?? destino };
  });
}

function lerFormularios(texto) {
  const formularios = new Map();
  const partes = secao(texto, 'Formulários').split(/\n(?=### )/).slice(1);
  for (const parte of partes) {
    const titulo = /^### (F-[A-Z]+-\d+): (.+)$/m.exec(parte);
    if (!titulo) continue;
    const campos = linhasDeTabela(parte).map(([chave, rotulo, tipo, regras]) => ({ chave: semCrases(chave), rotulo, tipo, regras }));
    formularios.set(titulo[1], { id: titulo[1], titulo: titulo[2], campos });
  }
  return formularios;
}

function lerProcesso(caminho) {
  const texto = readFileSync(caminho, 'utf8');
  const [, id, nome] = /^# ([A-Z]+-\d+): (.+)$/m.exec(texto);
  const etapas = new Map(linhasDeTabela(secao(texto, 'Etapas')).map(([chave, tipo, raia, rotulo, usa]) => [semCrases(chave), { tipo, raia, rotulo, usa: semCrases(usa) }]));
  const decisoes = new Map(linhasDeTabela(secao(texto, 'Decisões')).map(([chave, condicao]) => [semCrases(chave), condicao]));
  const mapeamentos = new Map(linhasDeTabela(secao(texto, 'Mapeamentos')).map(([chave, entradas, saidas]) => [semCrases(chave), { entradas: lerMapeamento(entradas), saidas: lerMapeamento(saidas) }]));
  return { id, nome, ...lerDiagrama(texto), etapas, decisoes, mapeamentos, formularios: lerFormularios(texto) };
}

/** A onda 1, na ordem de cadastro de processos/README.md §7. */
export const ONDA_1 = /^\| 1\. [^|]+\| ([^|]+)\|/m.exec(readFileSync(join(LAB, 'processos/README.md'), 'utf8'))[1].trim().split(', ');

export function lerProcessos(lab = LAB) {
  const pasta = join(lab, 'processos');
  const processos = new Map();
  for (const arquivo of readdirSync(pasta).filter((nome) => /^[a-z]+-\d+-.*\.md$/.test(nome))) {
    const processo = lerProcesso(join(pasta, arquivo));
    processos.set(processo.id, processo);
  }
  return processos;
}

function lerCampos(celula) {
  return [...celula.matchAll(/`(\w+):([\w<>]+)(\*?)`/g)].map(([, chave, tipo, obrigatorio]) => ({ chave, tipo, obrigatorio: obrigatorio === '*' }));
}

export function lerAutomacoes(lab = LAB) {
  const texto = readFileSync(join(lab, 'sistemas-externos.md'), 'utf8');
  const destinos = new Map();
  for (const linha of secao(texto, '4. Configuração no Chain').split('\n')) {
    const [sistema, nome, prefixo, credencial] = linha.startsWith('| ') ? celulas(linha) : [];
    if (prefixo?.startsWith('`/')) destinos.set(semCrases(nome), { sistema, nome: semCrases(nome), prefixo: semCrases(prefixo), credencial: semCrases(credencial) });
  }

  const automacoes = new Map();
  for (const [id, nome, chamada, entradas, saidas] of linhasDeTabela(secao(texto, '5. Automações')).filter(([id]) => id.startsWith('`AUT-'))) {
    const [metodo, caminho] = semCrases(chamada).split(' ');
    const destino = [...destinos.values()].find(({ prefixo }) => caminho.startsWith(`${prefixo}/`));
    automacoes.set(semCrases(id), { id: semCrases(id), nome, metodo, caminho, entradas: lerCampos(entradas), saidas: lerCampos(saidas), destino: destino?.nome });
  }
  return { automacoes, destinos };
}

/** Grupo → nomes das personas, dos documentos de setor. Os grupos transversais vêm sem membros. */
export function lerGrupos(lab = LAB) {
  const grupos = new Map();
  const pasta = join(lab, 'setores');
  for (const arquivo of readdirSync(pasta)) {
    const configuracao = secao(readFileSync(join(pasta, arquivo), 'utf8'), 'Configuração no Chain');
    for (const linha of configuracao.split('\n').filter((l) => l.startsWith('| ')).map(celulas)) {
      if (linha.length === 3 && linha[0] !== 'Grupo' && !linha[0].startsWith('---')) grupos.set(linha[0], linha[1].split(', '));
    }
  }
  const mapa = secao(readFileSync(join(lab, 'processos/README.md'), 'utf8'), '5. Grupos e permissões');
  for (const [, nome] of mapa.matchAll(/^\| ((?:Integração - [^|]+|Gestores|Colaboradores|Diretoria)) \|/gm)) grupos.set(nome.trim(), []);
  return grupos;
}

/** Processo → grupos com `start`, `view` e `viewSensitive`, da matriz de processos/README.md §5. */
export function lerPermissoes(lab = LAB) {
  const permissoes = new Map();
  const lista = (celula) => (celula === '—' ? [] : celula.split(', '));
  const mapa = secao(readFileSync(join(lab, 'processos/README.md'), 'utf8'), '5. Grupos e permissões');
  for (const linha of mapa.split('\n').filter((l) => /^\| [A-Z]+-\d+ \|/.test(l)).map(celulas)) {
    permissoes.set(linha[0], { start: lista(linha[1]), view: lista(linha[2]), viewSensitive: lista(linha[3]) });
  }
  return permissoes;
}

/** Bots de integração: grupo → bot, de sistemas-externos.md §6. */
export function lerBotsDeIntegracao(lab = LAB) {
  const bots = new Map();
  const texto = secao(readFileSync(join(lab, 'sistemas-externos.md'), 'utf8'), '6. Sistemas que iniciam processos');
  for (const linha of texto.split('\n').filter((l) => l.startsWith('| ')).map(celulas)) {
    if (linha[1]?.startsWith('`bot-')) bots.set(linha[2], semCrases(linha[1]));
  }
  return bots;
}
