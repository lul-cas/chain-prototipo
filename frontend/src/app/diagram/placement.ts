import { Box, WorkflowDocument, WorkflowNode } from './workflow-document';
import { LANE_BAND, NODE_SIZE } from './geometry';

/** The box of every lane and node: its own `layout`, or the automatic placement of workflow-editor.md §10.1. */
export interface Placement {
  readonly lanes: ReadonlyMap<string, Box>;
  readonly nodes: ReadonlyMap<string, Box>;
}

const LEFT = 40;
const TOP = 40;
const COLUMN = 200;
const ROW = 120;
const BAND_GAP = 20;
const FIRST_CENTER_X = LEFT + LANE_BAND + 118; // 190: node centers on the grid, with room for a task after the band
const RIGHT_MARGIN = 50;

/**
 * Places what has no `layout`, by a fixed rule so a document always looks the same. Nodes go in columns by their distance
 * from the start, counted in flows (a node the start does not reach goes in a last column), and in rows by document order
 * within their lane and column. Each lane is a band around its nodes, in document order; nodes outside any lane go in a band
 * above them. Stored layouts are kept.
 */
export function place(document: WorkflowDocument): Placement {
  const columns = columnsOf(document);
  const lastColumn = Math.max(0, ...columns.values());
  const laneIds = new Set(document.lanes.map((lane) => lane.id));
  const bands = [
    { laneId: null as string | null, nodes: document.nodes.filter((node) => !node.laneId || !laneIds.has(node.laneId)) },
    ...document.lanes.map((lane) => ({ laneId: lane.id as string | null, nodes: document.nodes.filter((node) => node.laneId === lane.id) })),
  ].filter((band) => band.laneId !== null || band.nodes.length > 0);

  const lanes = new Map<string, Box>();
  const nodes = new Map<string, Box>();
  let top = TOP;
  for (const band of bands) {
    const rows = new Map<number, number>();
    for (const node of band.nodes) {
      const column = columns.get(node.id) ?? lastColumn;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      nodes.set(node.id, node.layout ?? centered(node, FIRST_CENTER_X + column * COLUMN, top + ROW / 2 + row * ROW));
    }

    const height = Math.max(1, ...rows.values()) * ROW;
    if (band.laneId !== null) {
      const right = FIRST_CENTER_X + lastColumn * COLUMN + NODE_SIZE.task.w / 2 + RIGHT_MARGIN;
      const lane = document.lanes.find((candidate) => candidate.id === band.laneId)!;
      lanes.set(lane.id, lane.layout ?? { x: LEFT, y: top, w: right - LEFT, h: height });
    }
    top += height + BAND_GAP;
  }

  return { lanes, nodes };
}

/** Each node's distance from the start, counted in flows; a node the start does not reach goes after the farthest one. */
function columnsOf(document: WorkflowDocument): Map<string, number> {
  const targets = new Map<string, string[]>();
  for (const flow of document.flows) {
    targets.set(flow.source, [...(targets.get(flow.source) ?? []), flow.target]);
  }

  const reached = new Set(document.flows.map((flow) => flow.target));
  const starts = document.nodes.filter((node) => node.type === 'start');
  const seeds = starts.length > 0 ? starts : document.nodes.filter((node) => !reached.has(node.id));
  const columns = new Map<string, number>((seeds.length > 0 ? seeds : document.nodes.slice(0, 1)).map((node) => [node.id, 0]));

  const queue = [...columns.keys()];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const target of targets.get(id) ?? []) {
      if (!columns.has(target)) {
        columns.set(target, columns.get(id)! + 1);
        queue.push(target);
      }
    }
  }

  const unreachedColumn = Math.max(-1, ...columns.values()) + 1;
  for (const node of document.nodes) {
    if (!columns.has(node.id)) {
      columns.set(node.id, unreachedColumn);
    }
  }
  return columns;
}

/**
 * A node's box around a point. A type from the document that has no size is sized as a task, even a name every object
 * inherits, such as `constructor` (card #201).
 */
function centered(node: WorkflowNode, x: number, y: number): Box {
  const size = Object.hasOwn(NODE_SIZE, node.type) ? NODE_SIZE[node.type] : NODE_SIZE.task;
  return { x: x - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h };
}
