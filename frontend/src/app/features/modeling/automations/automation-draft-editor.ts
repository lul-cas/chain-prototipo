import { Injectable, computed, signal } from '@angular/core';
import { typeLabel } from '../editor/type-labels';
import { MAX_INPUTS } from './automation-checks';
import { EditorDraft, addInput, fromDraft, inputsOf, moveInput, removeInput, requestOf, setInputKey, setInputRequired, setInputType } from './automation-edits';
import {
  AuthKind,
  BodyKind,
  DestinationView,
  MAX_HEADERS,
  addHeaderRow,
  addQueryRow,
  removeHeaderRow,
  removeQueryRow,
  setAuth,
  setAuthField,
  setBody,
  setBodyKey,
  setDestination,
  setHost,
  setMethod,
  setHeaderName,
  setHeaderValue,
  setPath,
  setQueryName,
  setQueryValue,
} from './call-edits';
import {
  MAX_OUTPUTS,
  OutputSource,
  addOutput,
  moveOutput,
  outputsOf,
  removeOutput,
  setOutputKey,
  setOutputPath,
  setOutputRequired,
  setOutputSource,
  setOutputType,
  setResponseType,
} from './output-edits';
import { PathSegment, formatPath } from './output-path';
import { ExecutionChange, setExecution } from './execution-edits';

const HISTORY_LIMIT = 200;
const BODY_NAMES: Readonly<Record<BodyKind, string>> = { none: 'sem corpo', all: 'JSON com todas as entradas', some: 'JSON com só estas entradas' };
const EMPTY: EditorDraft = { json: {}, inputIds: [], outputIds: [], query: [], headers: [] };

/**
 * The automation editor's state (automation-ui.md §5.4, ADR-0010 D3), as the form designer's `FormDraftEditor` holds its own:
 * the draft with in-memory ids, undo and redo up to 200 steps, and whether there is something to save. The edits are the pure
 * functions of `automation-edits.ts`, by id. Each change, or why one was refused, is in `notice`, for the status line (§7.1).
 */
@Injectable()
export class AutomationDraftEditor {
  private readonly current = signal<EditorDraft>(EMPTY);
  private readonly saved = signal<EditorDraft>(EMPTY);
  private readonly past = signal<readonly EditorDraft[]>([]);
  private readonly future = signal<readonly EditorDraft[]>([]);
  private readonly message = signal<string | null>(null);
  private loadedKeys = new Map<string, string>();
  private ids = 0;

  readonly draft = this.current.asReadonly();
  readonly notice = this.message.asReadonly();
  readonly dirty = computed(() => this.current() !== this.saved());
  readonly canUndo = computed(() => this.past().length > 0);
  readonly canRedo = computed(() => this.future().length > 0);

  /** Starts over with a draft as the server has it. */
  load(json: unknown): void {
    const loaded = fromDraft(json, () => `row-${++this.ids}`);
    this.loadedKeys = new Map(loaded.inputIds.map((id, i) => [id, String(inputsOf(loaded.json)[i]['key'])]));
    this.current.set(loaded);
    this.saved.set(loaded);
    this.past.set([]);
    this.future.set([]);
    this.message.set(null);
  }

  /** The server now has this draft, the one that was sent: edits made while it was saving stay unsaved. */
  markSaved(sent: EditorDraft): void {
    this.saved.set(sent);
  }

  /** Back to the saved draft. The page asks first (§8.1). */
  discard(): void {
    this.current.set(this.saved());
    this.past.set([]);
    this.future.set([]);
    this.message.set(null);
  }

  undo(): void {
    const past = this.past();
    if (past.length === 0) {
      return;
    }
    this.future.update((future) => [this.current(), ...future]);
    this.past.set(past.slice(0, -1));
    this.current.set(past[past.length - 1]);
    this.message.set('Alteração desfeita.');
  }

  redo(): void {
    const [next, ...future] = this.future();
    if (!next) {
      return;
    }
    this.past.update((past) => [...past, this.current()]);
    this.future.set(future);
    this.current.set(next);
    this.message.set('Alteração refeita.');
  }

  /** Says why a change wasn't made, for the status line; the draft stays as it is. */
  refuse(message: string): void {
    this.message.set(message);
  }

  /** The key an input had when the draft was opened; undefined for one added since (the rename warning, §7.2). */
  keyAtLoad(id: string): string | undefined {
    return this.loadedKeys.get(id);
  }

  /** Adds an input at the end and returns its id; null at the limit (§7.2). */
  addInput(): string | null {
    const id = `row-${++this.ids}`;
    const added = addInput(this.current(), id);
    if (added === null) {
      this.message.set(`Uma automação tem no máximo ${MAX_INPUTS} entradas.`);
      return null;
    }
    this.apply(added, 'Entrada adicionada.');
    return id;
  }

  removeInput(id: string): void {
    this.at(id, (index, key) => this.apply(removeInput(this.current(), index), key ? `Entrada removida: ${key}.` : 'Entrada removida.'));
  }

