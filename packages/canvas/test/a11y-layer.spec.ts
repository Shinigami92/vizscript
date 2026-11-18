import type {
  GraphDocument,
  GraphNode,
  MeasureText,
  Pin,
  Positions,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { A11yLayer, describeNode } from '../src/a11y-layer';
import type { A11yDocument, A11yElement } from '../src/a11y-layer';
import { Scene } from '../src/scene';

const measure: MeasureText = (text) => text.length * 7;

/** Elements that keep their attributes and children, and count writes. */
class FakeElement implements A11yElement {
  public attributes = new Map<string, string>();
  public children: FakeElement[] = [];
  public parent: FakeElement | null = null;
  public readonly style: { cssText: string };

  public constructor(private readonly writes: { count: number }) {
    let css = '';
    this.style = {
      get cssText(): string {
        return css;
      },
      set cssText(value: string) {
        writes.count++;
        css = value;
      },
    };
  }

  public setAttribute(name: string, value: string): void {
    this.writes.count++;
    this.attributes.set(name, value);
  }

  public append(...children: A11yElement[]): void {
    this.writes.count++;
    for (const child of children as FakeElement[]) {
      child.parent = this;
      this.children.push(child);
    }
  }

  public replaceChildren(...children: A11yElement[]): void {
    this.children = [];
    this.append(...children);
  }

  public remove(): void {
    this.writes.count++;
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
    }
  }

  /** Every element below, depth first. */
  public all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

function fakeDom(): {
  doc: A11yDocument;
  parent: FakeElement;
  writes: { count: number };
} {
  const writes = { count: 0 };
  return {
    doc: { createElement: () => new FakeElement(writes) },
    parent: new FakeElement(writes),
    writes,
  };
}

function pin(id: string, direction: Pin['direction'], extra = {}): Pin {
  return { id, name: id, direction, kind: 'data', type: 'number', ...extra };
}

function call(id: string): GraphNode {
  return {
    id,
    kind: 'call',
    category: 'function',
    purity: 'impure',
    title: 'round',
    range: { start: 0, end: 0 },
    path: id,
    pins: [
      { id: 'exec', name: '', direction: 'in', kind: 'exec', type: 'exec' },
      { id: 'then', name: '', direction: 'out', kind: 'exec', type: 'exec' },
      pin('arg0', 'in', { literal: { kind: 'number', value: '2', raw: '2' } }),
      pin('return', 'out'),
    ],
  };
}

/** A scene of `count` calls in one function, in a row. */
function scene(count: number): Scene {
  const nodes = Array.from({ length: count }, (_, i) => call(`f/n${i}`));
  const doc: GraphDocument = {
    language: 'typescript',
    diagnostics: [],
    functions: [
      { id: 'f', name: 'f', range: { start: 0, end: 0 }, nodes, edges: [] },
    ],
  };
  const positions: Positions = Object.fromEntries(
    nodes.map((n, i) => [
      n.id,
      { x: (i % 50) * 300, y: Math.floor(i / 50) * 200 },
    ])
  );
  const s = new Scene(measure);
  s.load(doc, positions);
  return s;
}

const camera = { x: 0, y: 0, zoom: 1 };

describe('the graph as DOM', () => {
  it('names nodes, pins and inline values at their places', () => {
    const s = scene(1);
    const ns = s.nodes.get('f/n0');
    if (!ns) {
      throw new Error('no node');
    }

    const info = describeNode(s, ns);
    expect(info.label).toBe('round');
    expect(info.parts.map((p) => p.label)).toEqual([
      'exec, exec, input',
      'arg0, number, input',
      'Value of arg0: 2',
      'then, exec, output',
      'return, number, output',
    ]);
    // The pin's target is centered on the pin.
    const arg = ns.geom.pins.get('arg0');
    const target = info.parts.find((p) => p.data.pin === 'arg0');
    expect(target && arg && target.x + target.width / 2).toBe(arg?.x);
  });

  it('writes the nodes once, then nothing while nothing changes', () => {
    const s = scene(3);
    const { doc, parent, writes } = fakeDom();
    const layer = new A11yLayer(doc, parent);
    layer.sync(s, camera, new Set());
    const labels = parent
      .all()
      .map((e) => e.attributes.get('aria-label'))
      .filter(Boolean);
    expect(labels).toContain('round');
    expect(labels).toContain('Value of arg0: 2');

    writes.count = 0;
    layer.sync(s, camera, new Set());
    expect(writes.count).toBe(0);
  });

  it('moves the camera with one write', () => {
    const s = scene(200);
    const { doc, parent, writes } = fakeDom();
    const layer = new A11yLayer(doc, parent);
    layer.sync(s, camera, new Set());
    writes.count = 0;
    layer.sync(s, { x: 40, y: -20, zoom: 0.5 }, new Set());
    expect(writes.count).toBe(1);
  });

  it('writes only the node that moved or got selected', () => {
    const s = scene(200);
    const { doc, parent, writes } = fakeDom();
    const layer = new A11yLayer(doc, parent);
    layer.sync(s, camera, new Set());
    const ns = s.nodes.get('f/n7');
    if (!ns) {
      throw new Error('no node');
    }

    writes.count = 0;
    ns.x += 16;
    layer.sync(s, camera, new Set(['f/n9']));
    // n7's position, n9's `data-selected`.
    expect(writes.count).toBe(2);
  });

  it('keeps up with large graphs', () => {
    const s = scene(3000);
    const { doc, parent } = fakeDom();
    const layer = new A11yLayer(doc, parent);
    const first = performance.now();
    layer.sync(s, camera, new Set());
    const built = performance.now() - first;
    // A frame of a pan or a hover: nothing but the camera changed.
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      layer.sync(s, { x: i, y: 0, zoom: 1 }, new Set());
    }

    const perFrame = (performance.now() - start) / 20;
    // Generous bounds (slow CI machines); the real cost is far below.
    expect(built).toBeLessThan(500);
    expect(perFrame).toBeLessThan(4);
  });
});
