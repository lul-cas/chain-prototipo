import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Box, WorkflowDocument, WorkflowNode } from './workflow-document';
import { DraftEditor } from './draft-editor';
import { Corner, moveBy, resizeLane, setBend } from './edits';
import { LANE_BAND, MAJOR_DOTS, MINOR_DOTS, Point, Routing, bounds, exitPoint, pathOf, routing, snap } from './geometry';
import { KIND_LABEL, kindOf, labelOf } from './names';
import { place } from './placement';

const MIN_SCALE = 0.4;
const MAX_SCALE = 2.5;
const ZOOM_STEP = 1.1;
const FIT_MARGIN = 40;
/** jsdom and hidden canvases have no size; fitting then assumes this one. */
const FALLBACK_SIZE = { width: 1000, height: 600 };
/** The arrow keys move the selection by a grid step, or by five with Shift (workflow-editor.md §10.2). */
const NUDGE = 10;
const NUDGE_FAR = 50;
/** How far a press must move to be a drag rather than a click (§10.3). */
const DRAG_THRESHOLD = 3;
const EMPTY: WorkflowDocument = { schemaVersion: 1, lanes: [], nodes: [], flows: [] };
const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br'];
/** The field for renaming a lane in place, over its title band (§10.6), in canvas units. */
const RENAME = { w: 240, h: 36 };

/** What a press of the primary button started on. */
type Target =
  | { readonly kind: 'element'; readonly id: string }
  | { readonly kind: 'exit'; readonly node: string; readonly branch?: 'true' | 'false' }
  | { readonly kind: 'corner'; readonly lane: string; readonly corner: Corner }
  | { readonly kind: 'bend'; readonly flow: string }
  | { readonly kind: 'flow-end'; readonly flow: string; readonly end: 'source' | 'target' }
  | { readonly kind: 'background' };

/** A press of the primary button, until it is known to be a click or a drag. */
interface Press {
  readonly client: Point;
  readonly at: Point;
  readonly target: Target;
  readonly additive: boolean;
  dragging: boolean;
}

/** A drag in progress, drawn as it goes and recorded on release (§10.3). */
type Drag =
  | { readonly kind: 'move'; readonly ids: ReadonlySet<string>; readonly dx: number; readonly dy: number }
  | { readonly kind: 'resize'; readonly lane: string; readonly corner: Corner; readonly dx: number; readonly dy: number }
  | { readonly kind: 'marquee'; readonly box: Box; readonly additive: boolean }
  | { readonly kind: 'wire'; readonly from: Point; readonly to: Point }
  | { readonly kind: 'bend'; readonly flow: string; readonly at: Point }
  | { readonly kind: 'reconnect'; readonly flow: string; readonly end: 'source' | 'target'; readonly from: Point; readonly to: Point };

interface Handle {
  readonly point: Point;
  readonly tone: 'plain' | 'true' | 'false';
  /** Whether a flow starts here: the right handle, or a gateway's true or false one. */
  readonly exit: boolean;
}

let nextCanvas = 0;

/**
 * The editor's canvas (workflow-editor.md §2, §3, §10): an SVG of a draft's lanes, nodes and flows, in Chain's tokens and
 * the POC's notation. It pans with Space and drag or the middle button, zooms with the wheel around the cursor, fits every
 * element, and centers one. Each element has an accessible name; elements with problems are outlined and say so.
 *
 * Where a `DraftEditor` is provided, the canvas draws its document and edits it (§10.2, §10.3): each element is a toggle
 * button in the tab order, selected by click, Enter or Space; the arrow keys move the selection; a flow is connected by
 * choosing an exit handle, then its target. Nodes and lanes are dragged, lanes resized by their corners, nodes selected by
 * a marquee, and flows connected by dragging from a handle. Otherwise it draws the `document` input, read-only.
 */