  moveInput(id: string, by: -1 | 1): void {
    this.at(id, (index, key) => {
      const moved = moveInput(this.current(), index, by);
      if (moved !== null) {
        this.apply(moved, `Entrada movida para ${by < 0 ? 'cima' : 'baixo'}${key ? `: ${key}` : ''}.`);
      }
    });
  }

  setInputKey(id: string, key: string): void {
    this.at(id, (index) => {
      const { draft, places } = setInputKey(this.current(), index, key);
      const also = places.length > 0 ? `, também ${list(places)}` : '';
      this.apply(draft, key === '' ? 'Chave apagada.' : `Chave alterada para ${key}${also}.`);
    });
  }

  setInputType(id: string, type: string): void {
    this.at(id, (index, key) => this.apply(setInputType(this.current(), index, type), `Tipo${key ? ` de ${key}` : ''}: ${typeLabel(type)}.`));
  }

  setInputRequired(id: string, required: boolean): void {
    this.at(id, (index, key) =>
      this.apply(setInputRequired(this.current(), index, required), `Entrada${key ? ` ${key}` : ''} ${required ? 'obrigatória' : 'opcional'}.`),
    );
  }

  setMethod(method: string): void {
    this.apply(setMethod(this.current(), method), `Método: ${method}.`);
  }

  /** Destino (§7.3), with the path set to its prefix while the path is still `/`. */
  setDestination(name: string, destination: DestinationView | null): void {
    const before = requestOf(this.current().json)['path'];
    const next = setDestination(this.current(), name, destination);
    const path = requestOf(next.json)['path'];
    this.apply(next, `Destino: ${name}.${path !== before ? ` O caminho passou a ser ${path}, o prefixo do destino.` : ''}`);
  }

  setHost(host: string): void {
    this.apply(setHost(this.current(), host), host === '' ? 'Host removido.' : `Host: ${host}.`);
  }

  setPath(path: string): void {
    this.apply(setPath(this.current(), path), `Caminho: ${path}.`);
  }

  /** Adds a query row and returns its id (§7.3). */
  addQueryRow(): string {
    const id = `row-${++this.ids}`;
    this.apply(addQueryRow(this.current(), id), 'Parâmetro adicionado.');
    return id;
  }

  removeQueryRow(id: string): void {
    const name = this.current().query.find((row) => row.id === id)?.name;
    this.apply(removeQueryRow(this.current(), id), name ? `Parâmetro removido: ${name}.` : 'Parâmetro removido.');
  }

  setQueryName(id: string, name: string): void {
    this.apply(setQueryName(this.current(), id, name), name === '' ? 'Nome do parâmetro apagado.' : `Nome do parâmetro: ${name}.`);
  }

  setQueryValue(id: string, value: string): void {
    const name = this.current().query.find((row) => row.id === id)?.name;
    this.apply(setQueryValue(this.current(), id, value), `Valor${name ? ` de ${name}` : ''}: ${value === '' ? 'vazio' : value}.`);
  }

  /** Adds a header row and returns its id; null at the limit of 30 (AU006). */
  addHeaderRow(): string | null {
    const id = `row-${++this.ids}`;
    const added = addHeaderRow(this.current(), id);
    if (added === null) {
      this.message.set(`Uma automação envia no máximo ${MAX_HEADERS} cabeçalhos.`);
      return null;
    }
    this.apply(added, 'Cabeçalho adicionado.');
    return id;
  }

  removeHeaderRow(id: string): void {
    const name = this.current().headers.find((row) => row.id === id)?.name;
    this.apply(removeHeaderRow(this.current(), id), name ? `Cabeçalho removido: ${name}.` : 'Cabeçalho removido.');
  }

  setHeaderName(id: string, name: string): void {
    this.apply(setHeaderName(this.current(), id, name), name === '' ? 'Nome do cabeçalho apagado.' : `Nome do cabeçalho: ${name}.`);
  }

  /** A header's value; the status line, a live region, doesn't repeat it, since it may be a literal credential (§7.8). */
  setHeaderValue(id: string, value: string): void {
    const name = this.current().headers.find((row) => row.id === id)?.name;
    this.apply(setHeaderValue(this.current(), id, value), `Valor${name ? ` de ${name}` : ''} alterado.`);
  }

  setAuth(kind: AuthKind): void {
    this.apply(setAuth(this.current(), kind), `Autenticação: ${kind === 'basic' ? 'básica' : 'nenhuma'}.`);
  }

  /** Usuário or Senha; the status line doesn't repeat them. */
  setAuthField(field: 'username' | 'password', value: string): void {
    this.apply(setAuthField(this.current(), field, value), field === 'username' ? 'Usuário alterado.' : 'Senha alterada.');
  }

  setBody(kind: BodyKind): void {
    this.apply(setBody(this.current(), kind), `Corpo: ${BODY_NAMES[kind]}.`);
  }

  setBodyKey(key: string, included: boolean): void {
    this.apply(setBodyKey(this.current(), key, included), `Entrada ${key} ${included ? 'no corpo' : 'fora do corpo'}.`);
  }

