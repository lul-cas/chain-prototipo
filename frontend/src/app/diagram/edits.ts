import { Box, FlowLayout, NodeType, WorkflowDocument, WorkflowFlow, WorkflowLane, WorkflowNode } from './workflow-document';
import { GRID, NODE_SIZE, Point, Routing, keepBend, overlaps, routing, snap } from './geometry';
import { place } from './placement';

/**
 * The changes the editor makes to a draft (workflow-editor.md §10.2), as pure functions: each answers a new document and
 * leaves the one it got untouched, or answers that same document when nothing changes. Each change first writes the
 * automatic placement into the document, so elements placed by it stay where they are when the flows change.
 */

export interface Added {
  readonly document: WorkflowDocument;
  readonly id: string;
}

/** Why a change cannot be made, in a sentence for the author. */
export interface Refused {
  readonly refusal: string;
}

const LANE_GAP = 20;
/** How far apart a moved lane is pushed from a lane it landed on (§4, the POC's gap). */
const LANES_APART = 4;
const FIRST_LANE = { x: 40, y: 40, w: 800, h: 200 };
const MIN_LANE = { w: 200, h: 120 };

const NEW_NODE: Readonly<Record<NodeType, { readonly label: string; readonly [field: string]: unknown }>> = {
  start: { label: 'Início' },
  task: { taskKind: 'human', label: 'Nova etapa' },
  gateway: { label: 'Condicional', decisionMode: 'human', question: 'Condição?' },
  end: { label: 'Fim' },
};

/** Every lane and node with its `layout`: its own, or the automatic placement's. The same document when all have one. */
export function withLayout(document: WorkflowDocument): WorkflowDocument {
  if (document.lanes.every((lane) => lane.layout) && document.nodes.every((node) => node.layout)) {
    return document;
  }
  const placement = place(document);
  return {
    ...document,
    lanes: document.lanes.map((lane) => (lane.layout ? lane : { ...lane, layout: placement.lanes.get(lane.id)! })),
    nodes: document.nodes.map((node) => (node.layout ? node : { ...node, layout: placement.nodes.get(node.id)! })),
  };
}

/** The kind's name and the lowest number no lane, node or flow uses yet (ids are unique across them: WF003). */
export function nextId(document: WorkflowDocument, prefix: string): string {
  const taken = new Set([...document.lanes, ...document.nodes, ...document.flows].map((element) => element.id));
  let number = 1;
  while (taken.has(`${prefix}_${number}`)) {
    number++;
  }
  return `${prefix}_${number}`;
}

/** A node of the given kind, centered on the grid point nearest to `center`, in the lane under it. */
export function addNode(document: WorkflowDocument, type: NodeType, center: Point): Added {
  const laid = withLayout(document);
  const point = { x: snap(center.x), y: snap(center.y) };
  const size = NODE_SIZE[type];
  const laneId = laneAt(laid, point);
  const id = nextId(laid, type);
  const node: WorkflowNode = {
    id,
    type,
    ...NEW_NODE[type],
    ...(laneId ? { laneId } : {}),
    layout: { x: point.x - size.w / 2, y: point.y - size.h / 2, w: size.w, h: size.h },
  };
  return { document: { ...laid, nodes: [...laid.nodes, node] }, id };
}

/** A lane for the requesters below everything else, as wide as the widest lane. */
export function addLane(document: WorkflowDocument): Added {
  const laid = withLayout(document);
  const boxes = [...laid.lanes, ...laid.nodes].map((element) => element.layout!);
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  const lanes = laid.lanes.map((lane) => lane.layout!);
  const id = nextId(laid, 'lane');
  const lane: WorkflowLane = {
    id,
    title: 'Nova área',
    group: { kind: 'requesters' },
    layout: {
      x: lanes.length > 0 ? Math.min(...lanes.map((box) => box.x)) : FIRST_LANE.x,
      y: boxes.length > 0 ? Math.ceil(bottom / GRID) * GRID + LANE_GAP : FIRST_LANE.y,
      w: lanes.length > 0 ? Math.max(...lanes.map((box) => box.w)) : FIRST_LANE.w,
      h: FIRST_LANE.h,
    },
  };
  return { document: { ...laid, lanes: [...laid.lanes, lane] }, id };
}

