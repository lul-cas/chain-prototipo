import { isValidHost } from '../../../core/text/host-name';
import { AutomationResources } from '../automations-api';
import { typeLabel } from '../editor/type-labels';
import { LocalProblem, isKey } from './automation-checks';
import { AutomationDocument, AutomationRequest, METHODS } from './automation-document';

const MAX_PATH_LENGTH = 2000;
const MAX_QUERY_NAME_LENGTH = 100;
const SECRET_OPENING = '{{secret:';
const SCALAR_TYPES = ['text', 'number', 'boolean', 'date', 'datetime', 'time'];
/** Braces around a key-shaped name: template syntax (AutomationRules.InputReference). */
const INPUT_REFERENCE = /\{[a-zA-Z][a-zA-Z0-9_]{0,63}\}/;
const WHOLE_TEMPLATE = /^\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}$/;
/** C0, DEL and C1, as .NET's `char.IsControl` reads them. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HEX = /^[0-9A-Fa-f]$/;
const MAX_HEADERS = 30;
/** An RFC 9110 token: one or more `tchar`. */
const TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
/** What the HTTP client sends as a header value: visible ASCII, spaces and tabs (automation-contract.md §3). */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
/** Set by the HTTP client, never by a definition (AU006); `Proxy-*` too. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer']);
const PLACEHOLDER = /\{\{secret:([a-z0-9][a-z0-9_.-]{0,63})\}\}/g;
const PLACEHOLDER_AT = /^\{\{secret:[a-z0-9][a-z0-9_.-]{0,63}\}\}/;
const ELSEWHERE = 'Credenciais só vão em valores de cabeçalho e na autenticação básica.';
/** The headers ADR-0012 Part 3 §3 treats as credentials (AU013). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'x-api-key']);
const LITERAL = 'Este valor fica visível para quem modela, nas versões publicadas e nos pedidos de execução. Use uma credencial.';
const SCALARS_TEXT = 'texto, número, sim ou não, data, data e hora ou hora';

/**
 * The local checks of the call (automation-ui.md §7.9), as `AutomationRules` finds them and in its order: AU003 to AU009,
 * then, once `/resources` has loaded, AU101 to AU103, AU105 and AU106. Each has the server's code and its cause in pt-BR, at
 * the server's path, but for AU102 and AU103: the server names only `request`, and these name each field that holds the
 * credential. AU104 is the server's alone: `/resources` doesn't say which destinations take credentials over http.
 */
export function callProblems(document: AutomationDocument, resources: AutomationResources | null): LocalProblem[] {
  const problems: LocalProblem[] = [];
  const inputs = inputTypes(document);
  checkMethod(document.request, problems);
  checkPath(document.request.path, inputs, problems);
  checkQuery(document.request.query, inputs, problems);
  checkHeaders(document, problems);
  checkPlaceholders(document, problems);
  checkAuth(document.request, problems);
  checkLiteralCredentials(document.request, problems);
  checkBody(document.request.body, inputs, problems);
  if (resources !== null) {
    checkReferences(document, resources, problems);
  }
  return problems;
}

/** The type of each well-formed input key, first occurrence first (AutomationRules.CheckFields). */
function inputTypes(document: AutomationDocument): Map<string, string> {
  const types = new Map<string, string>();
  for (const { key, type } of document.inputs) {
    if (isKey(key) && !types.has(key)) {
      types.set(key, type);
    }
  }
  return types;
}

function checkMethod(request: AutomationRequest, problems: LocalProblem[]): void {
  if (!METHODS.includes(request.method)) {
    problems.push({ code: 'AU003', path: 'request.method', text: 'O método é GET, POST, PUT, PATCH ou DELETE.' });
  } else if ((request.method === 'GET' || request.method === 'DELETE') && request.body !== null) {
    problems.push({ code: 'AU003', path: 'request.body', text: 'GET e DELETE não têm corpo.' });
  }
}

