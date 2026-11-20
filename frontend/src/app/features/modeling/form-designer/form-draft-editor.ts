import { Injectable, computed, signal } from '@angular/core';
import { FormDocument } from '../../../forms/model';
import {
  ComponentChange,
  DesignerComponent,
  DesignerDocument,
  PaletteType,
  Place,
  changed,
  created,
  fromDocument,
  insert,
  limitRefusal,
  locate,
  move,
  placeToAdd,
  remove,
  stepDown,
  stepUp,
  toDocument,
} from './form-edits';
import { TYPE_NAME, paletteName } from './form-palette';

const HISTORY_LIMIT = 200;
const EMPTY: DesignerDocument = { schemaVersion: 1, components: [] };

/**
 * The form designer's state (form-designer.md §4.4, ADR-0010 D3), as the workflow editor's `DraftEditor` holds its own: the
 * document with in-memory ids, the selection, undo and redo up to 200 steps, and whether there is something to save. The
 * edits are the pure functions of `form-edits.ts`. A refused edit changes nothing and says why in `notice`.
 */
@Injectable()
export class FormDraftEditor {
  private readonly current = signal<DesignerDocument>(EMPTY);
  private readonly saved = signal<DesignerDocument>(EMPTY);
  private readonly past = signal<readonly DesignerDocument[]>([]);
  private readonly future = signal<readonly DesignerDocument[]>([]);
  private readonly selected = signal<string | null>(null);
  private readonly message = signal<string | null>(null);
  private ids = 0;

  readonly document = this.current.asReadonly();
  readonly selection = this.selected.asReadonly();
  /** What the last action did or why it was refused, for the status line. */
  readonly notice = this.message.asReadonly();
  readonly dirty = computed(() => this.current() !== this.saved());
  readonly canUndo = computed(() => this.past().length > 0);
  readonly canRedo = computed(() => this.future().length > 0);
  /** The document to save, without the designer's ids. */
  readonly saveable = computed(() => toDocument(this.current()));

  /** Starts over with a draft as the server has it. */
  load(document: FormDocument): void {
    this.ids = 0;
    const loaded = fromDocument(document, () => this.newId());
    this.current.set(loaded);
    this.saved.set(loaded);
    this.past.set([]);
    this.future.set([]);
    this.selected.set(null);
    this.message.set(null);
  }

  /** The server now has this document, the one that was sent: edits made while it was saving stay unsaved. */
  markSaved(sent: DesignerDocument): void {
    this.saved.set(sent);
  }

  /** Back to the saved draft. The page asks first (§9.1). */
  discard(): void {
    this.current.set(this.saved());
    this.past.set([]);
    this.future.set([]);
    this.keepSelection();
    this.message.set(null);
  }

  select(id: string | null): void {
    this.selected.set(id);
    this.message.set(null);
  }

  /** Adds a component where §7.3 says, selects it and returns its id; null when a limit refuses it (§7.5). */
  add(type: PaletteType): string | null {
    const document = this.current();
    const place = placeToAdd(document, this.selected());
    const siblings = place.parent === null ? document.components : (locate(document, place.parent)?.component.components ?? []);
    const component = created(type, siblings, this.newId());
    if (!this.applyChecked(insert(document, component, place))) {
      return null;
    }
    this.selected.set(component.id);
    this.message.set(`Adicionado: ${paletteName(type)}.`);
    return component.id;
  }

  /** Removes the selection with its children, then selects the next component, else the previous, else its container. */
  remove(): void {
    const id = this.selected();
    const at = id === null ? null : locate(this.current(), id);
    if (!at) {
      return;
    }
    this.apply(remove(this.current(), at.component.id));
    const next = at.siblings[at.index + 1] ?? at.siblings[at.index - 1];
    this.selected.set(next?.id ?? at.parent);
    this.message.set(`Excluído: ${nameOf(at.component)}.`);
  }

  /** Alt+↑ (§7.2). */
  moveUp(): void {
    this.step(stepUp);
  }

  /** Alt+↓ (§7.2). */
  moveDown(): void {
    this.step(stepDown);
  }

  /** Mover para… (§7.2): the selection to a container and position. A move past the limits is refused (§7.5). */
  moveTo(place: Place): void {
    const id = this.selected();
    if (id !== null) {
      this.applyChecked(move(this.current(), id, place));
    }
  }

  change(id: string, change: ComponentChange): void {
    this.apply(changed(this.current(), id, change));
  }

  undo(): void {
    const past = this.past();
    if (past.length === 0) {
      return;
    }
    this.future.update((future) => [this.current(), ...future]);
    this.past.set(past.slice(0, -1));
    this.current.set(past[past.length - 1]);
    this.keepSelection();
    this.message.set(null);
  }

  redo(): void {
    const [next, ...future] = this.future();
    if (!next) {
      return;
    }
    this.past.update((past) => [...past, this.current()]);
    this.future.set(future);
    this.current.set(next);
    this.keepSelection();
    this.message.set(null);
  }

  private step(place: (document: DesignerDocument, id: string) => Place | null): void {
    const id = this.selected();
    const to = id === null ? null : place(this.current(), id);
    if (id !== null && to !== null) {
      this.apply(move(this.current(), id, to));
    }
  }

  /** Applies an addition or a move unless it breaks a limit, which the notice then explains. */
  private applyChecked(next: DesignerDocument): boolean {
    const refusal = limitRefusal(next);
    if (refusal !== null) {
      this.message.set(refusal);
      return false;
    }
    this.apply(next);
    return true;
  }

  /** Records a change; the same document is no change. */
  private apply(next: DesignerDocument): void {
    const current = this.current();
    if (next === current) {
      return;
    }
    this.past.update((past) => [...past, current].slice(-HISTORY_LIMIT));
    this.future.set([]);
    this.current.set(next);
  }

  /** A selection the document no longer has is cleared. */
  private keepSelection(): void {
    const id = this.selected();
    if (id !== null && !locate(this.current(), id)) {
      this.selected.set(null);
    }
  }

  private newId(): string {
    return `c${++this.ids}`;
  }
}

/** How a status line names a component: its label, its text, or its type. */
export function nameOf(component: DesignerComponent): string {
  return component.label?.trim() || component.text?.trim() || (Object.hasOwn(TYPE_NAME, component.type) ? TYPE_NAME[component.type] : component.type);
}
