import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../testing/axe';
import { THEMES, applyTheme } from '../../testing/themes';
import { WorkflowDocument } from './workflow-document';
import { DraftEditor } from './draft-editor';
import { place } from './placement';
import { WorkflowCanvas } from './workflow-canvas';

/** The credit journey with an automation step and a sub-workflow, made through the API: no layout anywhere. */
const DOCUMENT: WorkflowDocument = {
  schemaVersion: 1,
  lanes: [
    { id: 'lane_req', title: 'Solicitantes', group: { kind: 'requesters' } },
    { id: 'lane_an', title: 'Análise', group: { kind: 'group', groupId: 'g-1' } },
  ],
  nodes: [
    { id: 'start', type: 'start', label: 'Início', laneId: 'lane_req' },
    { id: 'consulta', type: 'task', taskKind: 'automation', label: 'Consultar CPF', laneId: 'lane_req' },
    { id: 'analyse', type: 'task', taskKind: 'human', label: 'Analisar proposta', laneId: 'lane_an' },
    { id: 'docs_ok', type: 'gateway', label: 'Docs ok?', laneId: 'lane_an', decisionMode: 'human' },
    { id: 'cadastro', type: 'task', taskKind: 'subprocess', label: 'Cadastrar cliente', laneId: 'lane_an' },
    { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_an' },
  ],
  flows: [
    { id: 'f1', source: 'start', target: 'consulta' },
    { id: 'f2', source: 'consulta', target: 'analyse' },
    { id: 'f3', source: 'analyse', target: 'docs_ok' },
    { id: 'f4', source: 'docs_ok', target: 'cadastro', branch: 'true' },
    { id: 'f5', source: 'docs_ok', target: 'analyse', branch: 'false' },
    { id: 'f6', source: 'cadastro', target: 'end' },
  ],
};

async function draw(problems: readonly string[] = []) {
  const view = await render(WorkflowCanvas, { inputs: { document: DOCUMENT, problems: new Set(problems) } });
  return { view, canvas: view.fixture.componentInstance, scene: () => view.container.querySelector('.chain-canvas__scene')! };
}

const scale = (transform: string | null) => Number(/scale\(([\d.]+)\)/.exec(transform ?? '')?.[1]);

describe('WorkflowCanvas (workflow-editor.md §3, §10.1)', () => {
  it('draws every lane, node and flow, each with an accessible name', async () => {
    await draw();

    expect(screen.getByRole('group', { name: 'Diagrama do processo' })).toBeTruthy();
    for (const name of [
      'Área: Solicitantes',
      'Área: Análise',
      'Início: Início',
      'Etapa automática: Consultar CPF',
      'Etapa: Analisar proposta',
      'Condicional: Docs ok?',
      'Subprocesso: Cadastrar cliente',
      'Fim: Fim',
      'Fluxo de Início para Consultar CPF',
      'Fluxo de Docs ok? para Cadastrar cliente, se verdadeiro',
      'Fluxo de Docs ok? para Analisar proposta, se falso',
    ]) {
      expect(screen.getByRole('img', { name })).toBeTruthy();
    }
  });

  it('marks the variants in their corner, and the gateway flows with a check and a cross besides their color', async () => {
    await draw();

    expect(screen.getByRole('img', { name: 'Etapa automática: Consultar CPF' }).textContent).toContain('⚙');
    expect(screen.getByRole('img', { name: 'Subprocesso: Cadastrar cliente' }).textContent).toContain('⧉');
    const whenTrue = screen.getByRole('img', { name: 'Fluxo de Docs ok? para Cadastrar cliente, se verdadeiro' });
    const whenFalse = screen.getByRole('img', { name: 'Fluxo de Docs ok? para Analisar proposta, se falso' });
    expect(whenTrue.classList).toContain('chain-canvas__flow--true');
    expect(whenTrue.textContent).toContain('✓');
    expect(whenFalse.classList).toContain('chain-canvas__flow--false');
    expect(whenFalse.textContent).toContain('✗');
  });

  it('outlines the elements the server found problems in, and says so in their names', async () => {
    await draw(['docs_ok', 'lane_an', 'f6']);

    expect(screen.getByRole('img', { name: 'Condicional: Docs ok? (com problema)' }).classList).toContain('chain-canvas__element--problem');
    expect(screen.getByRole('img', { name: 'Área: Análise (com problema)' }).classList).toContain('chain-canvas__element--problem');
    expect(screen.getByRole('img', { name: 'Fluxo de Cadastrar cliente para Fim (com problema)' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Etapa: Analisar proposta' }).classList).not.toContain('chain-canvas__element--problem');
  });

  it("marks the request's current step, and says so in its name (workflow-editor.md §10.11)", async () => {
    await render(WorkflowCanvas, { inputs: { document: DOCUMENT, current: 'analyse' } });

    expect(screen.getByRole('img', { name: 'Etapa: Analisar proposta, etapa atual' }).classList).toContain('chain-canvas__element--current');
    expect(screen.getByRole('img', { name: 'Condicional: Docs ok?' }).classList).not.toContain('chain-canvas__element--current');
  });

  it('zooms with the wheel around the cursor, from 0.4× to 2.5×', async () => {
    const { scene } = await draw();
    const svg = screen.getByRole('group', { name: 'Diagrama do processo' });

    svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 200, clientY: 100, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve));
    expect(scene().getAttribute('transform')).toBe('translate(-20 -10) scale(1.1)'); // the point under the cursor stays put

    for (let i = 0; i < 40; i++) {
      svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 200, clientY: 100, cancelable: true }));
    }
    await new Promise((resolve) => setTimeout(resolve));
    expect(scale(scene().getAttribute('transform'))).toBe(2.5);

    for (let i = 0; i < 40; i++) {
      svg.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 200, clientY: 100, cancelable: true }));
    }
    await new Promise((resolve) => setTimeout(resolve));
    expect(scale(scene().getAttribute('transform'))).toBe(0.4);
  });

  it('fits every element in the view, and centers one on request', async () => {
    const { view, canvas, scene } = await draw();
    const read = () => {
      const [, x, y, s] = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/.exec(scene().getAttribute('transform')!)!.map(Number);
      return { x, y, s };
    };

    // The placed elements span 40…1310 × 40…300 (six columns, two lanes). jsdom has no layout, so the view is the
    // 1000 × 600 fallback.
    canvas.fit();
    view.fixture.detectChanges();
    const fitted = read();
    expect(fitted.s).toBeLessThan(1);
    expect(40 * fitted.s + fitted.x).toBeGreaterThanOrEqual(0);
    expect(1310 * fitted.s + fitted.x).toBeLessThanOrEqual(1000);
    expect(((40 + 1310) / 2) * fitted.s + fitted.x).toBeCloseTo(500, 0);
    expect(((40 + 300) / 2) * fitted.s + fitted.y).toBeCloseTo(300, 0);

    // docs_ok is the fourth column of the second lane: its center is (790, 240).
    canvas.center('docs_ok');
    view.fixture.detectChanges();
    const centered = read();
    expect(centered.s).toBe(fitted.s);
    expect(790 * centered.s + centered.x).toBeCloseTo(500, 0);
    expect(240 * centered.s + centered.y).toBeCloseTo(300, 0);
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      const { view } = await draw(['docs_ok']);
      await expectNoAxeViolations(view.container);
    });
  });

  describe('editing (workflow-editor.md §10.2)', () => {
    /** The journey without the automation step's exit, so it can be connected. */
    const OPEN: WorkflowDocument = { ...DOCUMENT, flows: DOCUMENT.flows.filter((flow) => flow.id !== 'f2') };

    async function edit(document: WorkflowDocument = DOCUMENT) {
      const view = await render(WorkflowCanvas, { providers: [DraftEditor] });
      const editor = TestBed.inject(DraftEditor);
      editor.load(document);
      await settle();
      return { view, editor, canvas: view.fixture.componentInstance, user: userEvent.setup() };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve));
    const element = (name: string) => screen.getByRole('button', { name });
    const handle = (container: Element, node: string, branch = '') =>
      container.querySelector(`[data-handle="${node}"][data-exit]${branch ? `[data-branch="${branch}"]` : ''}`)!;
    const layout = (editor: DraftEditor, id: string) => editor.document().nodes.find((node) => node.id === id)!.layout;

    it('makes every element a toggle button in the tab order: the lanes, then the nodes, then the flows', async () => {
      await edit();

      const buttons = screen.getAllByRole('button');
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
        'Área: Solicitantes',
        'Área: Análise',
        'Início: Início',
        'Etapa automática: Consultar CPF',
        'Etapa: Analisar proposta',
        'Condicional: Docs ok?',
        'Subprocesso: Cadastrar cliente',
        'Fim: Fim',
        'Fluxo de Início para Consultar CPF',
        'Fluxo de Consultar CPF para Analisar proposta',
        'Fluxo de Analisar proposta para Docs ok?',
        'Fluxo de Docs ok? para Cadastrar cliente, se verdadeiro',
        'Fluxo de Docs ok? para Analisar proposta, se falso',
        'Fluxo de Cadastrar cliente para Fim',
      ]);
      expect(buttons.every((button) => button.getAttribute('tabindex') === '0' && button.getAttribute('aria-pressed') === 'false')).toBe(true);
    });

    it('selects only the clicked element; Shift, Ctrl or ⌘ adds or removes it; the background clears the selection', async () => {
      const { editor, user } = await edit();

      await user.click(element('Etapa: Analisar proposta'));
      expect([...editor.selection()]).toEqual(['analyse']);
      expect(element('Etapa: Analisar proposta').getAttribute('aria-pressed')).toBe('true');
      expect(element('Etapa: Analisar proposta').classList).toContain('chain-canvas__element--selected');

      await user.keyboard('{Shift>}');
      await user.click(element('Área: Análise'));
      await user.keyboard('{/Shift}');
      await user.keyboard('{Control>}');
      await user.click(element('Fluxo de Início para Consultar CPF'));
      await user.keyboard('{/Control}');
      await user.keyboard('{Meta>}');
      await user.click(element('Etapa: Analisar proposta'));
      await user.keyboard('{/Meta}');
      expect([...editor.selection()]).toEqual(['lane_an', 'f1']);

      await user.click(element('Condicional: Docs ok?'));
      expect([...editor.selection()]).toEqual(['docs_ok']);
      await user.click(screen.getByRole('group', { name: 'Diagrama do processo' }));
      expect([...editor.selection()]).toEqual([]);
    });

    it('toggles the focused element with Enter or Space, and moves the selection with the arrow keys, by 50 with Shift', async () => {
      const { editor, user } = await edit();
      const before = place(DOCUMENT).nodes.get('analyse')!;

      element('Etapa: Analisar proposta').focus();
      await user.keyboard('{Enter}');
      expect([...editor.selection()]).toEqual(['analyse']);
      await user.keyboard('{ArrowRight}{ArrowRight}{Shift>}{ArrowUp}{/Shift}');
      expect(layout(editor, 'analyse')).toEqual({ ...before, x: before.x + 20, y: before.y - 50 });
      expect(document.activeElement).toBe(element('Etapa: Analisar proposta')); // the moved node keeps the focus

      await user.keyboard(' ');
      expect([...editor.selection()]).toEqual([]);
      await user.keyboard('{ArrowRight}');
      expect(layout(editor, 'analyse')!.x).toBe(before.x + 20); // nothing selected, nothing moves
    });

    it('connects from an exit handle to the node clicked next, and selects the new flow', async () => {
      const { view, editor, user } = await edit(OPEN);

      await user.click(handle(view.container, 'consulta'));
      expect(editor.pending()).toEqual({ source: 'consulta' });
      expect(element('Etapa automática: Consultar CPF').classList).toContain('chain-canvas__element--source');
      await user.click(element('Etapa: Analisar proposta'));

      expect(editor.pending()).toBeNull();
      expect(element('Fluxo de Consultar CPF para Analisar proposta').getAttribute('aria-pressed')).toBe('true');
    });

    it('selects the node whose left handle is clicked: only exit handles start a flow', async () => {
      const { view, editor, user } = await edit(OPEN);

      await user.click(view.container.querySelector('[data-handle="consulta"]:not([data-exit])')!);
      expect(editor.pending()).toBeNull();
      expect([...editor.selection()]).toEqual(['consulta']);
    });

    it('connects a gateway from its false handle, by Enter on the target; the background cancels', async () => {
      const { view, editor, user } = await edit({ ...DOCUMENT, flows: DOCUMENT.flows.filter((flow) => flow.id !== 'f5') });

      await user.click(handle(view.container, 'docs_ok', 'false'));
      expect(editor.pending()).toEqual({ source: 'docs_ok', branch: 'false' });
      element('Fim: Fim').focus();
      await user.keyboard('{Enter}');
      expect(element('Fluxo de Docs ok? para Fim, se falso')).toBeTruthy();

      await user.click(handle(view.container, 'docs_ok', 'true'));
      await user.click(screen.getByRole('group', { name: 'Diagrama do processo' }));
      expect(editor.pending()).toBeNull();
      expect(element('Fluxo de Docs ok? para Cadastrar cliente, se verdadeiro')).toBeTruthy(); // unchanged
    });

    it('keeps the selection when the background was dragged to pan', async () => {
      const { editor, user } = await edit();
      await user.click(element('Etapa: Analisar proposta'));
      const svg = screen.getByRole('group', { name: 'Diagrama do processo' });

      svg.focus();
      svg.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
      svg.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
      svg.dispatchEvent(new PointerEvent('pointermove', { button: 0, clientX: 60, clientY: 30, bubbles: true }));
      svg.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 60, clientY: 30, bubbles: true }));
      svg.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 60, clientY: 30, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' }));

      expect([...editor.selection()]).toEqual(['analyse']);
    });

    it('pans with Space held on a focused node, and toggles the node only when Space is released without panning', async () => {
      const { editor, view } = await edit();
      const node = element('Etapa: Analisar proposta');
      const svg = screen.getByRole('group', { name: 'Diagrama do processo' });
      const transform = () => view.container.querySelector('.chain-canvas__scene')!.getAttribute('transform');
      const before = transform();

      node.focus();
      node.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
      svg.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
      svg.dispatchEvent(new PointerEvent('pointermove', { button: 0, clientX: 60, clientY: 30, bubbles: true }));
      svg.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 60, clientY: 30, bubbles: true }));
      svg.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 60, clientY: 30, bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
      await settle();
      expect(transform()).not.toBe(before);
      expect([...editor.selection()]).toEqual([]); // it panned: the node was not toggled

      node.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
      node.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
      expect([...editor.selection()]).toEqual(['analyse']);
    });

    describe('dragging (§10.3)', () => {
      const svg = () => screen.getByRole('group', { name: 'Diagrama do processo' });
      const pointer = (type: string, target: Element, x: number, y: number, init: PointerEventInit = {}) =>
        target.dispatchEvent(new PointerEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true, ...init }));
      /** A press on `target`, moves through the points, a release, and the click a browser then sends to the canvas. */
      const drag = async (target: Element, points: [number, number][], init: PointerEventInit = {}) => {
        const [first, ...rest] = points;
        pointer('pointerdown', target, ...first, init);
        for (const point of rest) {
          pointer('pointermove', svg(), ...point, init);
        }
        const last = points[points.length - 1];
        pointer('pointerup', svg(), ...last, init);
        svg().dispatchEvent(new MouseEvent('click', { button: 0, clientX: last[0], clientY: last[1], bubbles: true, ...init }));
        await settle();
      };
      const placed = place(DOCUMENT);

      it('moves a node by whole grid steps, drawn as it goes; an unselected node becomes the selection; one change on release', async () => {
        const { editor, view } = await edit();
        editor.select('docs_ok');
        const before = placed.nodes.get('analyse')!;
        const shapeX = () => Number(element('Etapa: Analisar proposta').querySelector('.chain-canvas__shape')!.getAttribute('x'));

        pointer('pointerdown', element('Etapa: Analisar proposta'), 590, 240);
        pointer('pointermove', svg(), 613, 247);
        await settle();
        expect(shapeX()).toBe(before.x + 20); // drawn on the grid while dragging
        expect(editor.canUndo()).toBe(false); // nothing recorded yet
        expect([...editor.selection()]).toEqual(['analyse']);
        pointer('pointerup', svg(), 613, 247);
        svg().dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }));
        await settle();

        expect(layout(editor, 'analyse')).toEqual({ ...before, x: before.x + 20, y: before.y + 10 });
        expect([...editor.selection()]).toEqual(['analyse']); // the click that ends a drag selects nothing else
        editor.undo();
        expect(editor.document()).toBe(DOCUMENT);
        expect(view.container.querySelector('.chain-canvas__marquee')).toBeNull();
      });

      it('moves the whole selection when one of its nodes is dragged', async () => {
        const { editor } = await edit();
        editor.select('analyse');
        editor.toggle('docs_ok');

        await drag(element('Condicional: Docs ok?'), [[790, 240], [790, 270], [790, 290]]);
        expect(layout(editor, 'analyse')!.y).toBe(placed.nodes.get('analyse')!.y + 50);
        expect(layout(editor, 'docs_ok')!.y).toBe(placed.nodes.get('docs_ok')!.y + 50);
      });

      it('moves a lane with its nodes, pushed off a lane it lands on', async () => {
        const { editor } = await edit();

        // Solicitantes (40…160) dragged 100 down overlaps Análise (180…300) by 80: pushed back to 4 px above it.
        await drag(element('Área: Solicitantes'), [[100, 150], [100, 200], [100, 250]]);
        expect(editor.document().lanes[0].layout).toEqual({ ...placed.lanes.get('lane_req')!, y: 56 });
        expect(layout(editor, 'start')!.y).toBe(placed.nodes.get('start')!.y + 16);
      });

      it('resizes a selected lane by a corner handle, and with Alt and the arrow keys', async () => {
        const { editor, view, user } = await edit();
        expect(view.container.querySelector('[data-corner]')).toBeNull(); // only a selected lane has them

        editor.select('lane_an');
        await settle();
        expect(view.container.querySelectorAll('[data-lane="lane_an"][data-corner]')).toHaveLength(4);
        await drag(view.container.querySelector('[data-lane="lane_an"][data-corner="br"]')!, [[1310, 300], [1330, 330], [1343, 347]]);
        const box = placed.lanes.get('lane_an')!;
        expect(editor.document().lanes[1].layout).toEqual({ ...box, w: box.w + 30, h: box.h + 50 });

        element('Área: Análise').focus();
        await user.keyboard('{Alt>}{ArrowRight}{/Alt}{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}');
        expect(editor.document().lanes[1].layout).toEqual({ ...box, w: box.w + 40, h: box.h + 100 });
      });

      it('selects with a marquee on the background the nodes it touches, with the flows between them; Shift adds', async () => {
        const { editor, view } = await edit();
        editor.select('docs_ok');

        pointer('pointerdown', svg(), 150, 50);
        pointer('pointermove', svg(), 470, 150);
        await settle();
        const marquee = view.container.querySelector('.chain-canvas__marquee')!;
        expect(['x', 'y', 'width', 'height'].map((name) => marquee.getAttribute(name))).toEqual(['150', '50', '320', '100']);
        pointer('pointerup', svg(), 470, 150);
        svg().dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }));
        await settle();

        expect([...editor.selection()]).toEqual(['start', 'consulta', 'f1']);
        expect(view.container.querySelector('.chain-canvas__marquee')).toBeNull();

        editor.select('docs_ok');
        await drag(svg(), [[1150, 150], [1200, 200], [1250, 250]], { shiftKey: true }); // around the end
        expect([...editor.selection()]).toEqual(['docs_ok', 'end']);
      });

      it('connects by dragging from an exit handle to a node, with a line meanwhile; released elsewhere, nothing changes', async () => {
        const { editor, view } = await edit(OPEN);

        pointer('pointerdown', handle(view.container, 'consulta'), 460, 100);
        pointer('pointermove', svg(), 560, 200);
        await settle();
        expect(view.container.querySelector('.chain-canvas__wire')).toBeTruthy();
        pointer('pointerup', svg(), 590, 240); // on the analyse node
        svg().dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }));
        await settle();
        expect(element('Fluxo de Consultar CPF para Analisar proposta').getAttribute('aria-pressed')).toBe('true');
        expect(view.container.querySelector('.chain-canvas__wire')).toBeNull();

        const flows = editor.document().flows;
        await drag(handle(view.container, 'docs_ok', 'true'), [[825, 220], [1000, 400], [1500, 500]]);
        expect(editor.document().flows).toBe(flows);
        expect(editor.pending()).toBeNull();
      });

      it('takes a press that moves less than 3 px for a click, with its modifiers', async () => {
        const { editor } = await edit();
        editor.select('docs_ok');

        pointer('pointerdown', element('Etapa: Analisar proposta'), 590, 240, { shiftKey: true });
        pointer('pointermove', svg(), 592, 241, { shiftKey: true });
        pointer('pointerup', element('Etapa: Analisar proposta'), 592, 241, { shiftKey: true });
        element('Etapa: Analisar proposta').dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, shiftKey: true }));
        await settle();

        expect([...editor.selection()]).toEqual(['docs_ok', 'analyse']); // added, as Shift and a click do
        expect(editor.canUndo()).toBe(false);
      });

      it('selects a flow pressed and dragged, as a click would, and moves nothing', async () => {
        const { editor } = await edit();
        editor.select('docs_ok');

        await drag(element('Fluxo de Início para Consultar CPF'), [[300, 100], [310, 104], [320, 108]], { shiftKey: true });
        expect([...editor.selection()]).toEqual(['docs_ok', 'f1']);
        expect(editor.canUndo()).toBe(false);
      });

      describe('flows (§10.4)', () => {
        // f2 runs horizontal first from Consultar CPF's right side (460, 100) to Analisar proposta's left side (520, 240),
        // with its bend in the middle, at x 490.
        const flowHandle = (container: Element, kind: string) => container.querySelector(`[data-flow="f2"][data-flow-handle="${kind}"]`)!;
        const f2 = (editor: DraftEditor) => editor.document().flows.find((flow) => flow.id === 'f2')!;

        it('shows the handles of a selected flow, and moves its bend by dragging one', async () => {
          const { editor, view } = await edit();
          expect(view.container.querySelector('[data-flow-handle]')).toBeNull();

          editor.select('f2');
          await settle();
          const handles = [...view.container.querySelectorAll('[data-flow="f2"]')].map((handle) => [
            handle.getAttribute('data-flow-handle'),
            handle.getAttribute('cx'),
            handle.getAttribute('cy'),
          ]);
          expect(handles).toEqual([
            ['source', '460', '100'],
            ['target', '520', '240'],
            ['bend', '490', '100'],
            ['bend', '490', '240'],
          ]);

          await drag(flowHandle(view.container, 'bend'), [[490, 100], [495, 130], [503, 160]]);
          expect(f2(editor).layout).toEqual({ bendX: 500 });
          editor.undo();
          expect(editor.document()).toBe(DOCUMENT); // one change
        });

        it('reconnects a flow by dragging an end onto another node, and says why it cannot', async () => {
          const { editor, view } = await edit();
          editor.select('f2');
          await settle();

          await drag(flowHandle(view.container, 'target'), [[520, 240], [650, 240], [790, 240]]); // onto Docs ok?
          expect(element('Fluxo de Consultar CPF para Docs ok?').getAttribute('aria-pressed')).toBe('true');

          await drag(flowHandle(view.container, 'source'), [[460, 100], [800, 200], [1190, 240]]); // onto the end
          expect(editor.notice()).toBe('O fim não tem saída.');
          expect(f2(editor).source).toBe('consulta');
        });

        it('centers a flow on the middle of its middle segment', async () => {
          const { canvas } = await edit();

          canvas.center('f2'); // its middle segment runs down at x 490, from 100 to 240
          expect(canvas.viewCenter()).toEqual({ x: 490, y: 170 });
        });

        it('switches the routing of a flow on a double click', async () => {
          const { editor } = await edit();

          element('Fluxo de Consultar CPF para Analisar proposta').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          await settle();
          expect(f2(editor).layout).toEqual({ mode: 'VH' });
        });

        it('moves the bend of the one selected flow with the arrow keys', async () => {
          const { editor, user } = await edit();

          await user.click(element('Fluxo de Consultar CPF para Analisar proposta'));
          await user.keyboard('{ArrowRight}');
          expect(f2(editor).layout).toEqual({ bendX: 500 });
        });
      });

      it('drops a drag the browser cancels, with the flow being connected', async () => {
        const { editor, view } = await edit(OPEN);

        pointer('pointerdown', handle(view.container, 'consulta'), 460, 100);
        pointer('pointermove', svg(), 560, 200);
        await settle();
        expect(editor.pending()).toEqual({ source: 'consulta' });
        svg().dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
        await settle();

        expect(editor.pending()).toBeNull();
        expect(view.container.querySelector('.chain-canvas__wire')).toBeNull();
      });
    });

    describe('lanes (§10.6)', () => {
      const band = () => document.querySelector('[data-element="lane_an"] .chain-canvas__lane-band')!; // by id: the title changes
      const rename = () => screen.queryByRole('textbox', { name: 'Nome da área' }) as HTMLInputElement | null;
      const title = (editor: DraftEditor) => editor.document().lanes[1].title;

      it('asks for a lane\'s properties on a double click on its body', async () => {
        const { view } = await edit();
        const asked: string[] = [];
        view.fixture.componentInstance.properties.subscribe((id) => asked.push(id));

        element('Área: Análise').querySelector('.chain-canvas__lane-body')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(asked).toEqual(['lane_an']);
        expect(rename()).toBeNull();
      });

      it('renames a lane in place on a double click on its title band: Enter or leaving applies, Esc cancels, empty keeps it', async () => {
        const { editor, user } = await edit();

        band().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        expect(rename()!.value).toBe('Análise');
        expect(document.activeElement).toBe(rename());
        await user.clear(rename()!);
        await user.type(rename()!, 'Crédito{Enter}');
        expect(title(editor)).toBe('Crédito');
        expect(rename()).toBeNull();

        band().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        await user.type(rename()!, ' e risco{Escape}');
        expect(title(editor)).toBe('Crédito');
        expect(rename()).toBeNull();

        band().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        await user.clear(rename()!);
        await user.type(rename()!, 'Risco');
        rename()!.blur();
        await settle();
        expect(title(editor)).toBe('Risco');

        band().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        await user.clear(rename()!);
        await user.keyboard('{Enter}');
        expect(title(editor)).toBe('Risco'); // an empty title keeps the old one
      });

      it('leaves the keys typed in the rename field to it: no moving, no panning', async () => {
        const { editor, user } = await edit();
        editor.select('lane_an');
        const before = editor.document();

        band().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        await user.type(rename()!, '{ArrowLeft}{ArrowRight} x');
        expect(editor.document()).toBe(before); // the arrows moved the caret, not the lane
        expect(rename()!.value).toBe('Análise x');
      });
    });

    it('centers an element by selecting it, and knows the canvas point in the middle of the view', async () => {
      const { editor, canvas } = await edit();

      expect(canvas.viewCenter()).toEqual({ x: 500, y: 300 }); // the 1000 × 600 fallback view, not moved
      canvas.center('docs_ok');
      expect([...editor.selection()]).toEqual(['docs_ok']);
      expect(canvas.viewCenter()).toEqual({ x: 790, y: 240 }); // the gateway's center is now in the middle
    });

    describe.each(THEMES)('in the %s theme', (theme) => {
      beforeEach(() => applyTheme(theme));

      it('passes axe with a selection and a flow being connected', async () => {
        const { view, editor } = await edit(OPEN);
        editor.select('docs_ok');
        editor.startConnecting('consulta');
        await settle();
        await expectNoAxeViolations(view.container);
      });
    });
  });
});
