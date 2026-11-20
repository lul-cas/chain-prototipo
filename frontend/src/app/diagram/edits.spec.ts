import { WorkflowDocument } from './workflow-document';
import {
  NodeProperties,
  addLane,
  addNode,
  applyLaneProperties,
  applyProperties,
  connect,
  emptied,
  invalidExits,
  moveBend,
  moveBy,
  nextId,
  reconnect,
  remove,
  resizeLane,
  setBend,
  toggleRoute,
  withLayout,
} from './edits';
import { place } from './placement';

/** Two lanes, one above the other, with every element laid out; the centers are on the grid. */
const DOCUMENT: WorkflowDocument = {
  schemaVersion: 1,
  notes: 'a field the editor does not know',
  lanes: [
    { id: 'lane_a', title: 'Solicitantes', group: { kind: 'requesters' }, layout: { x: 40, y: 40, w: 800, h: 200 } },
    { id: 'lane_b', title: 'Análise', group: { kind: 'group', groupId: 'g-1' }, layout: { x: 40, y: 260, w: 800, h: 200 } },
  ],
  nodes: [
    { id: 'start', type: 'start', label: 'Início', laneId: 'lane_a', form: { formId: 'f-1' }, layout: { x: 108, y: 108, w: 64, h: 64 } },
    { id: 'task_1', type: 'task', taskKind: 'human', label: 'Analisar', laneId: 'lane_b', layout: { x: 230, y: 325, w: 140, h: 70 } },
    { id: 'gw', type: 'gateway', label: 'Ok?', laneId: 'lane_b', decisionMode: 'human', question: 'Ok?', layout: { x: 445, y: 325, w: 70, h: 70 } },
    { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_b', layout: { x: 668, y: 328, w: 64, h: 64 } },
  ],
  flows: [
    { id: 'f1', source: 'start', target: 'task_1' },
    { id: 'f2', source: 'task_1', target: 'gw', layout: { mode: 'HV', bendX: 400 } },
    { id: 'f3', source: 'gw', target: 'end', branch: 'true' },
  ],
};

/** The same journey as the API makes it: no layout anywhere, so it is drawn by the automatic placement. */
const UNPLACED: WorkflowDocument = {
  schemaVersion: 1,
  lanes: [{ id: 'lane_a', title: 'Solicitantes', group: { kind: 'requesters' } }],
  nodes: [
    { id: 'start', type: 'start', label: 'Início', laneId: 'lane_a' },
    { id: 'task_1', type: 'task', taskKind: 'human', label: 'Analisar', laneId: 'lane_a' },
    { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_a' },
  ],
  flows: [{ id: 'f1', source: 'start', target: 'task_1' }],
};

const node = (document: WorkflowDocument, id: string) => document.nodes.find((candidate) => candidate.id === id)!;
const lane = (document: WorkflowDocument, id: string) => document.lanes.find((candidate) => candidate.id === id)!;
const flowIds = (document: WorkflowDocument) => document.flows.map((flow) => flow.id);
const refused = (result: unknown) => (result as { refusal?: string }).refusal;

describe('editing a draft (workflow-editor.md §10.2)', () => {
  it('names a new element after its kind with the next number no element uses', () => {
    expect(nextId(DOCUMENT, 'task')).toBe('task_2');
    expect(nextId(DOCUMENT, 'lane')).toBe('lane_1');
    expect(nextId({ ...DOCUMENT, nodes: [...DOCUMENT.nodes, { ...node(DOCUMENT, 'end'), id: 'flow_1' }] }, 'flow')).toBe('flow_2');
  });

  it('adds a node centered on the grid, in the lane under its center, with the default label of its kind', () => {
    const { document, id } = addNode(DOCUMENT, 'task', { x: 493, y: 357 });

    expect(id).toBe('task_2');
    expect(node(document, id)).toEqual({
      id: 'task_2',
      type: 'task',
      taskKind: 'human',
      label: 'Nova etapa',
      laneId: 'lane_b',
      layout: { x: 420, y: 325, w: 140, h: 70 },
    });
    expect(DOCUMENT.nodes).toHaveLength(4); // the draft it came from is untouched

    const gateway = addNode(DOCUMENT, 'gateway', { x: 300, y: 140 });
    expect(node(gateway.document, gateway.id)).toEqual({
      id: 'gateway_1',
      type: 'gateway',
      label: 'Condicional',
      decisionMode: 'human',
      question: 'Condição?',
      laneId: 'lane_a',
      layout: { x: 265, y: 105, w: 70, h: 70 },
    });

    const outside = addNode(DOCUMENT, 'start', { x: 1000, y: 1000 });
    expect(node(outside.document, outside.id)).toEqual({
      id: 'start_1',
      type: 'start',
      label: 'Início',
      layout: { x: 968, y: 968, w: 64, h: 64 },
    });
    expect(node(addNode(DOCUMENT, 'end', { x: 0, y: 0 }).document, 'end_1').label).toBe('Fim');
  });

  it('adds a lane below everything else, as wide as the widest, for the requesters', () => {
    const { document, id } = addLane(DOCUMENT);
    expect(lane(document, id)).toEqual({
      id: 'lane_1',
      title: 'Nova área',
      group: { kind: 'requesters' },
      layout: { x: 40, y: 480, w: 800, h: 200 },
    });

    const wide = addLane({ ...DOCUMENT, lanes: [DOCUMENT.lanes[0], { ...DOCUMENT.lanes[1], layout: { x: 20, y: 260, w: 1200, h: 200 } }] });
    expect(lane(wide.document, wide.id).layout).toEqual({ x: 20, y: 480, w: 1200, h: 200 });

    const empty = { schemaVersion: 1, lanes: [], nodes: [], flows: [] };
    expect(lane(addLane(empty).document, 'lane_1').layout).toEqual({ x: 40, y: 40, w: 800, h: 200 });

    const belowANode = addLane({ ...empty, nodes: [{ ...node(DOCUMENT, 'start'), laneId: undefined }] });
    expect(lane(belowANode.document, 'lane_1').layout).toEqual({ x: 40, y: 200, w: 800, h: 200 }); // the node ends at 172
  });

  it('moves nodes, which then join the lane under their center, or none', () => {
    const up = moveBy(DOCUMENT, new Set(['task_1']), 0, -250);
    expect(node(up, 'task_1').layout).toEqual({ x: 230, y: 75, w: 140, h: 70 });
    expect(node(up, 'task_1').laneId).toBe('lane_a');

    const away = moveBy(DOCUMENT, new Set(['task_1']), 1000, 0);
    expect(away.flows.find((flow) => flow.id === 'f2')!.layout).toEqual({ mode: 'HV', bendX: 400 }); // one end moved: the bend stays
    expect('laneId' in node(away, 'task_1')).toBe(false);
    expect(node(away, 'start')).toBe(node(DOCUMENT, 'start'));
  });

  it('moves a lane with its nodes, and a flow between two moved nodes keeps its shape', () => {
    const moved = moveBy(DOCUMENT, new Set(['lane_b']), 10, 20);

    expect(lane(moved, 'lane_b').layout).toEqual({ x: 50, y: 280, w: 800, h: 200 });
    expect(node(moved, 'task_1').layout).toEqual({ x: 240, y: 345, w: 140, h: 70 });
    expect(node(moved, 'end').laneId).toBe('lane_b');
    expect(node(moved, 'start').layout).toEqual({ x: 108, y: 108, w: 64, h: 64 });
    expect(moved.flows.find((flow) => flow.id === 'f2')!.layout).toEqual({ mode: 'HV', bendX: 410 });
    expect(moved.flows.find((flow) => flow.id === 'f1')).toBe(DOCUMENT.flows[0]);

    // Lanes can still overlap when they come so from the API: a node moved into both joins the one drawn on top.
    const stacked = { ...DOCUMENT, lanes: [{ ...DOCUMENT.lanes[0], layout: { x: 40, y: 260, w: 800, h: 200 } }, DOCUMENT.lanes[1]] };
    expect(node(moveBy(stacked, new Set(['start']), 0, 220), 'start').laneId).toBe('lane_b');

    const both = moveBy(DOCUMENT, new Set(['lane_b', 'task_1']), 10, 0);
    expect(node(both, 'task_1').layout!.x).toBe(240); // once, not twice

    expect(moveBy(DOCUMENT, new Set(['f1']), 10, 10)).toBe(DOCUMENT); // nothing to move: the same draft
  });

  it('keeps lanes apart: a lane moved onto another is pushed off it the shortest way, 4 px apart, with its nodes', () => {
    // lane_a moved 100 down overlaps lane_b by 80: pushed back up to 4 px above it, it moved 16 in all.
    const moved = moveBy(DOCUMENT, new Set(['lane_a']), 0, 100);
    expect(lane(moved, 'lane_a').layout).toEqual({ x: 40, y: 56, w: 800, h: 200 });
    expect(node(moved, 'start').layout).toEqual({ x: 108, y: 124, w: 64, h: 64 });
    expect(lane(moved, 'lane_b')).toBe(lane(DOCUMENT, 'lane_b'));

    // Moved 700 right instead, it overlaps nothing, and stays where it was put.
    expect(lane(moveBy(DOCUMENT, new Set(['lane_a']), 700, 0), 'lane_a').layout).toEqual({ x: 740, y: 40, w: 800, h: 200 });

    // Pushed sideways when that is shorter: 760 right and 120 down overlaps lane_b by 40 across and 100 down.
    expect(lane(moveBy(DOCUMENT, new Set(['lane_a']), 760, 120), 'lane_a').layout).toEqual({ x: 844, y: 160, w: 800, h: 200 });
  });

  it('resizes a lane from any corner by whole grid steps, to at least 200 × 120, and leaves its nodes alone', () => {
    expect(lane(resizeLane(DOCUMENT, 'lane_b', 'br', 33, 47), 'lane_b').layout).toEqual({ x: 40, y: 260, w: 830, h: 250 });
    expect(lane(resizeLane(DOCUMENT, 'lane_b', 'tl', -20, -21), 'lane_b').layout).toEqual({ x: 20, y: 240, w: 820, h: 220 });
    expect(lane(resizeLane(DOCUMENT, 'lane_b', 'tr', 10, 10), 'lane_b').layout).toEqual({ x: 40, y: 270, w: 810, h: 190 });
    expect(lane(resizeLane(DOCUMENT, 'lane_b', 'bl', 10, 10), 'lane_b').layout).toEqual({ x: 50, y: 260, w: 790, h: 210 });

    expect(lane(resizeLane(DOCUMENT, 'lane_b', 'br', -700, -150), 'lane_b').layout).toEqual({ x: 40, y: 260, w: 200, h: 120 });
    expect(lane(resizeLane(DOCUMENT, 'lane_b', 'tl', 700, 150), 'lane_b').layout).toEqual({ x: 640, y: 340, w: 200, h: 120 });

    const resized = resizeLane(DOCUMENT, 'lane_b', 'br', 100, 0);
    expect(resized.nodes).toBe(DOCUMENT.nodes);
    expect(resizeLane(DOCUMENT, 'lane_b', 'br', 2, -3)).toBe(DOCUMENT); // less than half a step: no change
    const smallest = resizeLane(DOCUMENT, 'lane_b', 'br', -700, -150);
    expect(resizeLane(smallest, 'lane_b', 'br', -10, -10)).toBe(smallest); // already at its minimum: no change
  });

  it('connects a node that has no exit yet; a start or task refuses a second one (E3), and an end has none', () => {
    const withoutExit = remove(DOCUMENT, new Set(['f2']));
    const connected = connect(withoutExit, 'task_1', 'end');
    expect('document' in connected && connected.document.flows.at(-1)).toEqual({ id: 'flow_1', source: 'task_1', target: 'end' });

    expect(refused(connect(DOCUMENT, 'task_1', 'end'))).toBe('“Analisar” já tem uma saída. Exclua o fluxo atual para ligar outro.');
    expect(refused(connect(DOCUMENT, 'end', 'task_1'))).toBe('O fim não tem saída.');
    expect(refused(connect(withoutExit, 'task_1', 'task_1'))).toBe('Um elemento não pode se ligar a si mesmo.');
  });

  it('gives a gateway one true and one false flow, a new one replacing the old, and allows going back to the start', () => {
    const whenFalse = connect(DOCUMENT, 'gw', 'start', 'false');
    expect('document' in whenFalse && whenFalse.document.flows.at(-1)).toEqual({ id: 'flow_1', source: 'gw', target: 'start', branch: 'false' });

    const replaced = connect(DOCUMENT, 'gw', 'task_1', 'true');
    expect('document' in replaced && flowIds(replaced.document)).toEqual(['f1', 'f2', 'flow_1']);
    expect('document' in replaced && replaced.document.flows.at(-1)).toEqual({ id: 'flow_1', source: 'gw', target: 'task_1', branch: 'true' });

    expect(refused(connect(DOCUMENT, 'gw', 'end'))).toBe('Escolha a saída verdadeira (✓) ou falsa (✗) da condicional.');
  });

  describe('flows (§10.4)', () => {
    // f1 runs from the start (center 140, 140) down to the task (300, 360): farther down than across, so vertical first,
    // from the start's bottom (172) to the task's top (325), with its bend in the middle, at 250.
    const flow = (document: WorkflowDocument, id: string) => document.flows.find((candidate) => candidate.id === id)!;

    it('moves the bend of a flow along its routing, between the ends, on the grid', () => {
      expect(flow(moveBend(DOCUMENT, 'f1', 0, 10), 'f1').layout).toEqual({ bendY: 260 });
      expect(moveBend(DOCUMENT, 'f1', 10, 0)).toBe(DOCUMENT); // vertical first: across moves nothing
      expect(flow(moveBend(DOCUMENT, 'f1', 0, 1000), 'f1').layout).toEqual({ bendY: 320 }); // kept 8 px above the task
      expect(moveBend(DOCUMENT, 'f2', 10, 10)).toBe(DOCUMENT); // straight: no bend
      expect(flow(setBend(DOCUMENT, 'f1', { x: 0, y: 203 }), 'f1').layout).toEqual({ bendY: 200 });
    });

    it('switches the routing of a flow, with its bend back in the middle (E10)', () => {
      expect(flow(toggleRoute(DOCUMENT, 'f1'), 'f1').layout).toEqual({ mode: 'HV' });
      expect(flow(toggleRoute(DOCUMENT, 'f2'), 'f2').layout).toEqual({ mode: 'VH' }); // f2 had HV and a bend
    });

    it('reconnects an end of a flow by the rules of connecting', () => {
      const withTask = { ...DOCUMENT, nodes: [...DOCUMENT.nodes, { ...node(DOCUMENT, 'task_1'), id: 'task_9', label: 'Revisar' }] };
      const moved = (result: unknown) => (result as { document: WorkflowDocument }).document;

      expect(flow(moved(reconnect(DOCUMENT, 'f1', 'target', 'gw')), 'f1')).toEqual({ id: 'f1', source: 'start', target: 'gw' });
      expect(flow(moved(reconnect(withTask, 'f1', 'source', 'task_9')), 'f1').source).toBe('task_9');
      expect(reconnect(DOCUMENT, 'f1', 'target', 'task_1')).toEqual({ document: DOCUMENT, id: 'f1' }); // no change

      expect(refused(reconnect(DOCUMENT, 'f1', 'target', 'start'))).toBe('Um elemento não pode se ligar a si mesmo.');
      expect(refused(reconnect(DOCUMENT, 'f1', 'source', 'end'))).toBe('O fim não tem saída.');
      expect(refused(reconnect(DOCUMENT, 'f1', 'source', 'gw'))).toBe('Escolha a saída verdadeira (✓) ou falsa (✗) da condicional.');
      expect(refused(reconnect(withTask, 'f2', 'source', 'start'))).toBe('“Início” já tem uma saída. Exclua o fluxo atual para ligar outro.');
      expect(refused(reconnect(DOCUMENT, 'f3', 'source', 'task_1'))).toBe('Uma saída verdadeira ou falsa sai de uma condicional.');
    });

    it('moves a gateway flow to another gateway, replacing that one\'s flow on the same branch', () => {
      const gw2 = { ...node(DOCUMENT, 'gw'), id: 'gw2', label: 'De novo?' };
      const document = { ...DOCUMENT, nodes: [...DOCUMENT.nodes, gw2], flows: [...DOCUMENT.flows, { id: 'f9', source: 'gw2', target: 'start', branch: 'true' as const }] };

      const result = reconnect(document, 'f3', 'source', 'gw2');
      expect('document' in result && result.document.flows.map((candidate) => [candidate.id, candidate.source, candidate.branch ?? null])).toEqual([
        ['f1', 'start', null],
        ['f2', 'task_1', null],
        ['f3', 'gw2', 'true'],
      ]);
    });
  });

  describe('the node panel (§10.5)', () => {
    const as = (type: NodeProperties['type'], changes: Partial<NodeProperties> = {}): NodeProperties => ({
      type,
      taskKind: 'human',
      label: 'Analisar',
      formId: null,
      automation: null,
      workflow: null,
      decisionMode: 'human',
      question: '',
      condition: null,
      whenTrue: null,
      whenFalse: null,
      ...changes,
    });
    const flowIdsOf = (document: WorkflowDocument) => document.flows.map((candidate) => `${candidate.id}:${candidate.source}>${candidate.target}${candidate.branch ? `:${candidate.branch}` : ''}`);

    it('tells which exits a new type leaves invalid (E8)', () => {
      expect(invalidExits(DOCUMENT, 'task_1', 'end').map((candidate) => candidate.id)).toEqual(['f2']);
      expect(invalidExits(DOCUMENT, 'gw', 'end').map((candidate) => candidate.id)).toEqual(['f3']); // branches too
      expect(invalidExits(DOCUMENT, 'task_1', 'gateway').map((candidate) => candidate.id)).toEqual(['f2']);
      expect(invalidExits(DOCUMENT, 'gw', 'task').map((candidate) => candidate.id)).toEqual(['f3']);
      expect(invalidExits(DOCUMENT, 'gw', 'gateway')).toEqual([]);
      expect(invalidExits(DOCUMENT, 'task_1', 'start')).toEqual([]);
    });

    it('sets the label and the form, keeping a form left as it was, and is no change when nothing differs', () => {
      const renamed = applyProperties(DOCUMENT, 'task_1', as('task', { label: 'Analisar proposta', formId: 'f-9' }));
      expect(node(renamed, 'task_1')).toEqual({
        id: 'task_1',
        type: 'task',
        taskKind: 'human',
        label: 'Analisar proposta',
        laneId: 'lane_b',
        form: { formId: 'f-9' },
        layout: { x: 230, y: 325, w: 140, h: 70 },
      });

      const start = applyProperties(DOCUMENT, 'start', as('start', { label: 'Começo', formId: 'f-1' }));
      expect(node(start, 'start')['form']).toBe(node(DOCUMENT, 'start')['form']);
      expect('form' in node(applyProperties(DOCUMENT, 'start', as('start', { label: 'Início' })), 'start')).toBe(false);

      expect(applyProperties(DOCUMENT, 'task_1', as('task'))).toBe(DOCUMENT);
    });

    it('turns a task into an end without its exit and its form, and a gateway into a task without its branches', () => {
      const withForm = applyProperties(DOCUMENT, 'task_1', as('task', { formId: 'f-9' }));
      const ended = applyProperties(withForm, 'task_1', as('end', { label: 'Fim da análise', formId: 'f-9' }));
      expect(node(ended, 'task_1')).toEqual({ id: 'task_1', type: 'end', label: 'Fim da análise', laneId: 'lane_b', layout: { x: 230, y: 325, w: 140, h: 70 } });
      expect(flowIdsOf(ended)).toEqual(['f1:start>task_1', 'f3:gw>end:true']);

      const tasked = applyProperties(DOCUMENT, 'gw', as('task', { label: 'Ok?' }));
      expect(node(tasked, 'gw')).toEqual({ id: 'gw', type: 'task', label: 'Ok?', laneId: 'lane_b', layout: { x: 445, y: 325, w: 70, h: 70 }, taskKind: 'human' });
      expect(flowIdsOf(tasked)).toEqual(['f1:start>task_1', 'f2:task_1>gw']);
    });

    it('turns a task into a gateway decided by a person, with its branches, dropping its plain exit', () => {
      const gateway = applyProperties(DOCUMENT, 'task_1', as('gateway', { question: 'Analisar?', whenTrue: 'end', whenFalse: 'start' }));

      expect(node(gateway, 'task_1')).toEqual({
        id: 'task_1',
        type: 'gateway',
        label: 'Analisar',
        laneId: 'lane_b',
        layout: { x: 230, y: 325, w: 140, h: 70 },
        decisionMode: 'human',
        question: 'Analisar?',
      });
      expect(flowIdsOf(gateway)).toEqual(['f1:start>task_1', 'f3:gw>end:true', 'flow_1:task_1>end:true', 'flow_2:task_1>start:false']);
    });

    it('sets a gateway\'s question and branches, keeping a branch left as it was and removing one set to none', () => {
      const changed = applyProperties(DOCUMENT, 'gw', as('gateway', { label: 'Ok?', question: 'Tudo certo?', whenTrue: 'task_1', whenFalse: 'end' }));
      expect(node(changed, 'gw')['question']).toBe('Tudo certo?');
      expect(flowIdsOf(changed)).toEqual(['f1:start>task_1', 'f2:task_1>gw', 'flow_1:gw>task_1:true', 'flow_2:gw>end:false']);

      const kept = applyProperties(DOCUMENT, 'gw', as('gateway', { label: 'Ok?', question: 'Ok?', whenTrue: 'end', whenFalse: 'task_1' }));
      expect(kept.flows.find((candidate) => candidate.id === 'f3')).toBe(DOCUMENT.flows[2]);

      expect(flowIdsOf(applyProperties(DOCUMENT, 'gw', as('gateway', { label: 'Ok?', question: 'Ok?' })))).toEqual(['f1:start>task_1', 'f2:task_1>gw']);
    });

    it("makes a step automatic with its automation and no form, and a person's step again without it (§10.9)", () => {
      const automation = { automationId: 'a-1', inputs: { cpf: { kind: 'path', path: ['cpf'] } } };
      const withForm = applyProperties(DOCUMENT, 'task_1', as('task', { formId: 'f-9' }));

      const automatic = applyProperties(withForm, 'task_1', as('task', { label: 'Consultar', taskKind: 'automation', automation, formId: 'f-9' }));
      expect(node(automatic, 'task_1')).toEqual({ ...node(DOCUMENT, 'task_1'), label: 'Consultar', taskKind: 'automation', automation });
      const none = applyProperties(withForm, 'task_1', as('task', { taskKind: 'automation' }));
      expect(node(none, 'task_1')).toEqual({ ...node(DOCUMENT, 'task_1'), taskKind: 'automation' }); // publishing reports it (WF014)
      expect(applyProperties(automatic, 'task_1', as('task', { label: 'Consultar', taskKind: 'automation', automation: { ...automation } }))).toBe(automatic);

      const person = applyProperties(automatic, 'task_1', as('task', { label: 'Consultar', formId: 'f-2', automation })); // only an automatic step keeps one
      expect(node(person, 'task_1')).toEqual({ ...node(DOCUMENT, 'task_1'), label: 'Consultar', taskKind: 'human', form: { formId: 'f-2' } });
    });

    it('makes a step a sub-workflow with its process and no form, and drops the process with the variant (§10.10)', () => {
      const workflow = { workflowId: 'w-9', inputs: { cliente: { kind: 'path', path: ['cliente'] } } };
      const withForm = applyProperties(DOCUMENT, 'task_1', as('task', { formId: 'f-9' }));

      const sub = applyProperties(withForm, 'task_1', as('task', { label: 'Sub', taskKind: 'subprocess', workflow, formId: 'f-9' }));
      expect(node(sub, 'task_1')).toEqual({ ...node(DOCUMENT, 'task_1'), label: 'Sub', taskKind: 'subprocess', workflow });
      expect(node(applyProperties(DOCUMENT, 'task_1', as('task', { taskKind: 'subprocess' })), 'task_1')).toEqual({ ...node(DOCUMENT, 'task_1'), taskKind: 'subprocess' }); // WF014
      expect('workflow' in node(applyProperties(sub, 'task_1', as('task', { taskKind: 'automation', workflow })), 'task_1')).toBe(false);
      expect('workflow' in node(applyProperties(sub, 'task_1', as('task', { workflow })), 'task_1')).toBe(false);
      expect('automation' in node(applyProperties(sub, 'task_1', as('task', { taskKind: 'subprocess', workflow, automation: { automationId: 'a-1' } })), 'task_1')).toBe(false);
    });

    it('decides a gateway by a person with a question, or automatically with a condition, keeping only the chosen one (E9, §10.7)', () => {
      const condition = { kind: 'group', op: 'and', items: [{ kind: 'compare', left: { kind: 'path', path: ['valor'] }, operator: 'isEmpty' }] };

      const automatic = applyProperties(DOCUMENT, 'gw', as('gateway', { label: 'Ok?', decisionMode: 'automatic', question: 'ignored', condition, whenTrue: 'end' }));
      expect(node(automatic, 'gw')).toMatchObject({ decisionMode: 'automatic', condition });
      expect('question' in node(automatic, 'gw')).toBe(false);

      const human = applyProperties(automatic, 'gw', as('gateway', { label: 'Ok?', decisionMode: 'human', question: 'Está ok?', condition, whenTrue: 'end' }));
      expect(node(human, 'gw')).toMatchObject({ decisionMode: 'human', question: 'Está ok?' });
      expect('condition' in node(human, 'gw')).toBe(false);

      const fromTask = applyProperties(DOCUMENT, 'task_1', as('gateway', { decisionMode: 'automatic', condition }));
      expect(node(fromTask, 'task_1')).toMatchObject({ type: 'gateway', decisionMode: 'automatic', condition });
    });
  });

  it('sets a lane\'s title and group, keeping what it does not know, and is no change when nothing differs (§10.6)', () => {
    const renamed = applyLaneProperties({ ...DOCUMENT, lanes: [{ ...lane(DOCUMENT, 'lane_a'), color: 'kept' }, DOCUMENT.lanes[1]] }, 'lane_a', {
      title: 'Clientes',
      group: { kind: 'group', groupId: 'g-7' },
    });
    expect(lane(renamed, 'lane_a')).toEqual({
      id: 'lane_a',
      title: 'Clientes',
      group: { kind: 'group', groupId: 'g-7' },
      layout: { x: 40, y: 40, w: 800, h: 200 },
      color: 'kept',
    });
    expect(lane(applyLaneProperties(DOCUMENT, 'lane_b', { title: 'Análise', group: { kind: 'requesters' } }), 'lane_b').group).toEqual({ kind: 'requesters' });

    expect(applyLaneProperties(DOCUMENT, 'lane_b', { title: 'Análise', group: { kind: 'group', groupId: 'g-1' } })).toBe(DOCUMENT);
    expect(applyLaneProperties(DOCUMENT, 'nothing', { title: 'x', group: { kind: 'requesters' } })).toBe(DOCUMENT);
  });

  it('removes nodes with the flows that touch them, and a lane without its nodes, which then have no lane', () => {
    const withoutTask = remove(DOCUMENT, new Set(['task_1']));
    expect(withoutTask.nodes.map((candidate) => candidate.id)).toEqual(['start', 'gw', 'end']);
    expect(flowIds(withoutTask)).toEqual(['f3']);

    const withoutLane = remove(DOCUMENT, new Set(['lane_b']));
    expect(withoutLane.lanes.map((candidate) => candidate.id)).toEqual(['lane_a']);
    expect(withoutLane.nodes.map((candidate) => candidate.laneId ?? null)).toEqual(['lane_a', null, null, null]);
    expect(flowIds(withoutLane)).toEqual(['f1', 'f2', 'f3']);

    expect(flowIds(remove(DOCUMENT, new Set(['f3'])))).toEqual(['f1', 'f2']);
    expect(remove(DOCUMENT, new Set(['nothing']))).toBe(DOCUMENT);
  });

  it('writes the automatic placement into the draft at the first change, so nothing else moves', () => {
    const before = place(UNPLACED);
    const laid = withLayout(UNPLACED);
    expect(laid.lanes.map((candidate) => candidate.layout)).toEqual([before.lanes.get('lane_a')]);
    expect(laid.nodes.map((candidate) => candidate.layout)).toEqual(['start', 'task_1', 'end'].map((id) => before.nodes.get(id)));
    expect(withLayout(laid)).toBe(laid);

    // Connecting the task to the end would move the end to another column if it were still placed automatically.
    const connected = connect(UNPLACED, 'task_1', 'end');
    expect('document' in connected && node(connected.document, 'end').layout).toEqual(before.nodes.get('end'));
  });

  it('keeps the fields it does not know, and empties the draft keeping its version', () => {
    const moved = moveBy(DOCUMENT, new Set(['start']), 10, 0);
    expect(node(moved, 'start')['form']).toEqual({ formId: 'f-1' });
    expect(moved['notes']).toBe('a field the editor does not know');

    expect(emptied(DOCUMENT)).toEqual({ schemaVersion: 1, notes: 'a field the editor does not know', lanes: [], nodes: [], flows: [] });
    const empty = emptied(DOCUMENT);
    expect(emptied(empty)).toBe(empty);
  });
});
