// Um cliente mínimo da API do Chain: sessão com cookie para o admin, token para os bots.

export class ErroDaApi extends Error {
  constructor(metodo, caminho, status, corpo) {
    super(`${metodo} ${caminho}: ${status} ${typeof corpo === 'string' ? corpo : JSON.stringify(corpo)}`);
    this.status = status;
    this.corpo = corpo;
  }
}

/** Um token guardado só vale para o bot que o recebeu: uma stack recriada tem bots novos, com outros ids. */
export function precisaDeToken(salvo, bot) {
  return salvo?.id !== bot.id;
}

async function lerCorpo(resposta) {
  const texto = await resposta.text();
  if (!texto) return undefined;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

export class Api {
  #cookie = null;

  constructor({ base, origem, token, fetch = globalThis.fetch }) {
    this.base = base;
    this.origem = origem;
    this.token = token;
    this.fetch = fetch;
  }

  async #pedir(metodo, caminho, corpo, extras = {}) {
    const headers = { Accept: 'application/json', ...extras };
    if (this.origem) headers.Origin = this.origem;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.#cookie) headers.Cookie = this.#cookie;
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';
    const resposta = await this.fetch(`${this.base}${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const conteudo = await lerCorpo(resposta);
    if (!resposta.ok) throw new ErroDaApi(metodo, caminho, resposta.status, conteudo);
    return { conteudo, resposta };
  }

  async entrar(username, password) {
    const { resposta } = await this.#pedir('POST', '/api/auth/login', { username, password });
    const cookies = resposta.headers.getSetCookie?.() ?? [resposta.headers.get('set-cookie')];
    this.#cookie = cookies.filter(Boolean).map((cookie) => cookie.split(';')[0]).join('; ');
  }

  get = async (caminho) => (await this.#pedir('GET', caminho)).conteudo;
  post = async (caminho, corpo) => (await this.#pedir('POST', caminho, corpo)).conteudo;
  put = async (caminho, corpo) => (await this.#pedir('PUT', caminho, corpo)).conteudo;

  /** Uma escrita guardada pela versão do recurso (ADR-0008 §3): lê o ETag de `recurso` e o manda em `If-Match`. */
  async comVersao(metodo, recurso, caminho, corpo) {
    const { resposta } = await this.#pedir('GET', recurso);
    return (await this.#pedir(metodo, caminho, corpo, { 'If-Match': resposta.headers.get('etag') })).conteudo;
  }

  /** Envia um arquivo pendente (ADR-0014 §4.3), para um campo `file` usá-lo depois. */
  async enviarArquivo(nome, tipo, bytes, chave) {
    const corpo = new FormData();
    corpo.append('file', new Blob([bytes], { type: tipo }), nome);
    const headers = { 'Idempotency-Key': chave };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.origem) headers.Origin = this.origem;
    if (this.#cookie) headers.Cookie = this.#cookie;
    const resposta = await this.fetch(`${this.base}/api/files`, { method: 'POST', headers, body: corpo });
    const conteudo = await lerCorpo(resposta);
    if (!resposta.ok) throw new ErroDaApi('POST', '/api/files', resposta.status, conteudo);
    return conteudo;
  }

  /** Um comando de instância ou tarefa, com a sua `Idempotency-Key`. */
  async comando(caminho, corpo, chave) {
    return (await this.#pedir('POST', caminho, corpo, { 'Idempotency-Key': chave })).conteudo;
  }
}
