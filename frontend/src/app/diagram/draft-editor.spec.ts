import { WorkflowDocument } from './workflow-document';
import { DraftEditor } from './draft-editor';

const DOCUMENT: WorkflowDocument = {
  schemaVersion: 1,
  lanes: [{ id: 'lane_a', title: 'Solicitantes', group: { kind: 'requesters' }, layout: { x: 40, y: 40, w: 800, h: 400 } }],
  nodes: [
    { id: 'start', type: 'start', label: 'Início', laneId: 'lane_a', layout: { x: 108, y: 108, w: 64, h: 64 } },
    { id: 'task_1', type: 'task', taskKind: 'human', label: 'Analisar', laneId: 'lane_a', layout: { x: 230, y: 105, w: 140, h: 70 } },
    { id: 'gw', type: 'gateway', label: 'Ok?', laneId: 'lane_a', decisionMode: 'human', question: 'Ok?', layout: { x: 445, y: 105, w: 70, h: 70 } },
  ],
  flows: [{ id: 'f1', source: 'start', target: 'task_1' }],
};

const CENTER = { x: 500, y: 300 };

function editing(document: WorkflowDocument = DOCUMENT): DraftEditor {
  const editor = new DraftEditor();
  editor.load(document);
  return editor;
}

const box = (editor: DraftEditor, id: string) => editor.document().nodes.find((node) => node.id === id)?.layout;
const selection = (editor: DraftEditor) => [...editor.selection()];