/**
 * Moves the given lanes with their nodes, and the given nodes, which then join the lane under their center, or none. A
 * moved lane that lands on a lane that stayed is pushed off it the shortest way, 4 px apart, with its nodes (§10.3, the
 * POC's `separateLaneFromOthers`). A flow whose two ends moved keeps its shape.
 */
export function moveBy(document: WorkflowDocument, ids: ReadonlySet<string>, dx: number, dy: number): WorkflowDocument {
  const movedLanes = new Set(document.lanes.filter((lane) => ids.has(lane.id)).map((lane) => lane.id));
  const withLane = (node: WorkflowNode) => node.laneId !== undefined && movedLanes.has(node.laneId);
  const movedNodes = new Set(document.nodes.filter((node) => ids.has(node.id) || withLane(node)).map((node) => node.id));
  if (movedLanes.size === 0 && movedNodes.size === 0) {
    return document;
  }

  const laid = withLayout(document);
  const still = laid.lanes.filter((lane) => !movedLanes.has(lane.id)).map((lane) => lane.layout!);
  const laneShift = new Map<string, Point>();
  const lanes = laid.lanes.map((lane) => {
    if (!movedLanes.has(lane.id)) {
      return lane;
    }
    const from = lane.layout!;
    const layout = apart({ ...from, x: from.x + dx, y: from.y + dy }, still);
    laneShift.set(lane.id, { x: layout.x - from.x, y: layout.y - from.y });
    return { ...lane, layout };
  });

  const moved = { ...laid, lanes };
  const nodeShift = new Map<string, Point>();
  const nodes = laid.nodes.map((node) => {
    if (!movedNodes.has(node.id)) {
      return node;
    }
    const shift = withLane(node) ? laneShift.get(node.laneId!)! : { x: dx, y: dy };
    nodeShift.set(node.id, shift);
    const layout = { ...node.layout!, x: node.layout!.x + shift.x, y: node.layout!.y + shift.y };
    if (withLane(node)) {
      return { ...node, layout };
    }
    const laneId = laneAt(moved, { x: layout.x + layout.w / 2, y: layout.y + layout.h / 2 });
    return { ...withoutLane(node), ...(laneId ? { laneId } : {}), layout };
  });

  const flows = laid.flows.map((flow) => {
    const shift = nodeShift.get(flow.source);
    return shift && nodeShift.has(flow.target) && flow.layout ? { ...flow, layout: shiftBend(flow, shift.x, shift.y) } : flow;
  });
  return { ...laid, lanes, nodes, flows };
}

