import { AutomationDocument } from './automation-document';

/** A destination as `/resources` gives it to Modelers (automation-ui.md §1.1). */
export interface PreviewDestination {
  readonly scheme: string;
  readonly host: string;
  readonly port: number | null;
}

/**
 * The call as .NET builds it (automation-contract.md §3), with the inputs left as `{chave}` (automation-ui.md §7.6):
 * - the query parameters, then the headers, in ordinal order of name, with literal query names and values percent-encoded;
 * - a JSON body adds `Content-Type: application/json` unless a header sets it;
 * - then basic authentication and the idempotency header, without values;
 * - then the JSON body, its keys in the order of `body.keys` or of the inputs.
 */
export function callPreview(document: AutomationDocument, destination: PreviewDestination | null): string {
  const request = document.request;
  const origin = destination ? originOf(destination, request.host) : '(destino)';
  const query = Object.keys(request.query)
    .sort(ordinal)
    .map((name) => `${encode(name)}=${queryValue(request.query[name])}`);
  const headers: [string, string][] = Object.entries(request.headers);
  const jsonBody = request.body?.type === 'json';
  if (jsonBody && !headers.some(([name]) => name.toLowerCase() === 'content-type')) {
    headers.push(['Content-Type', 'application/json']);
  }
  headers.sort(([a], [b]) => ordinal(a, b));
  if (request.auth?.type === 'basic') {
    headers.push(['Authorization', 'Basic (usuário e senha)']);
  }
  if (document.execution.idempotency.mode === 'header') {
    headers.push([document.execution.idempotency.header ?? 'Idempotency-Key', '(chave desta execução)']);
  }
  const lines = [`${request.method} ${origin}${request.path}${query.length > 0 ? `?${query.join('&')}` : ''}`, ...headers.map(([name, value]) => `${name}: ${value}`)];
  if (jsonBody) {
    const keys = request.body?.keys ?? document.inputs.map((input) => input.key);
    lines.push('', `{${keys.map((key) => `${JSON.stringify(key)}: {${key}}`).join(', ')}}`);
  }
  return lines.join('\n');
}

/** The host is `request.host` when set (wildcard destinations); the port only when it isn't the scheme's default. */
function originOf(destination: PreviewDestination, host: string | undefined): string {
  const defaultPort = destination.scheme === 'https' ? 443 : 80;
  const port = destination.port !== null && destination.port !== defaultPort ? `:${destination.port}` : '';
  return `${destination.scheme}://${host ?? destination.host}${port}`;
}

/** A value that is exactly `{key}` is an input, shown as it is; a literal is percent-encoded. */
function queryValue(value: string): string {
  return /^\{[^{}]+\}$/.test(value) ? value : encode(value);
}

/** RFC 3986: every byte but the unreserved characters, as .NET encodes it. */
function encode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Ordinal order, by UTF-16 code unit, as .NET's `StringComparer.Ordinal` sorts. */
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
