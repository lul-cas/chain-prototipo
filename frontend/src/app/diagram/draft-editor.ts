import { Injectable, computed, signal } from '@angular/core';
import { Box, NodeType, WorkflowDocument } from './workflow-document';
import {
  Corner,
  LaneProperties,
  NodeProperties,
  addLane,
  addNode,
  applyLaneProperties,
  applyProperties,
  connect,
  emptied,
  exitRefusal,
  moveBend,
  moveBy,
  reconnect,
  remove,
  resizeLane,
  setBend,
  toggleRoute,
} from './edits';
import { Point, overlaps } from './geometry';
import { place } from './placement';

/** A flow being connected: its source was chosen, its target not yet. */
export interface PendingFlow {
  readonly source: string;
  readonly branch?: 'true' | 'false';
}

const HISTORY_LIMIT = 200;
/** New nodes are shifted by these, in turn, so several added at the same center do not pile up exactly (§10.2). */
const JITTER = [-10, 0, 10];
const EMPTY: WorkflowDocument = { schemaVersion: 1, lanes: [], nodes: [], flows: [] };

/**
 * The state of the draft being edited (workflow-editor.md §10.2): the document, its undo and redo history, the selection,
 * a flow being connected, and whether there is something to save. The editor page provides it; the canvas uses it when
 * present, and is read-only otherwise. The selection and the view are not changes of the document (E5).
 */
@Injectable()
export class DraftEditor {
  private readonly current = signal<WorkflowDocument>(EMPTY);
  private readonly saved = signal<WorkflowDocument>(EMPTY);
  private readonly past = signal<readonly WorkflowDocument[]>([]);
  private readonly future = signal<readonly WorkflowDocument[]>([]);
  private readonly selected = signal<ReadonlySet<string>>(new Set());
  private readonly connecting = signal<PendingFlow | null>(null);
  private readonly message = signal<string | null>(null);
  private added = 0;

  readonly document = this.current.asReadonly();
  readonly selection = this.selected.asReadonly();
  readonly pending = this.connecting.asReadonly();
  /** Why the last action could not be done, for the status line. */
  readonly notice = this.message.asReadonly();
  readonly dirty = computed(() => this.current() !== this.saved());
  readonly canUndo = computed(() => this.past().length > 0);
  readonly canRedo = computed(() => this.future().length > 0);
  readonly hasStart = computed(() => this.current().nodes.some((node) => node.type === 'start'));

  /** Starts over with a draft as the server has it. */
  load(document: WorkflowDocument): void {
    this.current.set(document);
    this.saved.set(document);
    this.past.set([]);
    this.future.set([]);
    this.selected.set(new Set());
    this.reset();
    this.added = 0;
  }

  /** The server now has this document as the draft. */
  markSaved(document: WorkflowDocument): void {
    this.saved.set(document);
  }

  select(id: string): void {
    this.reset();
    this.selected.set(new Set([id]));
  }

  toggle(id: string): void {
    this.reset();
    const next = new Set(this.selected());
    if (!next.delete(id)) {
      next.add(id);
    }
    this.selected.set(next);
  }

  selectAll(): void {
    this.reset();
    this.selected.set(new Set(this.current().nodes.map((node) => node.id)));
  }

  clearSelection(): void {
    this.reset();
    this.selected.set(new Set());
  }

  /** Selects the nodes a marquee touches, with the flows between them (§10.3), or adds them to the selection. */
  selectBox(box: Box, additive: boolean): void {
    this.reset();
    const document = this.current();
    const placement = place(document);
    const nodes = document.nodes.filter((node) => overlaps(placement.nodes.get(node.id)!, box)).map((node) => node.id);
    const picked = new Set(nodes);
    const flows = document.flows.filter((flow) => picked.has(flow.source) && picked.has(flow.target)).map((flow) => flow.id);
    this.selected.set(new Set([...(additive ? this.selected() : []), ...nodes, ...flows]));
  }

  /** Adds a node near the center and selects it; answers its id, or null for a second start. */
  add(type: NodeType, center: Point): string | null {
    this.reset();
    if (type === 'start' && this.hasStart()) {
      return null;
    }
    const offset = JITTER[this.added++ % JITTER.length];
    const { document, id } = addNode(this.current(), type, { x: center.x + offset, y: center.y + offset });
    this.apply(document);
    this.selected.set(new Set([id]));
    return id;
  }

  addLane(): string {
    this.reset();
    const { document, id } = addLane(this.current());
    this.apply(document);
    this.selected.set(new Set([id]));
    return id;
  }

  /** Moves the selected lanes and nodes. */
  nudge(dx: number, dy: number): void {
    this.reset();
    this.apply(moveBy(this.current(), this.selected(), dx, dy));
  }

