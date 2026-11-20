import { Box, NodeType, WorkflowFlow } from './workflow-document';

/** The sizes of new and placed nodes (workflow-editor.md §3): the POC's, which the snapping grid fits. */
export const NODE_SIZE: Readonly<Record<NodeType, { readonly w: number; readonly h: number }>> = {
  start: { w: 64, h: 64 },
  end: { w: 64, h: 64 },
  task: { w: 140, h: 70 },
  gateway: { w: 70, h: 70 },
};

/** The snapping grid (§4), and the minor and major dots of the canvas (§2). */
export const GRID = 10;
export const MINOR_DOTS = 20;
export const MAJOR_DOTS = 100;

/** The width of a lane's title band (§3). */
export const LANE_BAND = 32;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

/**
 * Where a flow leaves its source: the right side. A gateway's true handle is at 25 % of its height and its false handle at
 * 75 % (§3), on the diamond's right edges, which are at 75 % of its width there.
 */
export function exitPoint(box: Box, type: NodeType, branch?: 'true' | 'false'): Point {
  if (type === 'gateway' && branch) {
    return { x: box.x + box.w * 0.75, y: box.y + box.h * (branch === 'true' ? 0.25 : 0.75) };
  }
  return { x: box.x + box.w, y: box.y + box.h / 2 };
}

/** How a flow is drawn: its routing, its ends, its bend (null when it is a straight line), and the points of its path. */
export interface Routing {
  readonly mode: 'HV' | 'VH';
  readonly start: Point;
  readonly end: Point;
  readonly bend: number | null;
  readonly points: readonly Point[];
}

/** Ends this close on one axis are joined by a straight line (the POC's `eps`). */
const STRAIGHT = 6;
/** How far in from the ends the bend is kept, across and down (the POC's margins). */
const BEND_MARGIN = { HV: 12, VH: 8 };

/**
 * How a flow is drawn (workflow-editor.md §10.4, the POC's `chooseSide` and `updateEdgePath`). It leaves its source on the
 * side facing the target and enters the target on the side facing the source: left or right when the centers are at least
 * as far apart across as down (horizontal first, `HV`), top or bottom otherwise (vertical first, `VH`). A routing chosen for
 * the flow sets the sides instead. A gateway's true and false flows leave from their handles. Ends within 6 px on one axis
 * are joined straight; otherwise the bend, in the middle unless moved, is kept between the ends and on the grid.
 */
export function routing(source: Box, sourceType: NodeType, target: Box, flow: Pick<WorkflowFlow, 'branch' | 'layout'>): Routing {
  const across = Math.abs(centerOf(target).x - centerOf(source).x) >= Math.abs(centerOf(target).y - centerOf(source).y);
  const mode = flow.layout?.mode ?? (across ? 'HV' : 'VH');
  const start = sourceType === 'gateway' && flow.branch ? exitPoint(source, 'gateway', flow.branch) : facing(source, target, mode);
  const end = facing(target, source, mode);
  if (Math.abs(start.x - end.x) <= STRAIGHT || Math.abs(start.y - end.y) <= STRAIGHT) {
    return { mode, start, end, bend: null, points: [start, end] };
  }
  if (mode === 'HV') {
    const bend = between(flow.layout?.bendX ?? (start.x + end.x) / 2, start.x, end.x, BEND_MARGIN.HV);
    return { mode, start, end, bend, points: [start, { x: bend, y: start.y }, { x: bend, y: end.y }, end] };
  }
  const bend = between(flow.layout?.bendY ?? (start.y + end.y) / 2, start.y, end.y, BEND_MARGIN.VH);
  return { mode, start, end, bend, points: [start, { x: start.x, y: bend }, { x: end.x, y: bend }, end] };
}

/** The points of a flow's path (see `routing`). */
export function route(source: Box, sourceType: NodeType, target: Box, flow: Pick<WorkflowFlow, 'branch' | 'layout'>): Point[] {
  return [...routing(source, sourceType, target, flow).points];
}

/** Where a bend moved to `value` ends up for a flow drawn so: between its ends and on the grid. */
export function keepBend(drawn: Routing, value: number): number {
  return drawn.mode === 'HV'
    ? between(value, drawn.start.x, drawn.end.x, BEND_MARGIN.HV)
    : between(value, drawn.start.y, drawn.end.y, BEND_MARGIN.VH);
}

/** A bend kept between two ends, `margin` in from each, then put on the grid, as the POC does. */
export function between(value: number, a: number, b: number, margin: number): number {
  return snap(Math.max(Math.min(a, b) + margin, Math.min(Math.max(a, b) - margin, value)));
}

/** The middle of the side of `box` that faces `other`: left or right for `HV`, top or bottom for `VH`. */
function facing(box: Box, other: Box, mode: 'HV' | 'VH'): Point {
  const center = centerOf(box);
  if (mode === 'HV') {
    return { x: centerOf(other).x >= center.x ? box.x + box.w : box.x, y: center.y };
  }
  return { x: center.x, y: centerOf(other).y >= center.y ? box.y + box.h : box.y };
}

function centerOf(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** The SVG path of a route. */
export function pathOf(points: readonly Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

/** The smallest box holding all the given boxes, or null when there are none. */
export function bounds(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) {
    return null;
  }
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Whether two boxes overlap; touching edges do not. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