@Component({
  selector: 'chain-workflow-canvas',
  templateUrl: './workflow-canvas.html',
  styleUrls: ['./workflow-canvas.css', './workflow-canvas-editing.css', './workflow-canvas-current.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowCanvas {
  /** The document to draw when there is no editor. */
  readonly document = input<WorkflowDocument | null>(null);
  /** Ids of the elements the server found problems in. */
  readonly problems = input<ReadonlySet<string>>(new Set());
  /** The step a request is at, marked on its diagram (workflow-editor.md §10.11). */
  readonly current = input<string | null>(null);
  /** A node or a lane's body double-clicked: its properties are asked for (§10.5, §10.6). */
  readonly properties = output<string>();

  private readonly editor = inject(DraftEditor, { optional: true });
  private readonly injector = inject(Injector);
  protected readonly editable = this.editor !== null;
  protected readonly id = `chain-canvas-${nextCanvas++}`;
  protected readonly band = LANE_BAND;
  protected readonly minorDots = MINOR_DOTS;
  protected readonly majorDots = MAJOR_DOTS;
  private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');
  protected readonly renameSize = RENAME;
  /** The lane being renamed in place, with its title and box. */
  protected readonly renaming = signal<{ readonly id: string; readonly title: string; readonly box: Box } | null>(null);
  private readonly view = signal({ x: 0, y: 0, scale: 1 });
  /** The element `center` brought to the middle, when there is no editor to select it in. */
  private readonly highlighted = signal<string | null>(null);
  /** A drag in progress; what it moves or resizes is drawn so, and recorded only on release. */
  private readonly drag = signal<Drag | null>(null);
  private pressed: Press | null = null;
  private readonly drawn = computed(() => {
    const document = this.editor?.document() ?? this.document() ?? EMPTY;
    const drag = this.drag();
    switch (drag?.kind) {
      case 'move':
        return moveBy(document, drag.ids, drag.dx, drag.dy);
      case 'resize':
        return resizeLane(document, drag.lane, drag.corner, drag.dx, drag.dy);
      case 'bend':
        return setBend(document, drag.flow, drag.at);
      default:
        return document;
    }
  });
  private readonly placement = computed(() => place(this.drawn()));
  private readonly selection = computed(() => this.editor?.selection() ?? new Set([this.highlighted()]));
  private readonly source = computed(() => this.editor?.pending()?.source ?? null);
  protected readonly connecting = computed(() => this.source() !== null);
  protected readonly marquee = computed(() => {
    const drag = this.drag();
    return drag?.kind === 'marquee' ? drag.box : null;
  });
  /** The dashed line from a handle to the pointer, while connecting or moving a flow's end. */
  protected readonly wire = computed(() => {
    const drag = this.drag();
    return drag?.kind === 'wire' || drag?.kind === 'reconnect' ? { from: drag.from, to: drag.to } : null;
  });
  private panning: Point | null = null;
  /** Set when a pan or a drag ends, so the click that the browser sends then does not select or clear anything. */
  private suppressClick = false;
  private spaceHeld = false;
  /** Set when the view panned while Space was held, so releasing Space does not also toggle the focused element. */
  private pannedWithSpace = false;

  protected readonly transform = computed(() => {
    const view = this.view();
    return `translate(${round(view.x)} ${round(view.y)}) scale(${round(view.scale)})`;
  });

  protected readonly lanes = computed(() =>
    this.drawn().lanes.map((lane) => {
      const problem = this.problems().has(lane.id);
      const box = this.placement().lanes.get(lane.id)!;
      const selected = this.selection().has(lane.id);
      return {
        id: lane.id,
        title: lane.title,
        box,
        problem,
        selected,
        corners: this.editable && selected ? CORNERS.map((corner) => ({ corner, point: cornerOf(box, corner) })) : [],
        name: `Área: ${lane.title}${problem ? ' (com problema)' : ''}`,
      };
    }),
  );

  protected readonly nodes = computed(() =>
    this.drawn().nodes.map((node) => {
      const box = this.placement().nodes.get(node.id)!;
      const kind = kindOf(node);
      const problem = this.problems().has(node.id);
      const current = this.current() === node.id;
      return {
        id: node.id,
        kind,
        box,
        label: node.label,
        problem,
        current,
        selected: this.selection().has(node.id),
        source: this.source() === node.id,
        name: `${KIND_LABEL[kind]}: ${labelOf(node)}${problem ? ' (com problema)' : ''}${current ? ', etapa atual' : ''}`,
        shape: node.type === 'start' || node.type === 'end' ? 'circle' : node.type === 'gateway' ? 'diamond' : 'rect',
        center: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
        radius: Math.min(box.w, box.h) / 2,
        diamond: [
          [box.x + box.w / 2, box.y],
          [box.x + box.w, box.y + box.h / 2],
          [box.x + box.w / 2, box.y + box.h],
          [box.x, box.y + box.h / 2],
        ]
          .map((point) => point.join(','))
          .join(' '),
        marker: kind === 'automatic' ? '⚙' : kind === 'subworkflow' ? '⧉' : null,
        handles: handlesOf(node, box),
      };
    }),
  );

  protected readonly flows = computed(() => {
    const nodes = new Map(this.drawn().nodes.map((node) => [node.id, node]));
    return this.drawn().flows.flatMap((flow) => {
      const source = nodes.get(flow.source);
      const target = nodes.get(flow.target);
      if (!source || !target) {
        return []; // a flow to a missing node: the server reports it, and there is nothing to draw
      }
      const drawn = routing(this.placement().nodes.get(source.id)!, source.type, this.placement().nodes.get(target.id)!, flow);
      const problem = this.problems().has(flow.id);
      const selected = this.selection().has(flow.id);
      const branch = flow.branch === 'true' ? ', se verdadeiro' : flow.branch === 'false' ? ', se falso' : '';
      return [
        {
          id: flow.id,
          branch: flow.branch ?? null,
          path: pathOf(drawn.points),
          start: drawn.start,
          end: drawn.end,
          middle: middleOf(drawn.points),
          problem,
          selected,
          handles: this.editable && selected ? flowHandles(drawn) : [],
          name: `Fluxo de ${source.label} para ${target.label}${branch}${problem ? ' (com problema)' : ''}`,
        },
      ];
    });
  });

  /** Shows every element, centered, with a margin; never zooms in past 100 %. */
  fit(): void {
    const box = bounds([...this.placement().lanes.values(), ...this.placement().nodes.values()]);
    if (!box) {
      this.view.set({ x: 0, y: 0, scale: 1 });
      return;
    }
    const { width, height } = this.size();
    const scale = clamp(Math.min(width / (box.w + 2 * FIT_MARGIN), height / (box.h + 2 * FIT_MARGIN), 1));
    this.view.set({ x: width / 2 - (box.x + box.w / 2) * scale, y: height / 2 - (box.y + box.h / 2) * scale, scale });
  }

  /** Brings an element to the middle of the view and selects it, keeping the zoom. */
  center(elementId: string): void {
    const point = this.centerOf(elementId);
    if (!point) {
      return;
    }
    const { width, height } = this.size();
    const { scale } = this.view();
    this.view.set({ x: width / 2 - point.x * scale, y: height / 2 - point.y * scale, scale });
    if (this.editor) {
      this.editor.select(elementId);
    } else {
      this.highlighted.set(elementId);
    }
  }

  /** The canvas point in the middle of the view, where the palette adds nodes. */
  viewCenter(): Point {
    const { width, height } = this.size();
    const view = this.view();
    return { x: (width / 2 - view.x) / view.scale, y: (height / 2 - view.y) / view.scale };
  }

  focus(): void {
    this.svg().nativeElement.focus();
  }

  /** Gives the focus to an element, for example one just added, so the arrow keys move it at once. */
  focusElement(elementId: string): void {
    const elements = this.svg().nativeElement.querySelectorAll<SVGGElement>('[data-element]');
    Array.from(elements)
      .find((element) => element.getAttribute('data-element') === elementId)
      ?.focus();
  }

  protected zoom(event: WheelEvent): void {
    event.preventDefault();
    const frame = this.svg().nativeElement.getBoundingClientRect();
    const cursor = { x: event.clientX - frame.left, y: event.clientY - frame.top };
    this.view.update((view) => {
      const scale = clamp(event.deltaY < 0 ? view.scale * ZOOM_STEP : view.scale / ZOOM_STEP);
      // The canvas point under the cursor stays under it.
      return {
        scale,
        x: cursor.x - ((cursor.x - view.x) / view.scale) * scale,
        y: cursor.y - ((cursor.y - view.y) / view.scale) * scale,
      };
    });
  }

  /** A press of the middle button, or of the primary one with Space held, pans; one of the primary button may become a drag. */
  protected down(event: PointerEvent): void {
    this.suppressClick = false;
    if (event.button === 1 || (event.button === 0 && this.spaceHeld)) {
      event.preventDefault();
      this.panning = { x: event.clientX, y: event.clientY };
      this.svg().nativeElement.setPointerCapture?.(event.pointerId);
    } else if (event.button === 0 && this.editor) {
      this.pressed = {
        client: { x: event.clientX, y: event.clientY },
        at: this.toCanvas(event),
        target: this.targetOf(event.target),
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
        dragging: false,
      };
    }
  }

  protected move(event: PointerEvent): void {
    if (this.panning) {
      const from = this.panning;
      this.panning = { x: event.clientX, y: event.clientY };
      const moved = event.clientX !== from.x || event.clientY !== from.y;
      this.suppressClick ||= moved;
      this.pannedWithSpace ||= moved && this.spaceHeld;
      this.view.update((view) => ({ ...view, x: view.x + event.clientX - from.x, y: view.y + event.clientY - from.y }));
      return;
    }
    const press = this.pressed;
    if (!press) {
      return;
    }
    if (!press.dragging) {
      if (Math.hypot(event.clientX - press.client.x, event.clientY - press.client.y) < DRAG_THRESHOLD) {
        return;
      }
      press.dragging = true;
      this.begin(press);
      // Captured only once it is a drag, so a plain click still goes to the element it was on.
      this.svg().nativeElement.setPointerCapture?.(event.pointerId);
    }
    this.follow(press, this.toCanvas(event));
  }

  protected up(event: PointerEvent): void {
    this.panning = null;
    const press = this.pressed;
    this.pressed = null;
    if (press?.dragging) {
      this.suppressClick = true;
      this.follow(press, this.toCanvas(event));
      this.finish();
    }
  }

  protected cancelGesture(): void {
    this.panning = null;
    this.pressed = null;
    if (this.drag()?.kind === 'wire') {
      this.editor?.cancelConnecting();
    }
    this.drag.set(null);
  }

  /**
   * A click on an exit handle starts a flow; on a node, it ends the flow being connected. Otherwise a click on an element
   * selects only it, or adds or removes it with Shift, Ctrl or ⌘; on the background it clears the selection. A click on
   * anything but a node cancels the flow being connected.
   */
  protected choose(event: MouseEvent): void {
    const editor = this.editor;
    if (!editor || this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const target = event.target as Element;
    const handle = target.closest('[data-handle]');
    const id = handle?.getAttribute('data-handle') ?? target.closest('[data-element]')?.getAttribute('data-element') ?? null;

    if (editor.pending()) {
      if (id !== null && this.isNode(id)) {
        editor.connectTo(id);
      } else {
        editor.cancelConnecting();
      }
    } else if (handle?.hasAttribute('data-exit')) {
      const branch = handle.getAttribute('data-branch');
      editor.startConnecting(id!, branch === 'true' || branch === 'false' ? branch : undefined);
    } else if (id === null) {
      editor.clearSelection();
    } else if (event.shiftKey || event.ctrlKey || event.metaKey) {
      editor.toggle(id);
    } else {
      editor.select(id);
    }
  }

  /**
   * Enter on an element toggles it, or ends the flow being connected; Space does the same when released (see
   * `releaseSpace`), as on a native button, so it can also be held to pan. The arrow keys move the selection.
   */
  protected press(event: KeyboardEvent): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }
    const id = elementOf(event.target);
    if (event.key === 'Enter' && id !== null) {
      event.preventDefault();
      this.activate(id);
      return;
    }

    const step = event.shiftKey ? NUDGE_FAR : NUDGE;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (move && editor.selection().size > 0) {
      event.preventDefault();
      const [only] = editor.selection();
      if (event.altKey) {
        editor.resizeSelectedLanes(move[0], move[1]); // the keyboard way to resize a lane (§10.3)
      } else if (editor.selection().size === 1 && this.drawn().flows.some((flow) => flow.id === only)) {
        editor.moveBend(move[0], move[1]); // and to move a flow's bend (§10.4)
      } else {
        editor.nudge(move[0], move[1]);
      }
    }
  }

  /**
   * Space held pans with the pointer while the focus is on the canvas, one of its elements, or the page itself, so it
   * still presses buttons and types in fields elsewhere.
   */
  @HostListener('window:keydown', ['$event'])
  protected holdSpace(event: KeyboardEvent): void {
    const target = event.target as Node | null;
    if (event.code === 'Space' && (target === document.body || (target !== null && this.svg().nativeElement.contains(target)))) {
      event.preventDefault();
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.pannedWithSpace = false;
      }
    }
  }

  /** Releasing Space on an element activates it, unless the view was panned meanwhile. */
  @HostListener('window:keyup', ['$event'])
  protected releaseSpace(event: KeyboardEvent): void {
    if (event.code !== 'Space') {
      return;
    }
    const held = this.spaceHeld;
    this.spaceHeld = false;
    const id = elementOf(event.target);
    if (held && !this.pannedWithSpace && id !== null && this.svg().nativeElement.contains(event.target as Node)) {
      this.activate(id);
    }
  }

  /**
   * A double click on a flow switches its routing (§10.4, E10); on a node or a lane's body, it asks for its properties
   * (§10.5, §10.6); on a lane's title band, it renames the lane in place (§10.6).
   */
  protected flip(event: MouseEvent): void {
    const id = elementOf(event.target);
    if (!this.editor || id === null) {
      return;
    }
    const onBand = (event.target as Element).closest('.chain-canvas__lane-band, .chain-canvas__lane-title') !== null;
    if (this.drawn().flows.some((flow) => flow.id === id)) {
      this.editor.toggleRoute(id);
    } else if (onBand) {
      this.startRename(id);
    } else {
      this.properties.emit(id);
    }
  }

  /** The keys typed in the rename field are its own: no moving, no panning, no shortcuts. Enter applies, Esc cancels. */
  protected renameKey(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.endRename();
    }
  }

  /** Renames the lane as one change; an empty title keeps the old one. */
  protected commitRename(): void {
    const renaming = this.renaming();
    if (!renaming) {
      return; // already applied or cancelled: this is the blur of the field going away
    }
    const title = this.renameInput()?.nativeElement.value.trim() ?? '';
    this.endRename();
    const lane = this.drawn().lanes.find((candidate) => candidate.id === renaming.id);
    if (title && lane && this.editor) {
      this.editor.applyLaneProperties(lane.id, { title, group: lane.group ?? { kind: 'requesters' } });
    }
  }

  private startRename(laneId: string): void {
    const lane = this.drawn().lanes.find((candidate) => candidate.id === laneId);
    if (!lane) {
      return;
    }
    this.renaming.set({ id: lane.id, title: lane.title, box: this.placement().lanes.get(lane.id)! });
    afterNextRender(
      () => {
        const field = this.renameInput()?.nativeElement;
        field?.focus();
        field?.select();
      },
      { injector: this.injector },
    );
  }

  /** Closes the rename field, first, so its blur applies nothing, and gives the focus back to the lane. */
  private endRename(): void {
    const renaming = this.renaming();
    this.renaming.set(null);
    if (renaming) {
      afterNextRender(() => this.focusElement(renaming.id), { injector: this.injector });
    }
  }

  /** Toggles an element, or ends the flow being connected on it; anything but a node cancels that flow. */
  private activate(id: string): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }
    if (!editor.pending()) {
      editor.toggle(id);
    } else if (this.isNode(id)) {
      editor.connectTo(id);
    } else {
      editor.cancelConnecting();
    }
  }

  /** What a drag does, once a press has moved far enough to be one. */
  private begin(press: Press): void {
    const editor = this.editor!;
    const target = press.target;
    if (target.kind === 'element' && this.drawn().flows.some((flow) => flow.id === target.id)) {
      // A flow is not dragged: the press selects it as a click would, as in the POC.
      if (press.additive) {
        editor.toggle(target.id);
      } else {
        editor.select(target.id);
      }
    } else if (target.kind === 'element') {
      if (!editor.selection().has(target.id)) {
        editor.select(target.id); // as in the POC, an unselected element becomes the selection
      }
      this.drag.set({ kind: 'move', ids: new Set(editor.selection()), dx: 0, dy: 0 });
    } else if (target.kind === 'corner') {
      this.drag.set({ kind: 'resize', lane: target.lane, corner: target.corner, dx: 0, dy: 0 });
    } else if (target.kind === 'bend') {
      this.drag.set({ kind: 'bend', flow: target.flow, at: press.at });
    } else if (target.kind === 'flow-end') {
      const flow = this.flows().find((candidate) => candidate.id === target.flow)!;
      const from = target.end === 'source' ? flow.end : flow.start; // the end that stays
      this.drag.set({ kind: 'reconnect', flow: target.flow, end: target.end, from, to: press.at });
    } else if (target.kind === 'exit') {
      editor.startConnecting(target.node, target.branch);
      if (editor.pending()) {
        const node = this.drawn().nodes.find((candidate) => candidate.id === target.node)!;
        const from = exitPoint(this.placement().nodes.get(target.node)!, node.type, target.branch);
        this.drag.set({ kind: 'wire', from, to: press.at });
      }
    } else if (target.kind === 'background') {
      if (!press.additive) {
        editor.clearSelection();
      }
      this.drag.set({ kind: 'marquee', box: { ...press.at, w: 0, h: 0 }, additive: press.additive });
    }
  }

  /** Follows the pointer: moves and resizes by whole grid steps, the marquee and the line exactly. */
  private follow(press: Press, point: Point): void {
    const dx = point.x - press.at.x;
    const dy = point.y - press.at.y;
    this.drag.update((drag) => {
      switch (drag?.kind) {
        case 'move':
          return { ...drag, dx: snap(dx), dy: snap(dy) };
        case 'resize':
          return { ...drag, dx, dy };
        case 'marquee':
          return { ...drag, box: boxFrom(press.at, point) };
        case 'wire':
        case 'reconnect':
          return { ...drag, to: point };
        case 'bend':
          return { ...drag, at: point };
        default:
          return drag;
      }
    });
  }

  /** Records what the drag did, as one change. */
  private finish(): void {
    const editor = this.editor!;
    const drag = this.drag();
    this.drag.set(null);
    switch (drag?.kind) {
      case 'move':
        editor.nudge(drag.dx, drag.dy);
        break;
      case 'resize':
        editor.resize(drag.lane, drag.corner, drag.dx, drag.dy);
        break;
      case 'marquee':
        editor.selectBox(drag.box, drag.additive);
        break;
      case 'wire': {
        const node = this.nodeAt(drag.to);
        if (node) {
          editor.connectTo(node);
        } else {
          editor.cancelConnecting();
        }
        break;
      }
      case 'bend':
        editor.setBend(drag.flow, drag.at);
        break;
      case 'reconnect': {
        const node = this.nodeAt(drag.to);
        if (node) {
          editor.reconnect(drag.flow, drag.end, node);
        }
        break;
      }
    }
  }

  /** The canvas point under a pointer event. */
  private toCanvas(event: MouseEvent): Point {
    const frame = this.svg().nativeElement.getBoundingClientRect();
    const view = this.view();
    return { x: (event.clientX - frame.left - view.x) / view.scale, y: (event.clientY - frame.top - view.y) / view.scale };
  }

  private targetOf(target: EventTarget | null): Target {
    const element = target instanceof Element ? target : null;
    const flowHandle = element?.closest('[data-flow-handle]');
    if (flowHandle) {
      const flow = flowHandle.getAttribute('data-flow')!;
      const kind = flowHandle.getAttribute('data-flow-handle');
      return kind === 'bend' ? { kind: 'bend', flow } : { kind: 'flow-end', flow, end: kind === 'source' ? 'source' : 'target' };
    }
    const corner = element?.closest('[data-corner]');
    if (corner) {
      return { kind: 'corner', lane: corner.getAttribute('data-lane')!, corner: corner.getAttribute('data-corner') as Corner };
    }
    const handle = element?.closest('[data-handle]');
    if (handle?.hasAttribute('data-exit')) {
      const branch = handle.getAttribute('data-branch');
      return { kind: 'exit', node: handle.getAttribute('data-handle')!, ...(branch === 'true' || branch === 'false' ? { branch } : {}) };
    }
    const id = handle?.getAttribute('data-handle') ?? elementOf(target);
    return id !== null ? { kind: 'element', id } : { kind: 'background' };
  }

  /** The node drawn on top at a canvas point, if any. */
  private nodeAt(point: Point): string | null {
    const boxes = this.placement().nodes;
    const node = [...this.drawn().nodes].reverse().find((candidate) => {
      const box = boxes.get(candidate.id)!;
      return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
    });
    return node?.id ?? null;
  }

  private isNode(id: string): boolean {
    return this.drawn().nodes.some((node) => node.id === id);
  }

  private size(): { width: number; height: number } {
    const frame = this.svg().nativeElement.getBoundingClientRect();
    return frame.width > 0 && frame.height > 0 ? frame : FALLBACK_SIZE;
  }

  private centerOf(elementId: string): Point | null {
    const box = this.placement().nodes.get(elementId) ?? this.placement().lanes.get(elementId);
    if (box) {
      return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    }
    return this.flows().find((flow) => flow.id === elementId)?.middle ?? null;
  }
}