  /** Moves a corner of a lane. */
  resize(laneId: string, corner: Corner, dx: number, dy: number): void {
    this.reset();
    this.apply(resizeLane(this.current(), laneId, corner, dx, dy));
  }

  /** Moves the bottom-right corner of each selected lane, as one change: Alt and the arrow keys (§10.3). */
  resizeSelectedLanes(dx: number, dy: number): void {
    this.reset();
    this.apply([...this.selected()].reduce((document, id) => resizeLane(document, id, 'br', dx, dy), this.current()));
  }

  /** Moves the bend of the one selected flow: the arrow keys on a flow (§10.4). */
  moveBend(dx: number, dy: number): void {
    this.reset();
    const selection = this.selected();
    const [id] = selection;
    if (selection.size === 1 && this.current().flows.some((flow) => flow.id === id)) {
      this.apply(moveBend(this.current(), id, dx, dy));
    }
  }

  /** Puts a flow's bend at a point, as dragging its bend handle does. */
  setBend(flowId: string, point: Point): void {
    this.reset();
    this.apply(setBend(this.current(), flowId, point));
  }

  /** Switches a flow between horizontal and vertical first (E10). */
  toggleRoute(flowId: string): void {
    this.reset();
    this.apply(toggleRoute(this.current(), flowId));
  }

  /** Moves an end of a flow to another node and selects the flow, or says why it cannot. */
  reconnect(flowId: string, end: 'source' | 'target', nodeId: string): void {
    this.reset();
    const result = reconnect(this.current(), flowId, end, nodeId);
    if ('refusal' in result) {
      this.message.set(result.refusal);
      return;
    }
    this.apply(result.document);
    this.selected.set(new Set([flowId]));
  }

  /** Applies the node panel (§10.5). */
  applyProperties(nodeId: string, properties: NodeProperties): void {
    this.reset();
    this.apply(applyProperties(this.current(), nodeId, properties));
  }

  /** Applies the lane panel, or a rename in place (§10.6). */
  applyLaneProperties(laneId: string, properties: LaneProperties): void {
    this.reset();
    this.apply(applyLaneProperties(this.current(), laneId, properties));
  }

  /** Chooses the source of a new flow, or says why it cannot have one more. */
  startConnecting(source: string, branch?: 'true' | 'false'): void {
    this.reset();
    const refusal = exitRefusal(this.current(), source);
    if (refusal) {
      this.message.set(refusal);
      return;
    }
    this.connecting.set(branch ? { source, branch } : { source });
  }

  /** Chooses the target of the flow being connected, and selects the new flow; a refused target can be chosen again. */
  connectTo(target: string): void {
    const pending = this.connecting();
    if (!pending) {
      return;
    }
    const result = connect(this.current(), pending.source, target, pending.branch);
    if ('refusal' in result) {
      this.message.set(result.refusal);
      return;
    }
    this.reset();
    this.apply(result.document);
    this.selected.set(new Set([result.id]));
  }

  cancelConnecting(): void {
    this.reset();
  }

  removeSelection(): void {
    this.reset();
    this.apply(remove(this.current(), this.selected()));
    this.selected.set(new Set());
  }

  /** Empties the draft ("Novo (vazio)"); it can be undone. */
  clear(): void {
    this.reset();
    this.apply(emptied(this.current()));
    this.selected.set(new Set());
  }

  undo(): void {
    const past = this.past();
    if (past.length === 0) {
      return;
    }
    this.reset();
    this.future.update((future) => [this.current(), ...future]);
    this.past.set(past.slice(0, -1));
    this.show(past[past.length - 1]);
  }

  redo(): void {
    const [next, ...future] = this.future();
    if (!next) {
      return;
    }
    this.reset();
    this.past.update((past) => [...past, this.current()]);
    this.future.set(future);
    this.show(next);
  }

  /** Records a change; the same document is no change. */
  private apply(next: WorkflowDocument): void {
    const current = this.current();
    if (next === current) {
      return;
    }
    this.past.update((past) => [...past, current].slice(-HISTORY_LIMIT));
    this.future.set([]);
    this.current.set(next);
  }

  /** Shows a document from the history; elements it does not have are no longer selected. */
  private show(document: WorkflowDocument): void {
    this.current.set(document);
    const ids = new Set([...document.lanes, ...document.nodes, ...document.flows].map((element) => element.id));
    this.selected.update((selected) => new Set([...selected].filter((id) => ids.has(id))));
  }

  /** A new action drops the notice of the previous one, and the flow being connected. */
  private reset(): void {
    this.message.set(null);
    this.connecting.set(null);
  }
}
