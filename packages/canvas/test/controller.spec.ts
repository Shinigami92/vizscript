import { GRID_SIZE } from '@vizscript/core';
import type {
  GraphDocument,
  GraphNode,
  MeasureText,
  Pin,
  Point,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { Controller } from '../src/controller';
import type { ControllerHost } from '../src/controller-host';
import type { GraphViewEvents } from '../src/graph-view-types';
import { newInteraction } from '../src/interaction';
import { Scene } from '../src/scene';
import { Viewport } from '../src/viewport';

const measure: MeasureText = (text) => text.length * 7;

function execPin(id: string, direction: Pin['direction']): Pin {
  return { id, name: id, direction, kind: 'exec', type: 'exec' };
}

function call(id: string): GraphNode {
  return {
    id,
    kind: 'call',
    category: 'function',
    purity: 'impure',
    title: id,
    range: { start: 0, end: 0 },
    path: id,
    pins: [execPin('exec', 'in'), execPin('then', 'out')],
  };
}

/** `a` wired to `b`; `c` below, wired to nothing. */
const DOC: GraphDocument = {
  language: 'test',
  diagnostics: [],
  functions: [
    {
      id: 'main',
      name: 'main',
      range: { start: 0, end: 0 },
      nodes: [call('a'), call('b'), call('c')],
      edges: [
        {
          id: 'e1',
          kind: 'exec',
          from: { node: 'a', pin: 'then' },
          to: { node: 'b', pin: 'exec' },
        },
      ],
    },
  ],
};

type Listener = (e: unknown) => void;
type Emitted = {
  [K in keyof GraphViewEvents]: [K, GraphViewEvents[K]];
}[keyof GraphViewEvents];

/** A controller on a canvas at the page's origin, the camera at 100 %. */
function setup(): {
  scene: Scene;
  viewport: Viewport;
  host: ControllerHost;
  emitted: Emitted[];
  fire: (type: string, init?: Record<string, unknown>) => void;
} {
  const listeners = new Map<string, Listener>();
  const canvas = {
    style: {},
    tabIndex: -1,
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    focus: () => undefined,
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  } as unknown as HTMLCanvasElement;

  const scene = new Scene(measure);
  scene.load(DOC, {
    a: { x: 0, y: 0 },
    b: { x: 400, y: 0 },
    c: { x: 0, y: 300 },
  });
  const viewport = new Viewport();
  viewport.width = 1000;
  viewport.height = 800;
  viewport.set({ x: 0, y: 0, zoom: 1 });
  const ui = newInteraction();
  const emitted: Emitted[] = [];
  const emit = <K extends keyof GraphViewEvents>(
    event: K,
    payload: GraphViewEvents[K]
  ): void => {
    emitted.push([event, payload] as Emitted);
  };

  const host: ControllerHost = {
    canvas,
    scene,
    viewport,
    ui,
    editable: () => true,
    conversions: () => undefined,
    emit,
    requestRender: () => undefined,
    hitTest: (world) =>
      scene.hitTest(world, {
        zoom: viewport.camera.zoom,
        editable: true,
        selection: ui.selection,
      }),
    setSelection: (selection) => {
      ui.selection = selection;
      emit('selectionChange', { nodeIds: [...selection] });
    },
    setHover: () => undefined,
    setHoverEdge: () => undefined,
    setHoverAddPin: () => undefined,
    setCamera: (camera) => viewport.set(camera),
    finishNodeMoves: () => undefined,
    toggleAdvanced: () => undefined,
    getReroutes: (edgeId) => scene.reroutes.get(edgeId) ?? [],
    addReroute: () => undefined,
    removeReroute: () => undefined,
    deleteSelectedKnots: () => undefined,
    editComment: () => undefined,
    startLiteralEdit: () => undefined,
    selectAll: () => undefined,
    alignSelection: () => undefined,
    frameSelection: () => undefined,
    frameAll: () => undefined,
  };
  new Controller(host).attach();

  const fire = (type: string, init: Record<string, unknown> = {}): void => {
    listeners.get(type)?.({
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      key: '',
      code: '',
      deltaMode: 0,
      deltaX: 0,
      deltaY: 0,
      preventDefault: () => undefined,
      ...init,
    });
  };
  return { scene, viewport, host, emitted, fire };
}

/** A point on a node's header. */
function headerOf(scene: Scene, id: string): Point {
  const ns = scene.nodes.get(id);
  if (!ns) {
    throw new Error(`no node ${id}`);
  }

  return { x: ns.x + ns.geom.width / 2, y: ns.y + 6 };
}

function pinOf(scene: Scene, id: string, pin: string): Point {
  const ns = scene.nodes.get(id);
  const pg = ns?.geom.pins.get(pin);
  if (!ns || !pg) {
    throw new Error(`no pin ${id}.${pin}`);
  }

  return scene.pinWorld(ns, pg);
}

function at(p: Point): { clientX: number; clientY: number } {
  return { clientX: p.x, clientY: p.y };
}

function events(emitted: ReadonlyArray<Emitted>, name: string): unknown[] {
  return emitted.filter(([event]) => event === name).map(([, p]) => p);
}

describe('Controller', () => {
  it('drags a node onto the grid and reports where it went', () => {
    const { scene, emitted, fire } = setup();
    const start = headerOf(scene, 'a');
    fire('pointerdown', at(start));
    fire('pointermove', at({ x: start.x + 30, y: start.y + 20 }));
    fire('pointermove', at({ x: start.x + 55, y: start.y + 37 }));
    fire('pointerup', at({ x: start.x + 55, y: start.y + 37 }));

    const a = scene.nodes.get('a');
    expect(events(emitted, 'selectionChange')).toEqual([{ nodeIds: ['a'] }]);
    expect(events(emitted, 'layoutChange')).toEqual([
      { patch: { a: { x: a?.x, y: a?.y } } },
    ]);
    expect((a?.x ?? 0) % GRID_SIZE).toBe(0);
    expect(a?.x).toBeGreaterThan(0);
  });

  it('puts a dragged node back on Escape', () => {
    const { scene, host, emitted, fire } = setup();
    const start = headerOf(scene, 'a');
    fire('pointerdown', at(start));
    fire('pointermove', at({ x: start.x + 80, y: start.y + 80 }));
    fire('keydown', { key: 'Escape' });
    fire('pointerup', at({ x: start.x + 80, y: start.y + 80 }));

    expect(scene.nodes.get('a')).toMatchObject({ x: 0, y: 0 });
    expect(host.ui.drag).toBeNull();
    expect(events(emitted, 'layoutChange')).toEqual([]);
  });

  it('deletes the selected nodes with Delete', () => {
    const { scene, emitted, fire } = setup();
    fire('pointerdown', at(headerOf(scene, 'b')));
    fire('pointerup', at(headerOf(scene, 'b')));
    fire('keydown', { key: 'Delete' });
    expect(events(emitted, 'op')).toEqual([
      { type: 'deleteNodes', nodeIds: ['b'] },
    ]);
  });

  it('opens a node’s menu on right-click and selects it, like UE', () => {
    const { scene, host, emitted, fire } = setup();
    const p = headerOf(scene, 'b');
    fire('pointerdown', { ...at(p), button: 2 });
    fire('pointerup', { ...at(p), button: 2 });
    expect(host.ui.selection).toEqual(new Set(['b']));
    expect(events(emitted, 'contextMenu')).toMatchObject([
      { target: { kind: 'node', nodeId: 'b' } },
    ]);
  });

  it('connects a wire dropped on a free pin', () => {
    const { scene, emitted, fire } = setup();
    fire('pointerdown', at(pinOf(scene, 'b', 'then')));
    fire('pointermove', at({ x: 200, y: 200 }));
    fire('pointermove', at(pinOf(scene, 'c', 'exec')));
    fire('pointerup', at(pinOf(scene, 'c', 'exec')));
    expect(events(emitted, 'op')).toEqual([
      {
        type: 'connect',
        from: { node: 'b', pin: 'then' },
        to: { node: 'c', pin: 'exec' },
      },
    ]);
  });

  it('keeps a wire dropped on empty space while its menu is open', () => {
    const { scene, host, emitted, fire } = setup();
    fire('pointerdown', at(pinOf(scene, 'c', 'then')));
    fire('pointermove', at({ x: 700, y: 600 }));
    fire('pointerup', at({ x: 700, y: 600 }));
    expect(events(emitted, 'contextMenu')).toMatchObject([
      {
        world: { x: 700, y: 600 },
        target: { kind: 'pin', pin: { node: 'c', pin: 'then' } },
        from: { node: 'c', pin: 'then' },
      },
    ]);
    expect(host.ui.pendingWire?.world).toEqual({ x: 700, y: 600 });
  });

  it('zooms around the pointer with Ctrl+wheel and pans without', () => {
    const { viewport, fire } = setup();
    fire('wheel', { clientX: 100, clientY: 100, deltaY: -10, ctrlKey: true });
    expect(viewport.camera.zoom).toBeGreaterThan(1);
    // The point under the pointer stays where it was.
    expect(viewport.camera.x + 100 / viewport.camera.zoom).toBeCloseTo(100);

    const before = { ...viewport.camera };
    fire('wheel', { clientX: 100, clientY: 100, deltaX: 30, deltaY: 7 });
    expect(viewport.camera.x).toBeCloseTo(before.x + 30 / before.zoom);
    expect(viewport.camera.y).toBeCloseTo(before.y + 7 / before.zoom);
  });
});