/** A lane's corners, for resizing. */
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * Moves one corner of a lane by whole grid steps, keeping the lane at least 200 × 120 px (the POC's minimum). Its nodes
 * keep their lane.
 */
export function resizeLane(document: WorkflowDocument, laneId: string, corner: Corner, dx: number, dy: number): WorkflowDocument {
  const stepX = snap(dx);
  const stepY = snap(dy);
  if (!document.lanes.some((lane) => lane.id === laneId) || (stepX === 0 && stepY === 0)) {
    return document;
  }

  const laid = withLayout(document);
  const box = laid.lanes.find((lane) => lane.id === laneId)!.layout!;
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (corner === 'tl' || corner === 'bl') {
    left = Math.min(left + stepX, right - MIN_LANE.w);
  } else {
    right = Math.max(right + stepX, left + MIN_LANE.w);
  }
  if (corner === 'tl' || corner === 'tr') {
    top = Math.min(top + stepY, bottom - MIN_LANE.h);
  } else {
    bottom = Math.max(bottom + stepY, top + MIN_LANE.h);
  }

  const layout = { x: left, y: top, w: right - left, h: bottom - top };
  if (layout.x === box.x && layout.y === box.y && layout.w === box.w && layout.h === box.h) {
    return document;
  }
  return { ...laid, lanes: laid.lanes.map((lane) => (lane.id === laneId ? { ...lane, layout } : lane)) };
}

/** Why the node cannot start another flow, or null when it can: an end has no exit, and a start or task has one (E3). */
export function exitRefusal(document: WorkflowDocument, source: string): string | null {
  const node = document.nodes.find((candidate) => candidate.id === source);
  if (!node || node.type === 'gateway') {
    return null;
  }
  if (node.type === 'end') {
    return 'O fim não tem saída.';
  }
  return document.flows.some((flow) => flow.source === source)
    ? `“${node.label}” já tem uma saída. Exclua o fluxo atual para ligar outro.`
    : null;
}

/** A flow from one node to another; a gateway's flow is its true or false one, and replaces the previous one of that branch. */
export function connect(document: WorkflowDocument, source: string, target: string, branch?: 'true' | 'false'): Added | Refused {
  const from = document.nodes.find((node) => node.id === source);
  if (!from || !document.nodes.some((node) => node.id === target)) {
    return { refusal: 'O elemento não existe mais.' };
  }
  const refusal = exitRefusal(document, source);
  if (refusal) {
    return { refusal };
  }
  if (source === target) {
    return { refusal: 'Um elemento não pode se ligar a si mesmo.' };
  }
  if (from.type === 'gateway' && !branch) {
    return { refusal: 'Escolha a saída verdadeira (✓) ou falsa (✗) da condicional.' };
  }

  const laid = withLayout(document);
  const kept = from.type === 'gateway' ? laid.flows.filter((flow) => flow.source !== source || flow.branch !== branch) : laid.flows;
  const id = nextId({ ...laid, flows: kept }, 'flow');
  const flow: WorkflowFlow = { id, source, target, ...(from.type === 'gateway' ? { branch } : {}) };
  return { document: { ...laid, flows: [...kept, flow] }, id };
}

/** Moves a flow's bend along its routing (§10.4): across for horizontal first, down or up for vertical first. */
export function moveBend(document: WorkflowDocument, flowId: string, dx: number, dy: number): WorkflowDocument {
  return bendTo(document, flowId, (drawn) => (drawn.bend === null ? null : drawn.bend + (drawn.mode === 'HV' ? dx : dy)));
}

/** Puts a flow's bend at a point: its x for horizontal first, its y for vertical first (§10.4, dragging the bend). */
export function setBend(document: WorkflowDocument, flowId: string, point: Point): WorkflowDocument {
  return bendTo(document, flowId, (drawn) => (drawn.bend === null ? null : drawn.mode === 'HV' ? point.x : point.y));
}

/** Switches a flow between horizontal and vertical first, with its bend back in the middle (§10.4, E10). */
export function toggleRoute(document: WorkflowDocument, flowId: string): WorkflowDocument {
  const laid = withLayout(document);
  const flow = laid.flows.find((candidate) => candidate.id === flowId);
  const drawn = flow ? drawnOf(laid, flow) : null;
  if (!flow || !drawn) {
    return document;
  }
  const layout: Record<string, unknown> = { ...flow.layout, mode: drawn.mode === 'HV' ? 'VH' : 'HV' };
  delete layout['bendX'];
  delete layout['bendY'];
  return { ...laid, flows: laid.flows.map((candidate) => (candidate.id === flowId ? { ...candidate, layout: layout as FlowLayout } : candidate)) };
}

/**
 * Moves one end of a flow to another node, by the rules of connecting (§10.4): a flow cannot end where it starts; a gateway's
 * true or false flow needs a gateway as its source, whose flow on that branch it replaces; any other flow needs a start or
 * task without another exit.
 */
export function reconnect(document: WorkflowDocument, flowId: string, end: 'source' | 'target', nodeId: string): Added | Refused {
  const flow = document.flows.find((candidate) => candidate.id === flowId);
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!flow || !node) {
    return { refusal: 'O elemento não existe mais.' };
  }
  if (flow[end] === nodeId) {
    return { document, id: flowId };
  }
  if (nodeId === (end === 'source' ? flow.target : flow.source)) {
    return { refusal: 'Um elemento não pode se ligar a si mesmo.' };
  }

  let flows = document.flows;
  if (end === 'source' && flow.branch) {
    if (node.type !== 'gateway') {
      return { refusal: 'Uma saída verdadeira ou falsa sai de uma condicional.' };
    }
    flows = flows.filter((candidate) => candidate.id === flowId || candidate.source !== nodeId || candidate.branch !== flow.branch);
  } else if (end === 'source') {
    if (node.type === 'gateway') {
      return { refusal: 'Escolha a saída verdadeira (✓) ou falsa (✗) da condicional.' };
    }
    const refusal = exitRefusal({ ...document, flows: flows.filter((candidate) => candidate.id !== flowId) }, nodeId);
    if (refusal) {
      return { refusal };
    }
  }
  const laid = withLayout(document);
  return { document: { ...laid, flows: flows.map((candidate) => (candidate.id === flowId ? { ...candidate, [end]: nodeId } : candidate)) }, id: flowId };
}