/** AU004, as `AutomationRules.CheckPath` reads the path: it stops at the first character or brace it can't read. */
function checkPath(path: string, inputs: Map<string, string>, problems: LocalProblem[]): void {
  const fail = (text: string) => problems.push({ code: 'AU004', path: 'request.path', text });
  if (!path.startsWith('/') || path.length > MAX_PATH_LENGTH) {
    fail(`O caminho começa com / e tem no máximo ${MAX_PATH_LENGTH} caracteres.`);
  }
  if (path.split('/').includes('..')) {
    fail("O caminho não pode ter um trecho '..'.");
  }
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '{') {
      const end = path.indexOf('}', i + 1);
      const key = end < 0 ? null : path.slice(i + 1, end);
      if (key === null || !isKey(key)) {
        fail('Chaves no caminho envolvem a chave de uma entrada, como {cpf}.');
        return;
      }
      checkTemplate(key, inputs, 'AU004', 'request.path', 'no caminho', problems);
      i = end;
    } else if (c === '%') {
      if (i + 2 >= path.length || !HEX.test(path[i + 1]) || !HEX.test(path[i + 2])) {
        fail('Um % no caminho começa um byte codificado, como %20.');
        return;
      }
      if (['2E', '2F', '5C'].includes(path.slice(i + 1, i + 3).toUpperCase())) {
        fail("O caminho não pode codificar '.', '/' ou '\\'.");
        return;
      }
      i += 2;
    } else if (!isPathCharacter(c)) {
      fail(
        c === '?'
          ? "O caminho não tem '?': use os parâmetros da consulta."
          : c === '#'
            ? "O caminho não tem '#'."
            : CONTROL.test(c)
              ? 'O caminho não pode ter caracteres de controle.'
              : `'${textElementAt(path, i)}' não pode aparecer no caminho: codifique-o (RFC 3986).`,
      );
      return;
    }
  }
}

/** RFC 3986 `pchar` or `/`, without the percent sign: unreserved, sub-delims, ':' and '@'. */
function isPathCharacter(c: string): boolean {
  return /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/.test(c);
}

/** The text element (grapheme cluster) that holds `text[index]`, so a message quotes a character whole (#127). */
function textElementAt(text: string, index: number): string {
  for (const { segment, index: start } of new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(text)) {
    if (index < start + segment.length) {
      return segment;
    }
  }
  return text[index];
}

/** A `{key}` template names a scalar input (AU004, AU005). */
function checkTemplate(key: string, inputs: Map<string, string>, code: string, at: string, where: string, problems: LocalProblem[]): void {
  const type = inputs.get(key);
  if (type === undefined) {
    problems.push({ code, path: at, text: `{${key}} não é uma entrada.` });
  } else if (!SCALAR_TYPES.includes(type)) {
    problems.push({ code, path: at, text: `{${key}} é uma entrada do tipo ${typeLabel(type)}: ${where} só cabem entradas de ${SCALARS_TEXT}.` });
  }
}

/** AU005: a value is literal text or exactly one `{key}`; braces around a key anywhere else are ambiguous. */
function checkQuery(query: Readonly<Record<string, string>>, inputs: Map<string, string>, problems: LocalProblem[]): void {
  for (const [name, value] of Object.entries(query)) {
    const at = `request.query.${name}`;
    if (name.length === 0 || name.length > MAX_QUERY_NAME_LENGTH) {
      problems.push({ code: 'AU005', path: at, text: `O nome de um parâmetro tem de 1 a ${MAX_QUERY_NAME_LENGTH} caracteres.`, part: 'name' });
    }
    if (name.includes(SECRET_OPENING) || value.includes(SECRET_OPENING)) {
      problems.push({ code: 'AU005', path: at, text: 'Credenciais não vão na consulta.', ...(value.includes(SECRET_OPENING) ? {} : { part: 'name' as const }) });
    }
    const template = WHOLE_TEMPLATE.exec(value);
    if (template !== null) {
      checkTemplate(template[1], inputs, 'AU005', at, 'na consulta', problems);
    } else if (INPUT_REFERENCE.test(value)) {
      problems.push({ code: 'AU005', path: at, text: 'O valor é um texto fixo ou exatamente uma {entrada}.' });
    }
  }
}

/** AU006. Names are also unique ignoring case, since HTTP header names are case-insensitive. */
function checkHeaders(document: AutomationDocument, problems: LocalProblem[]): void {
  const headers = Object.entries(document.request.headers);
  if (headers.length > MAX_HEADERS) {
    problems.push({ code: 'AU006', path: 'request.headers', text: `Uma automação envia no máximo ${MAX_HEADERS} cabeçalhos.` });
  }
  const idempotency = document.execution.idempotency;
  const idempotencyHeader = idempotency.mode === 'header' ? (idempotency.header ?? 'Idempotency-Key').toLowerCase() : null;
  const seen = new Set<string>();
  for (const [name, value] of headers) {
    const at = `request.headers.${name}`;
    const lower = name.toLowerCase();
    if (!TOKEN.test(name)) {
      problems.push({ code: 'AU006', path: at, text: "O nome de um cabeçalho é um token HTTP (RFC 9110): letras, dígitos e !#$%&'*+-.^_`|~.", part: 'name' });
    } else if (RESERVED_HEADERS.has(lower) || lower.startsWith('proxy-')) {
      problems.push({ code: 'AU006', path: at, text: `O cliente HTTP define ${name}; uma automação não pode.`, part: 'name' });
    } else if (lower === idempotencyHeader) {
      problems.push({ code: 'AU006', path: at, text: `${name} leva a chave de idempotência (Execução).`, part: 'name' });
    }
    if (seen.has(lower)) {
      problems.push({ code: 'AU006', path: at, text: `O cabeçalho ${name} aparece mais de uma vez.`, part: 'name' });
    }
    seen.add(lower);
    if (!HEADER_VALUE.test(value)) {
      problems.push({ code: 'AU006', path: at, text: 'O valor de um cabeçalho só tem caracteres ASCII visíveis, espaços e tabulações (RFC 9110).' });
    }
    if (INPUT_REFERENCE.test(value)) {
      problems.push({ code: 'AU006', path: at, text: 'Entradas não vão em cabeçalhos nesta versão.' });
    }
  }
}

