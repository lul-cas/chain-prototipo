import { AutomationDocument } from './automation-document';

/**
 * The control a problem's `path` names (automation-ui.md §8.2): the path itself when a control has it, as for a query or
 * header row whose name holds dots; otherwise the path cut from its end, a `.name` or an `[n]` at a time, until one does.
 * Null for a problem without a path (AU000) or one that no control holds.
 */
export function controlFor(path: string | null, controls: ReadonlySet<string>): string | null {
  for (let candidate: string | null = path; candidate !== null && candidate !== ''; candidate = cut(candidate)) {
    if (controls.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function cut(path: string): string | null {
  const match = /^(.*?)(\.[^.[\]]*|\[\d+\])$/.exec(path);
  return match ? match[1] : null;
}

/** Every control the sections draw for a document, by the path its problems use (automation-ui.md §8.2). */
export function controlsOf(document: AutomationDocument): Set<string> {
  const request = document.request;
  return new Set([
    'inputs',
    'outputs',
    'request',
    'request.destination',
    'request.method',
    'request.path',
    'request.headers',
    'request.auth',
    'request.body',
    'response.type',
    'execution.timeoutSeconds',
    'execution.retry.maxAttempts',
    'execution.retry.initialDelaySeconds',
    'execution.idempotency.mode',
    'execution.redirects.max',
    ...(document.execution.idempotency.mode === 'header' ? ['execution.idempotency.header'] : []),
    ...(request.host !== undefined ? ['request.host'] : []),
    ...document.inputs.flatMap((_, i) => [`inputs[${i}].key`, `inputs[${i}].type`]),
    ...document.outputs.flatMap((_, i) => [`outputs[${i}].key`, `outputs[${i}].source`, `outputs[${i}].path`, `outputs[${i}].type`]),
    ...Object.keys(request.query).map((name) => `request.query.${name}`),
    ...Object.keys(request.headers).map((name) => `request.headers.${name}`),
    ...(request.auth?.type === 'basic' ? ['request.auth.username', 'request.auth.password'] : []),
    ...(request.body?.keys ?? []).map((_, i) => `request.body.keys[${i}]`),
  ]);
}