/**
 * What the node panel sets (§10.5, §10.7): a gateway is decided by a person, who answers its question, or automatically, by
 * its condition (E9); its branch steps are node ids, or null for none.
 */
export interface NodeProperties {
  readonly type: NodeType;
  /** A task's variant (§9): a person's, an automation's (§10.9), or a sub-workflow's, whose reference N2e-2 edits. */
  readonly taskKind: 'human' | 'automation' | 'subprocess';
  readonly label: string;
  readonly formId: string | null;
  /** An automatic step's reference, `{ automationId, inputs?, outputs? }`, or null while none is chosen (WF014). */
  readonly automation: unknown;
  /** A sub-workflow step's reference, `{ workflowId, inputs?, outputs? }`, or null while none is chosen (WF014). */
  readonly workflow: unknown;
  readonly decisionMode: 'human' | 'automatic';
  readonly question: string;
  readonly condition: unknown;
  readonly whenTrue: string | null;
  readonly whenFalse: string | null;
}

/** Fields of one node type that another type does not have. */
const TASK_FIELDS = ['taskKind', 'automation', 'workflow'];
const GATEWAY_FIELDS = ['decisionMode', 'question', 'condition'];

/**
 * The exits a node would lose as the given type (E8): every exit of an end, the true and false exits of what stops being a
 * gateway, and the plain exits of a gateway.
 */
export function invalidExits(document: WorkflowDocument, nodeId: string, type: NodeType): WorkflowFlow[] {
  const exits = document.flows.filter((flow) => flow.source === nodeId);
  switch (type) {
    case 'end':
      return exits;
    case 'gateway':
      return exits.filter((flow) => !flow.branch);
    default:
      return exits.filter((flow) => flow.branch);
  }
}

/**
 * Applies the node panel as one change (§10.5, §10.7, §10.9): type, label and form, a task's variant and its reference, a
 * gateway's decision (a person's question, or a condition), and its branches, which replace its flows on those branches. The
 * exits invalid for the new type go (E8), with the fields only the old type had. No change answers the same document.
 */
export function applyProperties(document: WorkflowDocument, nodeId: string, properties: NodeProperties): WorkflowDocument {
  if (!document.nodes.some((node) => node.id === nodeId)) {
    return document;
  }
  const laid = withLayout(document);
  const current = laid.nodes.find((node) => node.id === nodeId)!;
  const next = withProperties(current, properties);

  const removed = new Set(invalidExits(laid, nodeId, properties.type).map((flow) => flow.id));
  let flows = laid.flows.filter((flow) => !removed.has(flow.id));
  if (properties.type === 'gateway') {
    flows = branchTo(laid, flows, nodeId, 'true', properties.whenTrue);
    flows = branchTo(laid, flows, nodeId, 'false', properties.whenFalse);
  }

  const unchanged =
    JSON.stringify(next) === JSON.stringify(current) && flows.length === laid.flows.length && flows.every((flow, index) => flow === laid.flows[index]);
  return unchanged ? document : { ...laid, nodes: laid.nodes.map((node) => (node.id === nodeId ? next : node)), flows };
}

