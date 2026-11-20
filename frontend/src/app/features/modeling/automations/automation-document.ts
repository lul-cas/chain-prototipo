/** The automation document of automation.md §5.2 (`schemaVersion: 1`, `kind: "http"`), as the editor reads it. */
export interface AutomationField {
  readonly key: string;
  readonly type: string;
  readonly required: boolean;
}

export interface AutomationOutput extends AutomationField {
  readonly source: string;
  readonly path?: readonly (string | number)[];
}

export interface BasicAuth {
  readonly type: string;
  readonly username?: string;
  readonly password?: string;
}

export interface AutomationRequest {
  readonly method: string;
  readonly destination: string;
  readonly host?: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly auth: BasicAuth | null;
  readonly body: { readonly type: string; readonly keys?: readonly string[] } | null;
}

export interface Execution {
  readonly timeoutSeconds: number;
  readonly retry: { readonly maxAttempts: number; readonly initialDelaySeconds: number };
  readonly idempotency: { readonly mode: string; readonly header?: string };
  readonly redirects: { readonly follow: boolean; readonly max: number };
}

export interface AutomationDocument {
  readonly inputs: readonly AutomationField[];
  readonly request: AutomationRequest;
  readonly response: { readonly type: string };
  readonly outputs: readonly AutomationOutput[];
  readonly execution: Execution;
}

/** The defaults of automation.md §5.2; absent settings show them (automation-ui.md §7.5). */
export const DEFAULT_EXECUTION: Execution = {
  timeoutSeconds: 30,
  retry: { maxAttempts: 5, initialDelaySeconds: 5 },
  idempotency: { mode: 'header', header: 'Idempotency-Key' },
  redirects: { follow: false, max: 0 },
};

export const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The saved draft as the editor draws it. The server parsed it (AU000), so its shape holds; what is absent takes its default.
 * Values no control offers stay as they are, for the sections to flag (automation-ui.md §7.7).
 */
export function readDocument(draft: unknown): AutomationDocument {
  const json = object(draft);
  const request = object(json['request']);
  const execution = object(json['execution']);
  const retry = object(execution['retry']);
  const idempotency = object(execution['idempotency']);
  const redirects = object(execution['redirects']);
  const auth = request['auth'];
  const body = request['body'];
  return {
    inputs: list(json['inputs']).map((input) => ({ key: text(input['key']), type: text(input['type']), required: input['required'] === true })),
    request: {
      method: text(request['method']),
      destination: text(request['destination']),
      ...(typeof request['host'] === 'string' ? { host: request['host'] } : {}),
      path: text(request['path']),
      query: strings(request['query']),
      headers: strings(request['headers']),
      auth: auth && typeof auth === 'object' ? (auth as BasicAuth) : null,
      body: body && typeof body === 'object' ? (body as AutomationRequest['body']) : null,
    },
    response: { type: typeof object(json['response'])['type'] === 'string' ? (object(json['response'])['type'] as string) : 'none' },
    outputs: list(json['outputs']).map((output) => ({
      key: text(output['key']),
      type: text(output['type']),
      required: output['required'] === true,
      source: text(output['source']),
      ...(Array.isArray(output['path']) ? { path: output['path'] as (string | number)[] } : {}),
    })),
    execution: {
      timeoutSeconds: number(execution['timeoutSeconds'], DEFAULT_EXECUTION.timeoutSeconds),
      retry: {
        maxAttempts: number(retry['maxAttempts'], DEFAULT_EXECUTION.retry.maxAttempts),
        initialDelaySeconds: number(retry['initialDelaySeconds'], DEFAULT_EXECUTION.retry.initialDelaySeconds),
      },
      idempotency: typeof idempotency['mode'] === 'string' ? (idempotency as Execution['idempotency']) : DEFAULT_EXECUTION.idempotency,
      redirects: { follow: redirects['follow'] === true, max: number(redirects['max'], 0) },
    },
  };
}

/** Where an input is used (automation-ui.md §7.2): in the path, the query or the body, or nowhere in the call. */
export function inputUsage(document: AutomationDocument, key: string): string {
  if (key === '') {
    return 'não usada na chamada';
  }
  const request = document.request;
  const placeholder = `{${key}}`;
  const body = request.body?.type === 'json' && (request.body.keys ?? document.inputs.map((input) => input.key)).includes(key);
  const places = [
    request.path.includes(placeholder) ? 'no caminho' : null,
    Object.values(request.query).includes(placeholder) ? 'na consulta' : null,
    body ? 'no corpo' : null,
  ].filter((place): place is string => place !== null);
  return places.length > 0 ? places.join(', ') : 'não usada na chamada';
}

/**
 * The step's deadline after dispatch, in whole seconds (automation.md §8.2): every attempt's time limit, the waits between
 * them (each at least 60 s), and 10 minutes.
 */
export function deadlineSeconds(execution: Execution): number {
  const attempts = execution.retry.maxAttempts;
  let waits = 0;
  for (let n = 1; n < attempts; n++) {
    const delay = Math.min(execution.retry.initialDelaySeconds * 2 ** (n - 1), 300);
    waits += Math.max(1.1 * delay, 60);
  }
  return Math.floor(attempts * execution.timeoutSeconds + waits + 600);
}

/** "16 min 30 s", "1 h 2 min", "45 s". */
export function durationText(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', rest || (!hours && !minutes) ? `${rest} s` : ''].filter(Boolean).join(' ');
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).map(([name, item]) => [name, text(item)]));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}
