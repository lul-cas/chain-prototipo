import { bounds, exitPoint, pathOf, route, routing, snap } from './geometry';

const task = (x: number, y: number) => ({ x, y, w: 140, h: 70 });

describe('editor geometry (workflow-editor.md §3, §4)', () => {
  it('snaps to the 10 px grid', () => {
    expect([snap(14), snap(15), snap(-14), snap(200)]).toEqual([10, 20, -10, 200]);
  });

  it('leaves a node on the right, and a gateway through its true handle at 25 % or its false handle at 75 %, on the diamond', () => {
    const gateway = { x: 0, y: 0, w: 70, h: 70 };

    expect(exitPoint(task(0, 0), 'task')).toEqual({ x: 140, y: 35 });
    expect(exitPoint(gateway, 'gateway', 'true')).toEqual({ x: 52.5, y: 17.5 });
    expect(exitPoint(gateway, 'gateway', 'false')).toEqual({ x: 52.5, y: 52.5 });
    expect(exitPoint(gateway, 'gateway')).toEqual({ x: 70, y: 35 });
  });

  it('routes horizontally first, with the bend halfway on the grid unless the flow stores one', () => {
    expect(route(task(0, 0), 'task', task(300, 100), {})).toEqual([
      { x: 140, y: 35 },
      { x: 220, y: 35 },
      { x: 220, y: 135 },
      { x: 300, y: 135 },
    ]);
    expect(route(task(0, 0), 'task', task(300, 100), { layout: { bendX: 250 } })[1]).toEqual({ x: 250, y: 35 });
  });

  it('routes vertically first when asked, through the bottom going down and the top going up', () => {
    expect(route(task(0, 0), 'task', task(200, 200), { layout: { mode: 'VH' } })).toEqual([
      { x: 70, y: 70 },
      { x: 70, y: 140 },
      { x: 270, y: 140 },
      { x: 270, y: 200 },
    ]);
    expect(route(task(0, 200), 'task', task(0, 0), { layout: { mode: 'VH', bendY: 120 } })).toEqual([
      { x: 70, y: 200 },
      { x: 70, y: 70 },
    ]); // ends in line: straight
  });

  it('draws a straight line between ends within 6 px of each other on one axis (POC)', () => {
    expect(route(task(0, 0), 'task', task(300, 0), {})).toEqual([
      { x: 140, y: 35 },
      { x: 300, y: 35 },
    ]);
    expect(route(task(0, 0), 'task', task(300, 6), {})).toEqual([
      { x: 140, y: 35 },
      { x: 300, y: 41 },
    ]);
    expect(route(task(0, 0), 'task', task(300, 7), {})).toHaveLength(4);
  });

  it('leaves and enters on the sides facing each other, so a flow back to an earlier step does not cross it (POC)', () => {
    // Back to the left: out of the source's left side, into the target's right side.
    expect(route(task(400, 100), 'task', task(100, 200), {})).toEqual([
      { x: 400, y: 135 },
      { x: 320, y: 135 },
      { x: 320, y: 235 },
      { x: 240, y: 235 },
    ]);
    // Farther down than across: vertical first, out of the bottom, into the top.
    expect(route(task(100, 100), 'task', task(120, 400), {})).toEqual([
      { x: 170, y: 170 },
      { x: 170, y: 290 },
      { x: 190, y: 290 },
      { x: 190, y: 400 },
    ]);
    // Up: out of the top, into the bottom.
    expect(route(task(120, 400), 'task', task(100, 100), {})[0]).toEqual({ x: 190, y: 400 });
    // As far apart across as down: horizontal first, as in the POC.
    expect(routing(task(0, 0), 'task', task(200, 200), {}).mode).toBe('HV');
  });

  it('takes a gateway flow out of its handle, toward the side of its target facing back (POC)', () => {
    const gateway = { x: 400, y: 100, w: 70, h: 70 };
    expect(route(gateway, 'gateway', task(100, 100), { branch: 'true' })).toEqual([
      { x: 452.5, y: 117.5 },
      { x: 350, y: 117.5 },
      { x: 350, y: 135 },
      { x: 240, y: 135 },
    ]);
  });

  it('keeps the bend between the ends, 12 px in across and 8 px down, on the grid (POC)', () => {
    expect(route(task(0, 0), 'task', task(300, 100), { layout: { bendX: 1000 } })[1]).toEqual({ x: 290, y: 35 });
    expect(route(task(0, 0), 'task', task(300, 100), { layout: { bendX: -50 } })[1]).toEqual({ x: 150, y: 35 });
    expect(route(task(0, 0), 'task', task(30, 300), { layout: { bendY: 1000 } })[1]).toEqual({ x: 70, y: 290 });
  });

  it('lets a routing chosen for the flow set the sides, and tells the routing, its ends and its bend', () => {
    // Farther across than down, but vertical first was chosen: out of the bottom, into the top.
    expect(route(task(100, 100), 'task', task(400, 300), { layout: { mode: 'VH' } })).toEqual([
      { x: 170, y: 170 },
      { x: 170, y: 240 },
      { x: 470, y: 240 },
      { x: 470, y: 300 },
    ]);
    expect(routing(task(0, 0), 'task', task(300, 100), {})).toEqual({
      mode: 'HV',
      start: { x: 140, y: 35 },
      end: { x: 300, y: 135 },
      bend: 220,
      points: route(task(0, 0), 'task', task(300, 100), {}),
    });
    expect(routing(task(0, 0), 'task', task(300, 0), {}).bend).toBeNull(); // straight: no bend
  });

  it('writes a route as an SVG path, and bounds a set of boxes', () => {
    expect(pathOf([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe('M 1 2 L 3 4');
    expect(bounds([task(0, 0), { x: 200, y: -10, w: 10, h: 10 }])).toEqual({ x: 0, y: -10, w: 210, h: 80 });
    expect(bounds([])).toBeNull();
  });
});