/** AU007: placeholders are complete, and only in header values and basic-auth fields. */
function checkPlaceholders(document: AutomationDocument, problems: LocalProblem[]): void {
  for (const [name, value] of Object.entries(document.request.headers)) {
    checkPlaceholderSyntax(value, `request.headers.${name}`, problems);
  }
  const auth = document.request.auth;
  if (auth !== null) {
    checkPlaceholderSyntax(auth.username ?? '', 'request.auth.username', problems);
    checkPlaceholderSyntax(auth.password ?? '', 'request.auth.password', problems);
  }
  findPlaceholdersElsewhere(document, '', problems);
}

function checkPlaceholderSyntax(text: string, at: string, problems: LocalProblem[]): void {
  for (let start = text.indexOf(SECRET_OPENING); start >= 0; start = text.indexOf(SECRET_OPENING, start)) {
    const placeholder = PLACEHOLDER_AT.exec(text.slice(start));
    if (placeholder === null) {
      problems.push({ code: 'AU007', path: at, text: 'Escreva uma credencial como {{secret:nome}}, com o nome de uma credencial.' });
      return;
    }
    start += placeholder[0].length;
  }
}

/** Every name and text of the document, by path, as `AutomationRules.FindPlaceholdersElsewhere` walks it. */
function findPlaceholdersElsewhere(node: unknown, at: string, problems: LocalProblem[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => findPlaceholdersElsewhere(item, `${at}[${i}]`, problems));
  } else if (typeof node === 'object' && node !== null) {
    for (const [name, value] of Object.entries(node)) {
      const child = at === '' ? name : `${at}.${name}`;
      if (name.includes(SECRET_OPENING)) {
        problems.push({ code: 'AU007', path: child, text: ELSEWHERE, part: 'name' });
      }
      findPlaceholdersElsewhere(value, child, problems);
    }
  } else if (typeof node === 'string' && node.includes(SECRET_OPENING) && !allowsSecrets(at)) {
    problems.push({ code: 'AU007', path: at, text: ELSEWHERE });
  }
}

function allowsSecrets(at: string): boolean {
  return at === 'request.auth.username' || at === 'request.auth.password' || at.startsWith('request.headers.');
}

/**
 * AU008: basic, with a username and a password. Servers split the credentials at the first ':' (RFC 7617), so the username
 * has none but a placeholder's; neither has a control character (card #128); and `auth` beside an `Authorization` header
 * would send two credentials.
 */
function checkAuth(request: AutomationRequest, problems: LocalProblem[]): void {
  const auth = request.auth;
  if (auth === null) {
    return;
  }
  const username = auth.username ?? '';
  const password = auth.password ?? '';
  if (auth.type !== 'basic') {
    problems.push({ code: 'AU008', path: 'request.auth.type', text: 'A autenticação é básica.' });
  }
  if (username === '' || password === '') {
    problems.push({ code: 'AU008', path: 'request.auth', text: 'A autenticação básica tem usuário e senha.' });
  }
  if (username.split(SECRET_OPENING).join('').includes(':')) {
    problems.push({ code: 'AU008', path: 'request.auth.username', text: "O usuário não pode ter ':' (RFC 7617)." });
  }
  if (CONTROL.test(username)) {
    problems.push({ code: 'AU008', path: 'request.auth.username', text: 'O usuário não pode ter caracteres de controle (RFC 7617).' });
  }
  if (CONTROL.test(password)) {
    problems.push({ code: 'AU008', path: 'request.auth.password', text: 'A senha não pode ter caracteres de controle (RFC 7617).' });
  }
  if (Object.keys(request.headers).some((name) => name.toLowerCase() === 'authorization')) {
    problems.push({ code: 'AU008', path: 'request.auth', text: 'Use a autenticação básica ou um cabeçalho Authorization, não os dois.' });
  }
}