/** What the lane panel sets (§10.6). */
export interface LaneProperties {
  readonly title: string;
  readonly group: NonNullable<WorkflowLane['group']>;
}

/** Applies the lane panel, or a rename in place, as one change (§10.6); no change answers the same document. */
export function applyLaneProperties(document: WorkflowDocument, laneId: string, properties: LaneProperties): WorkflowDocument {
  const current = document.lanes.find((lane) => lane.id === laneId);
  if (!current || (current.title === properties.title && JSON.stringify(current.group) === JSON.stringify(properties.group))) {
    return document;
  }
  const laid = withLayout(document);
  return {
    ...laid,
    lanes: laid.lanes.map((lane) => (lane.id === laneId ? { ...lane, title: properties.title, group: properties.group } : lane)),
  };
}

/** Removes the given elements, the flows that touch a removed node, and a removed lane's claim on its nodes. */
export function remove(document: WorkflowDocument, ids: ReadonlySet<string>): WorkflowDocument {
  if (![...document.lanes, ...document.nodes, ...document.flows].some((element) => ids.has(element.id))) {
    return document;
  }
  const laid = withLayout(document);
  const removedLanes = new Set(laid.lanes.filter((lane) => ids.has(lane.id)).map((lane) => lane.id));
  const nodes = laid.nodes
    .filter((node) => !ids.has(node.id))
    .map((node) => (node.laneId !== undefined && removedLanes.has(node.laneId) ? withoutLane(node) : node));
  const remaining = new Set(nodes.map((node) => node.id));
  return {
    ...laid,
    lanes: laid.lanes.filter((lane) => !removedLanes.has(lane.id)),
    nodes,
    flows: laid.flows.filter((flow) => !ids.has(flow.id) && remaining.has(flow.source) && remaining.has(flow.target)),
  };
}

/** The draft without lanes, nodes or flows; its version and the fields the editor does not know stay. */
export function emptied(document: WorkflowDocument): WorkflowDocument {
  if (document.lanes.length === 0 && document.nodes.length === 0 && document.flows.length === 0) {
    return document;
  }
  return { ...document, lanes: [], nodes: [], flows: [] };
}

/** The lane under a point, the last one drawn when lanes overlap. */
function laneAt(document: WorkflowDocument, point: Point): string | undefined {
  return [...document.lanes].reverse().find((lane) => {
    const box = lane.layout;
    return box !== undefined && point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
  })?.id;
}

/** A node as the panel's properties make it, keeping what they do not touch. */
function withProperties(node: WorkflowNode, properties: NodeProperties): WorkflowNode {
  const next: Record<string, unknown> = { ...node, type: properties.type, label: properties.label };
  if (properties.type !== 'task') {
    TASK_FIELDS.forEach((field) => delete next[field]);
  } else {
    // A task keeps only its variant's reference (§9, §10.9): an automatic step's, or a sub-workflow's.
    next['taskKind'] = properties.taskKind;
    if (properties.taskKind === 'automation' && properties.automation) {
      next['automation'] = properties.automation;
    } else {
      delete next['automation'];
    }
    if (properties.taskKind === 'subprocess' && properties.workflow) {
      next['workflow'] = properties.workflow;
    } else {
      delete next['workflow'];
    }
  }
  if (properties.type !== 'gateway') {
    GATEWAY_FIELDS.forEach((field) => delete next[field]);
  } else {
    // A gateway keeps only what its decision mode uses (E9): the question, or the condition.
    next['decisionMode'] = properties.decisionMode;
    if (properties.decisionMode === 'human') {
      next['question'] = properties.question;
      delete next['condition'];
    } else {
      next['condition'] = properties.condition;
      delete next['question'];
    }
  }

  const takesForm = properties.type === 'start' || (properties.type === 'task' && next['taskKind'] === 'human');
  const formId = (node['form'] as { formId?: unknown } | undefined)?.formId;
  if (!takesForm || properties.formId === null) {
    delete next['form'];
  } else if (formId !== properties.formId) {
    next['form'] = { formId: properties.formId };
  }
  return next as WorkflowNode;
}