describe('DraftEditor (workflow-editor.md §10.2)', () => {
  it('starts from the loaded draft, with nothing to save, undo or redo', () => {
    const editor = editing();

    expect(editor.document()).toBe(DOCUMENT);
    expect(editor.dirty()).toBe(false);
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
    expect(editor.hasStart()).toBe(true);
  });

  it('adds nodes around the center in turn, selecting each; undo and redo walk the changes, and the selection follows', () => {
    const editor = editing();

    const first = editor.add('task', CENTER);
    const second = editor.add('task', CENTER);
    const third = editor.add('end', CENTER);
    const fourth = editor.add('task', CENTER);
    expect(box(editor, first!)).toEqual({ x: 420, y: 255, w: 140, h: 70 }); // centered on (490, 290)
    expect(box(editor, second!)).toEqual({ x: 430, y: 265, w: 140, h: 70 }); // (500, 300)
    expect(box(editor, third!)).toEqual({ x: 478, y: 278, w: 64, h: 64 }); // (510, 310)
    expect(box(editor, fourth!)).toEqual({ x: 420, y: 255, w: 140, h: 70 }); // (490, 290) again
    expect(selection(editor)).toEqual([fourth]);
    expect(editor.dirty()).toBe(true);

    editor.undo();
    expect(box(editor, fourth!)).toBeUndefined();
    expect(selection(editor)).toEqual([]); // the removed node is no longer selected
    expect(editor.canRedo()).toBe(true);
    editor.redo();
    expect(box(editor, fourth!)).toEqual({ x: 420, y: 255, w: 140, h: 70 });

    editor.undo();
    editor.add('gateway', CENTER);
    expect(editor.canRedo()).toBe(false); // a new change drops what was undone
  });

  it('refuses a second start', () => {
    const editor = editing();

    expect(editor.add('start', CENTER)).toBeNull();
    expect(editor.canUndo()).toBe(false);
    expect(editing({ ...DOCUMENT, nodes: [] }).hasStart()).toBe(false);
  });

  it('adds a lane, selected', () => {
    const editor = editing();

    const id = editor.addLane();
    expect(editor.document().lanes.map((lane) => lane.id)).toEqual(['lane_a', id]);
    expect(selection(editor)).toEqual([id]);
  });

  it('moves the selection, and nothing when nothing is selected', () => {
    const editor = editing();

    editor.nudge(10, 0);
    expect(editor.canUndo()).toBe(false);

    editor.select('task_1');
    editor.toggle('gw');
    editor.nudge(0, 50);
    expect(box(editor, 'task_1')).toEqual({ x: 230, y: 155, w: 140, h: 70 });
    expect(box(editor, 'gw')).toEqual({ x: 445, y: 155, w: 70, h: 70 });
    expect(box(editor, 'start')).toEqual({ x: 108, y: 108, w: 64, h: 64 });
  });

  it('resizes a lane by a corner, and the selected lanes from their bottom-right corner, each as one change', () => {
    const editor = editing();
    const laneBox = () => editor.document().lanes[0].layout;

    editor.resize('lane_a', 'br', 100, 0);
    expect(laneBox()).toEqual({ x: 40, y: 40, w: 900, h: 400 });
    editor.undo();
    expect(editor.document()).toBe(DOCUMENT);

    editor.select('lane_a');
    editor.toggle('task_1'); // not a lane: not resized
    editor.resizeSelectedLanes(0, 50);
    expect(laneBox()).toEqual({ x: 40, y: 40, w: 800, h: 450 });
    expect(box(editor, 'task_1')).toEqual({ x: 230, y: 105, w: 140, h: 70 });
    editor.undo();
    expect(editor.document()).toBe(DOCUMENT);
  });

  it('selects the nodes a box touches, with the flows between them; added to the selection on request', () => {
    const editor = editing();

    editor.selectBox({ x: 100, y: 100, w: 150, h: 30 }, false);
    expect(selection(editor)).toEqual(['start', 'task_1', 'f1']);

    editor.select('gw');
    editor.selectBox({ x: 0, y: 0, w: 120, h: 120 }, true);
    expect(selection(editor)).toEqual(['gw', 'start']);

    editor.selectBox({ x: 1000, y: 1000, w: 10, h: 10 }, false);
    expect(selection(editor)).toEqual([]);
    expect(editor.canUndo()).toBe(false); // selecting is no change
  });

  it('moves the bend of the one selected flow, switches its routing, and reconnects it, saying why it cannot (§10.4)', () => {
    // The task lower down: f1 then runs vertical first, from the start's bottom (172) to the task's top (305), bend at 240.
    const lower = { ...DOCUMENT, nodes: DOCUMENT.nodes.map((node) => (node.id === 'task_1' ? { ...node, layout: { x: 230, y: 305, w: 140, h: 70 } } : node)) };
    const editor = editing(lower);
    const f1 = () => editor.document().flows.find((flow) => flow.id === 'f1')!;

    editor.select('f1');
    editor.moveBend(0, 10);
    expect(f1().layout).toEqual({ bendY: 250 });
    editor.toggle('start');
    editor.moveBend(0, 10); // not one flow alone: the arrow keys move nodes instead
    expect(f1().layout).toEqual({ bendY: 250 });

    editor.setBend('f1', { x: 0, y: 203 });
    expect(f1().layout).toEqual({ bendY: 200 });
    editor.toggleRoute('f1');
    expect(f1().layout).toEqual({ mode: 'HV' });

    editor.reconnect('f1', 'source', 'gw');
    expect(editor.notice()).toBe('Escolha a saída verdadeira (✓) ou falsa (✗) da condicional.');
    editor.reconnect('f1', 'target', 'gw');
    expect(f1().target).toBe('gw');
    expect(selection(editor)).toEqual(['f1']);
    expect(editor.notice()).toBeNull();
  });

  it('applies the node panel as one change (§10.5)', () => {
    const editor = editing();

    editor.applyProperties('task_1', {
      type: 'end',
      taskKind: 'human',
      label: 'Encerrar',
      formId: null,
      automation: null,
      workflow: null,
      decisionMode: 'human',
      question: '',
      condition: null,
      whenTrue: null,
      whenFalse: null,
    });
    expect(editor.document().nodes.find((node) => node.id === 'task_1')).toMatchObject({ type: 'end', label: 'Encerrar' });
    editor.undo();
    expect(editor.document()).toBe(DOCUMENT);
    expect(editor.canUndo()).toBe(false);
  });

  it('applies the lane panel as one change (§10.6)', () => {
    const editor = editing();

    editor.applyLaneProperties('lane_a', { title: 'Clientes', group: { kind: 'group', groupId: 'g-7' } });
    expect(editor.document().lanes[0]).toMatchObject({ title: 'Clientes', group: { kind: 'group', groupId: 'g-7' } });
    editor.undo();
    expect(editor.document()).toBe(DOCUMENT);
  });

  it('keeps the last 200 changes', () => {
    const editor = editing();
    editor.select('task_1');

    for (let i = 0; i < 205; i++) {
      editor.nudge(10, 0);
    }
    let undone = 0;
    while (editor.canUndo()) {
      editor.undo();
      undone++;
    }
    expect(undone).toBe(200);
    expect(box(editor, 'task_1')!.x).toBe(230 + 5 * 10);
  });

  it('knows whether there is something to save: undoing back to the saved draft leaves nothing', () => {
    const editor = editing();
    editor.select('task_1');

    editor.nudge(10, 0);
    expect(editor.dirty()).toBe(true);
    editor.undo();
    expect(editor.dirty()).toBe(false);

    editor.nudge(10, 0);
    editor.markSaved(editor.document());
    expect(editor.dirty()).toBe(false);
    editor.undo();
    expect(editor.dirty()).toBe(true);
  });

  it('selects one, toggles, selects every node, and clears', () => {
    const editor = editing();

    editor.select('task_1');
    editor.toggle('f1');
    editor.toggle('task_1');
    expect(selection(editor)).toEqual(['f1']);
    editor.select('gw');
    expect(selection(editor)).toEqual(['gw']);
    editor.selectAll();
    expect(selection(editor)).toEqual(['start', 'task_1', 'gw']);
    editor.clearSelection();
    expect(selection(editor)).toEqual([]);
  });

  it('connects in two steps, says why it cannot, and selects the new flow', () => {
    const editor = editing();

    editor.startConnecting('start');
    expect(editor.notice()).toBe('“Início” já tem uma saída. Exclua o fluxo atual para ligar outro.');
    expect(editor.pending()).toBeNull();

    editor.startConnecting('gw', 'false');
    expect(editor.notice()).toBeNull();
    expect(editor.pending()).toEqual({ source: 'gw', branch: 'false' });
    editor.connectTo('gw');
    expect(editor.notice()).toBe('Um elemento não pode se ligar a si mesmo.');
    expect(editor.pending()).toEqual({ source: 'gw', branch: 'false' }); // another target can still be chosen

    editor.connectTo('start');
    expect(editor.pending()).toBeNull();
    expect(editor.notice()).toBeNull();
    expect(editor.document().flows.at(-1)).toEqual({ id: 'flow_1', source: 'gw', target: 'start', branch: 'false' });
    expect(selection(editor)).toEqual(['flow_1']);

    editor.startConnecting('task_1');
    editor.cancelConnecting();
    expect(editor.pending()).toBeNull();
    editor.startConnecting('task_1');
    editor.select('gw');
    expect(editor.pending()).toBeNull(); // choosing anything else cancels
  });

  it('removes the selection with the flows that touch it, and empties the draft; both can be undone', () => {
    const editor = editing();

    editor.select('task_1');
    editor.removeSelection();
    expect(editor.document().nodes.map((node) => node.id)).toEqual(['start', 'gw']);
    expect(editor.document().flows).toEqual([]);
    expect(selection(editor)).toEqual([]);

    editor.clear();
    expect(editor.document().nodes).toEqual([]);
    expect(editor.document().lanes).toEqual([]);
    editor.undo();
    editor.undo();
    expect(editor.document()).toBe(DOCUMENT);
  });

  it('starts over when another draft is loaded', () => {
    const editor = editing();
    editor.select('task_1');
    editor.nudge(10, 0);

    const other = { ...DOCUMENT, nodes: [] };
    editor.load(other);
    expect(editor.document()).toBe(other);
    expect(editor.dirty()).toBe(false);
    expect(editor.canUndo()).toBe(false);
    expect(selection(editor)).toEqual([]);
  });
});
