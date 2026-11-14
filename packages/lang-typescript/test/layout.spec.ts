import type { GraphDocument, GraphNode, Positions } from '@vizscript/core';
import { layoutDocument } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

const options = {
  sizeOf: (): { width: number; height: number } => ({ width: 150, height: 60 }),
  maxRowWidth: 700,
};

function nodes(doc: GraphDocument, title: string): GraphNode[] {
  return doc.functions.flatMap((f) => f.nodes).filter((n) => n.title === title);
}

function first(doc: GraphDocument, title: string): GraphNode {
  const [node] = nodes(doc, title);
  if (!node) {
    throw new Error(`no ${title}`);
  }

  return node;
}

describe('layout', () => {
  it('keeps a chain on one row', () => {
    const doc = parseTypeScript(
      'a();\nb();\nx.one().two().three().four();\n',
      'a.ts'
    );
    const positions = layoutDocument(doc, options);
    const ys = ['one', 'two', 'three', 'four'].map(
      (title) => positions[first(doc, title).id]?.y
    );
    expect(new Set(ys).size).toBe(1);
  });

  it('places a new value next to the node it feeds', () => {
    const doc = parseTypeScript('const p = new Command();\nlog(1);\n', 'a.ts');
    const set = first(doc, 'Set p');
    const saved: Positions = {};
    for (const node of doc.functions.flatMap((f) => f.nodes)) {
      if (node.title !== 'new Command') {
        saved[node.id] = { x: 1000 + Object.keys(saved).length * 300, y: 500 };
      }
    }

    const positions = layoutDocument(doc, options, saved);
    const made = positions[first(doc, 'new Command').id];
    expect(made?.x).toBeLessThan(saved[set.id]?.x ?? 0);
  });

  it('puts a new function right below the placed ones', () => {
    const doc = parseTypeScript(
      'function f() {\n  a();\n}\nfunction g() {\n  b();\n}\n',
      'a.ts'
    );
    const f = doc.functions.find((fn) => fn.name === 'f');
    const g = doc.functions.find((fn) => fn.name === 'g');
    const saved: Positions = {};
    for (const [i, node] of (f?.nodes ?? []).entries()) {
      saved[node.id] = { x: i * 300, y: 4000 };
    }

    const positions = layoutDocument(doc, options, saved);
    const tops = (g?.nodes ?? []).map((n) => positions[n.id]?.y ?? 0);
    // Below f (y 4000, 60 high) by the function gap, not near y 0.
    expect(Math.min(...tops)).toBeGreaterThan(4060);
    expect(Math.min(...tops)).toBeLessThan(4400);
  });
});