/** A gateway's flows with its flow on one branch going to `target`, or gone for null; one already going there stays. */
function branchTo(
  document: WorkflowDocument,
  flows: readonly WorkflowFlow[],
  gatewayId: string,
  branch: 'true' | 'false',
  target: string | null,
): WorkflowFlow[] {
  const existing = flows.find((flow) => flow.source === gatewayId && flow.branch === branch);
  if (existing?.target === target || target === gatewayId) {
    return [...flows];
  }
  const kept = flows.filter((flow) => flow !== existing);
  if (target === null) {
    return kept;
  }
  return [...kept, { id: nextId({ ...document, flows: kept }, 'flow'), source: gatewayId, target, branch }];
}

/** How a flow is drawn, in a document where every node has its layout. */
function drawnOf(document: WorkflowDocument, flow: WorkflowFlow): Routing | null {
  const source = document.nodes.find((node) => node.id === flow.source);
  const target = document.nodes.find((node) => node.id === flow.target);
  return source?.layout && target?.layout ? routing(source.layout, source.type, target.layout, flow) : null;
}

/** Stores the bend that `value` gives for the flow as drawn, kept between its ends; no change when it stays put. */
function bendTo(document: WorkflowDocument, flowId: string, value: (drawn: Routing) => number | null): WorkflowDocument {
  const laid = withLayout(document);
  const flow = laid.flows.find((candidate) => candidate.id === flowId);
  const drawn = flow ? drawnOf(laid, flow) : null;
  const wanted = drawn ? value(drawn) : null;
  if (!flow || !drawn || wanted === null) {
    return document;
  }
  const bend = keepBend(drawn, wanted);
  if (bend === drawn.bend) {
    return document;
  }
  const layout = { ...flow.layout, [drawn.mode === 'HV' ? 'bendX' : 'bendY']: bend };
  return { ...laid, flows: laid.flows.map((candidate) => (candidate.id === flowId ? { ...candidate, layout } : candidate)) };
}

/** A box pushed off each of the others it overlaps, in turn, the shortest way, `LANES_APART` from it. */
function apart(box: Box, others: readonly Box[]): Box {
  let result = box;
  for (const other of others) {
    if (!overlaps(result, other)) {
      continue;
    }
    const left = result.x + result.w - other.x;
    const right = other.x + other.w - result.x;
    const up = result.y + result.h - other.y;
    const down = other.y + other.h - result.y;
    const least = Math.min(left, right, up, down);
    if (least === left) {
      result = { ...result, x: other.x - result.w - LANES_APART };
    } else if (least === right) {
      result = { ...result, x: other.x + other.w + LANES_APART };
    } else if (least === up) {
      result = { ...result, y: other.y - result.h - LANES_APART };
    } else {
      result = { ...result, y: other.y + other.h + LANES_APART };
    }
  }
  return result;
}

/** The node without a lane: it then belongs to the requesters (workflow-definition.md §1). */
function withoutLane(node: WorkflowNode): WorkflowNode {
  const copy: Record<string, unknown> = { ...node };
  delete copy['laneId'];
  return copy as WorkflowNode;
}

function shiftBend(flow: WorkflowFlow, dx: number, dy: number): WorkflowFlow['layout'] {
  const layout = flow.layout!;
  return {
    ...layout,
    ...(layout.bendX !== undefined ? { bendX: layout.bendX + dx } : {}),
    ...(layout.bendY !== undefined ? { bendY: layout.bendY + dy } : {}),
  };
}
