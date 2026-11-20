// O mock sem a rede: autenticação, rotas e idempotência (mock.md §2). server.mjs só liga isto a uma porta.
import { massaInicial } from './massa.mjs';
import { ROTAS } from './sistemas.mjs';

const COMPILADAS = ROTAS.map(([metodo, padrao, tratar]) => ({
  metodo,
  tratar,
  regex: new RegExp(`^${padrao.replaceAll(/:(\w+)/g, '(?<$1>[^/]+)')}$`),
}));

/** A data em UTC−03:00, como o Chain a lê (ADR-0003). */
export function hojeNoBrasil(agora = Date.now()) {
  return new Date(agora - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function estadoVisivel(estado) {
  const { clientes, contratos, decisoes, apolices, gravames, acordos, pagamentos, boletos, lancamentos, mensagens, comunicacoes } = estado;
  return { clientes: [...clientes.values()], contratos: [...contratos.values()], decisoes, apolices, gravames, acordos, pagamentos, boletos, lancamentos, mensagens, comunicacoes };
}

function encontrarRota(metodo, caminho) {
  for (const rota of COMPILADAS) {
    if (rota.metodo !== metodo) continue;
    const achou = rota.regex.exec(caminho);
    if (achou) {
      const parametros = Object.fromEntries(Object.entries(achou.groups ?? {}).map(([nome, valor]) => [nome, decodeURIComponent(valor)]));
      return { tratar: rota.tratar, parametros };
    }
  }
  return null;
}

export function criarMock({ chave, hoje = hojeNoBrasil() }) {
  let estado = massaInicial(hoje);
  let respostas = new Map();

  function tratarInspecao(metodo, caminho) {
    if (metodo === 'GET' && caminho === '/__mock/estado') return { status: 200, corpo: estadoVisivel(estado) };
    if (metodo === 'POST' && caminho === '/__mock/reiniciar') {
      estado = massaInicial(hoje);
      respostas = new Map();
      return { status: 200, corpo: { reiniciado: true } };
    }
    return null;
  }

  async function tratar({ metodo, caminho, cabecalhos = {}, corpo }) {
    if (!chave || cabecalhos['x-api-key'] !== chave) return { status: 401, corpo: { erro: 'chave inválida' } };

    const semQuery = caminho.split('?')[0];
    const inspecao = tratarInspecao(metodo, semQuery);
    if (inspecao) return inspecao;

    const rota = encontrarRota(metodo, semQuery);
    if (!rota) return { status: 404, corpo: { erro: 'caminho desconhecido' } };

    let conteudo = {};
    if (corpo) {
      try {
        conteudo = JSON.parse(corpo);
      } catch {
        return { status: 400, corpo: { erro: 'o corpo não é JSON' } };
      }
    }

    const idempotencia = cabecalhos['idempotency-key'];
    const chaveDaResposta = idempotencia && `${metodo} ${semQuery} ${idempotencia}`;
    if (chaveDaResposta && respostas.has(chaveDaResposta)) return respostas.get(chaveDaResposta);

    const resposta = { status: 200, corpo: rota.tratar(estado, rota.parametros, conteudo, { hoje }) };
    if (chaveDaResposta) respostas.set(chaveDaResposta, resposta);
    return resposta;
  }

  return { tratar };
}
