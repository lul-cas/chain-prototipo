import { WorkflowDocument, WorkflowNode } from './workflow-document';
import { place } from './placement';

const node = (id: string, type: WorkflowNode['type'], laneId?: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  type,
  label: id,
  ...(laneId ? { laneId } : {}),
  ...extra,
});

const flow = (source: string, target: string, branch?: 'true' | 'false') => ({ id: `${source}-${target}`, source, target, branch });

/** The credit journey of the end-to-end tests, made through the API: no layout anywhere. */
const credit: WorkflowDocument = {
  schemaVersion: 1,
  lanes: [
    { id: 'lane_req', title: 'Solicitantes', group: { kind: 'requesters' } },
    { id: 'lane_an', title: 'Análise', group: { kind: 'group', groupId: 'g-1' } },
  ],
  nodes: [node('start', 'start', 'lane_req'), node('analyse', 'task', 'lane_an'), node('docs_ok', 'gateway', 'lane_an'), node('end', 'end', 'lane_an')],
  flows: [flow('start', 'analyse'), flow('analyse', 'docs_ok'), flow('docs_ok', 'end', 'true'), flow('docs_ok', 'analyse', 'false')],
};

describe('automatic placement (workflow-editor.md §10.1)', () => {
  it('places nodes in columns by their distance from the start, and each lane as a band around its nodes', () => {
    const placement = place(credit);

    expect(placement.nodes.get('start')).toEqual({ x: 158, y: 68, w: 64, h: 64 });
    expect(placement.nodes.get('analyse')).toEqual({ x: 320, y: 205, w: 140, h: 70 });
    expect(placement.nodes.get('docs_ok')).toEqual({ x: 555, y: 205, w: 70, h: 70 });
    expect(placement.nodes.get('end')).toEqual({ x: 758, y: 208, w: 64, h: 64 });
    expect(placement.lanes.get('lane_req')).toEqual({ x: 40, y: 40, w: 870, h: 120 });
    expect(placement.lanes.get('lane_an')).toEqual({ x: 40, y: 180, w: 870, h: 120 });
  });

  it('is the same every time for the same document', () => {
    expect(place(credit)).toEqual(place(structuredClone(credit)));
  });

  it('keeps stored layouts and places only what has none', () => {
    const stored = { x: 500, y: 600, w: 64, h: 64 };
    const laneStored = { x: 0, y: 0, w: 10, h: 10 };
    const document = {
      ...credit,
      lanes: [{ ...credit.lanes[0], layout: laneStored }, credit.lanes[1]],
      nodes: [{ ...credit.nodes[0], layout: stored }, ...credit.nodes.slice(1)],
    };

    const placement = place(document);
    expect(placement.nodes.get('start')).toBe(stored);
    expect(placement.lanes.get('lane_req')).toBe(laneStored);
    expect(placement.nodes.get('analyse')).toEqual({ x: 320, y: 205, w: 140, h: 70 });
  });

  it('stacks nodes of one lane and column in document order, and the band grows to hold them', () => {
    const document: WorkflowDocument = {
      schemaVersion: 1,
      lanes: [{ id: 'l', title: 'L' }],
      nodes: [node('s', 'start', 'l'), node('a', 'task', 'l'), node('b', 'task', 'l')],
      flows: [flow('s', 'a'), flow('s', 'b')],
    };

    const placement = place(document);
    expect(placement.nodes.get('a')).toEqual({ x: 320, y: 65, w: 140, h: 70 });
    expect(placement.nodes.get('b')).toEqual({ x: 320, y: 185, w: 140, h: 70 });
    expect(placement.lanes.get('l')?.h).toBe(240);
  });

  it('puts a node the start does not reach in a last column, and nodes outside any lane in a band above the lanes', () => {
    const document: WorkflowDocument = {
      schemaVersion: 1,
      lanes: [{ id: 'l', title: 'L' }],
      nodes: [node('s', 'start'), node('a', 'task', 'l'), node('lost', 'task', 'l')],
      flows: [flow('s', 'a')],
    };

    const placement = place(document);
    expect(placement.nodes.get('s')).toEqual({ x: 158, y: 68, w: 64, h: 64 });
    expect(placement.nodes.get('a')).toEqual({ x: 320, y: 205, w: 140, h: 70 });
    expect(placement.nodes.get('lost')).toEqual({ x: 520, y: 205, w: 140, h: 70 });
    expect(placement.lanes.get('l')).toEqual({ x: 40, y: 180, w: 670, h: 120 });
  });

  it('starts from the nodes nothing flows into when there is no start node', () => {
    const document: WorkflowDocument = {
      schemaVersion: 1,
      lanes: [],
      nodes: [node('b', 'task'), node('a', 'task')],
      flows: [flow('a', 'b')],
    };

    const placement = place(document);
    expect(placement.nodes.get('a')?.x).toBe(120);
    expect(placement.nodes.get('b')?.x).toBe(320);
  });

  // Card #201: a node's type comes from the stored document, so a name every object inherits is an unknown type.
  it.each(['constructor', 'toString', '__proto__'])('sizes a node of an unknown type such as %s as a task', (type) => {
    const placed = (nodeType: string) =>
      place({ schemaVersion: 1, lanes: [], nodes: [node('s', 'start'), node('odd', nodeType as WorkflowNode['type'])], flows: [flow('s', 'odd')] }).nodes.get('odd');

    expect(placed(type)).toEqual(placed('task'));
    expect(placed(type)).toMatchObject({ w: 140, h: 70 });
  });
});