/**
 * AU013 (owner decision Q-AS4 (c), card #235): a password, and the value of a header that carries credentials, hold a
 * `{{secret:` placeholder. A malformed one is AU007's alone, and an empty password AU008's.
 */
function checkLiteralCredentials(request: AutomationRequest, problems: LocalProblem[]): void {
  for (const [name, value] of Object.entries(request.headers)) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase()) && !value.includes(SECRET_OPENING)) {
      problems.push({ code: 'AU013', path: `request.headers.${name}`, text: LITERAL });
    }
  }
  const password = request.auth?.password ?? '';
  if (password !== '' && !password.includes(SECRET_OPENING)) {
    problems.push({ code: 'AU013', path: 'request.auth.password', text: LITERAL });
  }
}

function checkBody(body: AutomationRequest['body'], inputs: Map<string, string>, problems: LocalProblem[]): void {
  if (body === null) {
    return;
  }
  if (body.type !== 'json') {
    problems.push({ code: 'AU009', path: 'request.body.type', text: 'O corpo é JSON.' });
  }
  const seen = new Set<string>();
  (body.keys ?? []).forEach((key, i) => {
    const at = `request.body.keys[${i}]`;
    if (!inputs.has(key)) {
      problems.push({ code: 'AU009', path: at, text: `${key} não é uma entrada.` });
    } else if (seen.has(key)) {
      problems.push({ code: 'AU009', path: at, text: `${key} aparece mais de uma vez.` });
    } else {
      seen.add(key);
    }
  });
}

/** AU101 to AU103, AU105 and AU106 against what `/resources` says (AutomationRules.CheckReferences); without a destination, AU102. */
function checkReferences(document: AutomationDocument, resources: AutomationResources, problems: LocalProblem[]): void {
  const name = document.request.destination;
  const destination = resources.destinations.find((candidate) => candidate.name === name);
  if (destination === undefined) {
    problems.push({ code: 'AU101', path: 'request.destination', text: name === '' ? 'Escolha um destino.' : `O destino ${name} não existe mais.` });
  }
  for (const [at, text] of credentialFields(document.request)) {
    for (const secret of new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1]))) {
      const known = resources.secrets.find((candidate) => candidate.name === secret);
      if (known === undefined) {
        problems.push({ code: 'AU102', path: at, text: `A credencial ${secret} não existe.` });
      } else if (destination !== undefined && !known.allowedDestinations.includes(name)) {
        problems.push({ code: 'AU103', path: at, text: `A credencial ${secret} não permite o destino ${name}.` });
      }
    }
  }
  if (destination === undefined) {
    return;
  }
  if (!withinPrefix(document.request.path, destination.pathPrefix)) {
    problems.push({ code: 'AU105', path: 'request.path', text: `O caminho precisa ficar dentro de ${destination.pathPrefix}, o prefixo do destino.` });
  }
  checkHost(document.request.host, destination.host, problems);
}

/** The fields that may hold credentials, by path: each header value, and the username and password of basic authentication. */
export function credentialFields(request: AutomationRequest): [string, string][] {
  return [
    ...Object.entries(request.headers).map(([name, value]): [string, string] => [`request.headers.${name}`, value]),
    ...(request.auth === null
      ? []
      : ([
          ['request.auth.username', request.auth.username ?? ''],
          ['request.auth.password', request.auth.password ?? ''],
        ] as [string, string][])),
  ];
}

/**
 * AU105: the path equals the prefix (with or without its final '/'), or its literal text before the first '{' continues the
 * prefix after a '/'. A prefix of "/" admits every path.
 */
function withinPrefix(path: string, prefix: string | null): boolean {
  const root = prefix?.replace(/\/+$/, '');
  if (!root) {
    return true;
  }
  const brace = path.indexOf('{');
  const literal = brace < 0 ? path : path.slice(0, brace);
  return path === prefix || path === root || literal.startsWith(`${root}/`);
}

/** AU106: a wildcard destination needs a proper subdomain it matches; an exact one takes no host or its own. */
function checkHost(host: string | undefined, destinationHost: string, problems: LocalProblem[]): void {
  if (destinationHost.startsWith('*.')) {
    const suffix = destinationHost.slice(1);
    if (host === undefined || host.startsWith('*') || !isValidHost(host) || !host.endsWith(suffix)) {
      problems.push({ code: 'AU106', path: 'request.host', text: `O destino cobre ${destinationHost}: informe um dos seus subdomínios como host.` });
    }
  } else if (host !== undefined && host !== destinationHost) {
    problems.push({ code: 'AU106', path: 'request.host', text: `O host é o do destino, ${destinationHost}, ou nenhum.` });
  }
}
