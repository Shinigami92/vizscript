import type { GraphDocument, GraphNode, MeasureText } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { FontMetrics } from '../src/font-metrics';
import type { RenderFrame } from '../src/render-frame';
import { Renderer } from '../src/renderer';
import { Scene } from '../src/scene';
import { DARK_THEME } from '../src/theme';
import { Viewport } from '../src/viewport';

/**
 * A 2D context that records the texts it fills; every other call does
 * nothing, gradients and measurements return what the canvas would.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  texts: string[];
} {
  const texts: string[] = [];
  const state: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) {
        return target[key];
      }

      switch (key) {
        case 'fillText': {
          return (text: string) => texts.push(text);
        }

        case 'measureText': {
          return (text: string) => ({ width: text.length * 7 });
        }

        case 'createLinearGradient':
        case 'createRadialGradient': {
          return () => ({ addColorStop: () => undefined });
        }

        case 'getLineDash': {
          return () => [];
        }

        default: {
          return () => undefined;
        }
      }
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

const measure: MeasureText = (text) => text.length * 7;

function call(id: string): GraphNode {
  return {
    id,
    kind: 'call',
    category: 'function',
    purity: 'impure',
    title: `title-${id}`,
    range: { start: 0, end: 0 },
    path: id,
    pins: [
      { id: 'exec', name: 'exec', direction: 'in', kind: 'exec', type: 'exec' },
    ],
  };
}

const DOC: GraphDocument = {
  language: 'test',
  diagnostics: [],
  functions: [
    {
      id: 'main',
      name: 'main',
      range: { start: 0, end: 0 },
      nodes: [call('a'), call('b'), call('c')],
      edges: [],
    },
  ],
};

function frame(extra: Partial<RenderFrame> = {}): RenderFrame {
  return {
    time: 0,
    editable: true,
    selection: new Set(),
    knotSelection: new Set(),
    highlight: new Set(),
    hoverNode: null,
    hoverPin: null,
    hoverAddPin: null,
    hoverEdge: null,
    drag: null,
    pendingWire: null,
    ...extra,
  };
}

function setup(): { renderer: Renderer; scene: Scene; texts: string[] } {
  const { ctx, texts } = recordingContext();
  const scene = new Scene(measure);
  scene.load(DOC, {
    a: { x: 0, y: 0 },
    b: { x: 300, y: 0 },
    c: { x: 600, y: 0 },
  });
  const viewport = new Viewport();
  viewport.width = 1200;
  viewport.height = 600;
  viewport.set({ x: -20, y: -60, zoom: 1 });
  const metrics = new FontMetrics(
    { font: '', measureText: (text) => ({ width: measure(text, 'label') }) },
    DARK_THEME
  );
  return {
    renderer: new Renderer(ctx, metrics, scene, viewport, DARK_THEME),
    scene,
    texts,
  };
}

function titles(texts: ReadonlyArray<string>): string[] {
  return texts.filter((t) => t.startsWith('title-'));
}

describe('Renderer', () => {
  it('draws the nodes in view, the selected ones last', () => {
    const { renderer, texts } = setup();
    renderer.draw(frame());
    expect(titles(texts)).toEqual(['title-a', 'title-b', 'title-c']);

    texts.length = 0;
    renderer.draw(frame({ selection: new Set(['a']) }));
    expect(titles(texts)).toEqual(['title-b', 'title-c', 'title-a']);
  });

  it('draws only what is in view', () => {
    const { renderer, scene, texts } = setup();
    const c = scene.nodes.get('c');
    if (c) {
      c.x = 5000;
      scene.rebuildIndex();
    }

    renderer.draw(frame());
    expect(titles(texts)).toEqual(['title-a', 'title-b']);
  });

  it('changes nothing it draws', () => {
    const { renderer, scene } = setup();
    const before = JSON.stringify(
      [...scene.nodes.values()].map((ns) => [ns.x, ns.y])
    );
    scene.updateFrames();
    renderer.draw(frame({ hoverNode: 'b', time: 1000 }));
    expect(
      JSON.stringify([...scene.nodes.values()].map((ns) => [ns.x, ns.y]))
    ).toBe(before);
    expect(scene.framesDirty).toBe(false);
  });
});