/** The handles of a selected flow (§10.4): one at each end, and two on its bend unless it is straight. */
function flowHandles(drawn: Routing): { kind: 'source' | 'target' | 'bend'; point: Point }[] {
  const ends = [
    { kind: 'source' as const, point: drawn.start },
    { kind: 'target' as const, point: drawn.end },
  ];
  if (drawn.bend === null) {
    return ends;
  }
  const bends: Point[] =
    drawn.mode === 'HV'
      ? [{ x: drawn.bend, y: drawn.start.y }, { x: drawn.bend, y: drawn.end.y }]
      : [{ x: drawn.start.x, y: drawn.bend }, { x: drawn.end.x, y: drawn.bend }];
  return [...ends, ...bends.map((point) => ({ kind: 'bend' as const, point }))];
}

/** The middle of a path's middle segment, where a flow is centered. */
function middleOf(points: readonly Point[]): Point {
  const index = Math.floor((points.length - 1) / 2);
  const [a, b] = [points[index], points[index + 1] ?? points[index]];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function cornerOf(box: Box, corner: Corner): Point {
  return { x: corner === 'tl' || corner === 'bl' ? box.x : box.x + box.w, y: corner === 'tl' || corner === 'tr' ? box.y : box.y + box.h };
}

function boxFrom(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** The id of the canvas element an event happened in, if any. */
function elementOf(target: EventTarget | null): string | null {
  return target instanceof Element ? (target.closest('[data-element]')?.getAttribute('data-element') ?? null) : null;
}

/** The connection handles of §3: left and right, and on a gateway its true and false handles on the right. */
function handlesOf(node: WorkflowNode, box: Box): Handle[] {
  const left: Handle = { point: { x: box.x, y: box.y + box.h / 2 }, tone: 'plain', exit: false };
  if (node.type === 'gateway') {
    return [
      left,
      { point: exitPoint(box, 'gateway', 'true'), tone: 'true', exit: true },
      { point: exitPoint(box, 'gateway', 'false'), tone: 'false', exit: true },
    ];
  }
  return [left, { point: exitPoint(box, node.type), tone: 'plain', exit: true }];
}

function clamp(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
