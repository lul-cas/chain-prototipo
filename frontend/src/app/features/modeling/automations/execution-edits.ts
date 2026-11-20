import { readDocument } from './automation-document';
import { DOCUMENT_ORDER, EditorDraft, withMember } from './automation-edits';

/** What a control of *Execução* changes (automation-ui.md §7.5). */
export interface ExecutionChange {
  readonly timeoutSeconds?: number;
  readonly maxAttempts?: number;
  readonly initialDelaySeconds?: number;
  /** *Enviar no cabeçalho* with its name, or *Não enviar*, which leaves no header in the document. */
  readonly idempotency?: { readonly mode: 'header'; readonly header: string } | { readonly mode: 'none' };
  /** *Não seguir* is `follow: false` with `max: 0` (AU011). */
  readonly redirects?: { readonly follow: boolean; readonly max: number };
}

/**
 * Writes the whole `execution` object, with every value explicit (§7.5): the values the draft has, its defaults for the
 * absent ones, and the change. The same draft when that is what it already holds.
 */
export function setExecution(draft: EditorDraft, change: ExecutionChange): EditorDraft {
  const current = readDocument(draft.json).execution;
  const idempotency = current.idempotency.mode === 'header' ? { mode: 'header', header: current.idempotency.header ?? 'Idempotency-Key' } : { ...current.idempotency };
  const execution = {
    timeoutSeconds: change.timeoutSeconds ?? current.timeoutSeconds,
    retry: { maxAttempts: change.maxAttempts ?? current.retry.maxAttempts, initialDelaySeconds: change.initialDelaySeconds ?? current.retry.initialDelaySeconds },
    idempotency: change.idempotency ?? idempotency,
    redirects: change.redirects ?? { follow: current.redirects.follow, max: current.redirects.max },
  };
  return JSON.stringify(draft.json['execution']) === JSON.stringify(execution) ? draft : { ...draft, json: withMember(draft.json, 'execution', execution, DOCUMENT_ORDER) };
}