  /** Adds an output at the end and returns its id; null at the limit (§7.4). */
  addOutput(): string | null {
    const id = `row-${++this.ids}`;
    const added = addOutput(this.current(), id);
    if (added === null) {
      this.message.set(`Uma automação tem no máximo ${MAX_OUTPUTS} saídas.`);
      return null;
    }
    this.apply(added, 'Saída adicionada.');
    return id;
  }

  removeOutput(id: string): void {
    this.atOutput(id, (index, key) => this.apply(removeOutput(this.current(), index), key ? `Saída removida: ${key}.` : 'Saída removida.'));
  }

  moveOutput(id: string, by: -1 | 1): void {
    this.atOutput(id, (index, key) => {
      const moved = moveOutput(this.current(), index, by);
      if (moved !== null) {
        this.apply(moved, `Saída movida para ${by < 0 ? 'cima' : 'baixo'}${key ? `: ${key}` : ''}.`);
      }
    });
  }

  setOutputKey(id: string, key: string): void {
    this.atOutput(id, (index) => this.apply(setOutputKey(this.current(), index, key), key === '' ? 'Chave da saída apagada.' : `Chave da saída alterada para ${key}.`));
  }

  setOutputType(id: string, type: string): void {
    this.atOutput(id, (index, key) => this.apply(setOutputType(this.current(), index, type), `Tipo${key ? ` de ${key}` : ''}: ${typeLabel(type)}.`));
  }

  setOutputRequired(id: string, required: boolean): void {
    this.atOutput(id, (index, key) =>
      this.apply(setOutputRequired(this.current(), index, required), `Saída${key ? ` ${key}` : ''} ${required ? 'obrigatória' : 'opcional'}.`),
    );
  }

  setOutputSource(id: string, source: OutputSource): void {
    this.atOutput(id, (index, key) =>
      this.apply(setOutputSource(this.current(), index, source), `Origem${key ? ` de ${key}` : ''}: ${source === 'status' ? 'status HTTP' : 'corpo da resposta'}.`),
    );
  }

  setOutputPath(id: string, path: readonly PathSegment[]): void {
    this.atOutput(id, (index, key) => this.apply(setOutputPath(this.current(), index, path), `Caminho${key ? ` de ${key}` : ''}: ${formatPath(path)}.`));
  }

  setResponseType(type: string): void {
    this.apply(setResponseType(this.current(), type), `Resposta: ${type === 'json' ? 'JSON' : 'nenhuma'}.`);
  }

  /** A setting of *Execução* (§7.5); the whole `execution` object is written, every value explicit. */
  setExecution(change: ExecutionChange): void {
    this.apply(setExecution(this.current(), change), executionNotice(change));
  }

  /** Runs an edit on the output with this id, if it is still there, with its index and key. */
  private atOutput(id: string, edit: (index: number, key: string) => void): void {
    const draft = this.current();
    const index = draft.outputIds.indexOf(id);
    if (index >= 0) {
      const key = outputsOf(draft.json)[index]['key'];
      edit(index, typeof key === 'string' ? key : '');
    }
  }

  /** Runs an edit on the input with this id, if it is still there, with its index and key. */
  private at(id: string, edit: (index: number, key: string) => void): void {
    const draft = this.current();
    const index = draft.inputIds.indexOf(id);
    if (index >= 0) {
      const key = inputsOf(draft.json)[index]['key'];
      edit(index, typeof key === 'string' ? key : '');
    }
  }

  /** Makes an edit one undoable change, unless it changes nothing. */
  private apply(next: EditorDraft, notice: string): void {
    const current = this.current();
    if (next === current) {
      return;
    }
    this.past.update((past) => [...past, current].slice(-HISTORY_LIMIT));
    this.future.set([]);
    this.current.set(next);
    this.message.set(notice);
  }
}

/** What a change of *Execução* did, for the status line. */
function executionNotice(change: ExecutionChange): string {
  if (change.timeoutSeconds !== undefined) {
    return `Tempo limite por tentativa: ${change.timeoutSeconds} s.`;
  }
  if (change.maxAttempts !== undefined) {
    return `Tentativas: ${change.maxAttempts}.`;
  }
  if (change.initialDelaySeconds !== undefined) {
    return `Espera antes da segunda tentativa: ${change.initialDelaySeconds} s.`;
  }
  if (change.idempotency !== undefined) {
    return change.idempotency.mode === 'header' ? `Chave de idempotência no cabeçalho ${change.idempotency.header}.` : 'Chave de idempotência: não enviar.';
  }
  return change.redirects?.follow ? `Redirecionamentos: seguir até ${change.redirects.max}.` : 'Redirecionamentos: não seguir.';
}

/** "no caminho", "no caminho e no corpo", "no caminho, na consulta e no corpo". */
function list(places: readonly string[]): string {
  return places.length === 1 ? places[0] : `${places.slice(0, -1).join(', ')} e ${places[places.length - 1]}`;
}
