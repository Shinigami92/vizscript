import type { GraphDocument, GraphNode } from '@vizscript/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphView } from '../src/graph-view';
import type { GraphViewEvents } from '../src/graph-view-types';
import { recordingContext } from './fake-canvas';

type Listener = (e: unknown) => void;

/** A canvas at the page's origin, 800 × 600, that keeps its listeners. */
function fakeCanvas(): {
  canvas: HTMLCanvasElement;
  fire: (type: string, init?: Record<string, unknown>) => void;
} {
  const listeners = new Map<string, Listener>();
  const { ctx } = recordingContext();
  const canvas = {
    style: {},
    tabIndex: -1,
    width: 0,
    height: 0,
    getContext: () => ctx,
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    focus: () => undefined,
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  } as unknown as HTMLCanvasElement;
  const fire = (type: string, init: Record<string, unknown> = {}): void => {
    listeners.get(type)?.({
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: () => undefined,
      ...init,
    });
  };
  return { canvas, fire };
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
    pins: [],
  };
}

function doc(...ids: string[]): GraphDocument {
  return {
    language: 'test',
    diagnostics: [],
    functions: [
      {
        id: 'main',
        name: 'main',
        range: { start: 0, end: 0 },
        nodes: ids.map(call),
        edges: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => recordingContext().ctx }),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public observe(): void {}
      public disconnect(): void {}
    }
  );
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    matchMedia: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GraphView', () => {
  it('reports the hover as gone when the hovered node is deleted', () => {
    const { canvas, fire } = fakeCanvas();
    const view = new GraphView(canvas);
    view.setDocument(doc('a', 'b'), { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } });
    view.setCamera({ x: 0, y: 0, zoom: 1 });
    const hovers: Array<GraphViewEvents['hoverChange']> = [];
    view.on('hoverChange', (hover) => hovers.push(hover));

    fire('pointermove', { clientX: 20, clientY: 10 });
    expect(hovers).toEqual([{ nodeId: 'a', pin: null }]);

    // The node under the pointer was deleted: the new document lacks it.
    view.setDocument(doc('b'), { b: { x: 300, y: 0 } });
    expect(hovers.at(-1)).toEqual({ nodeId: null, pin: null });

    view.destroy();
  });
});
