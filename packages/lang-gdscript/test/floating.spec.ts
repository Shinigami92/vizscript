import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  GraphOverlay,
  PinRef,
} from '@vizscript/core';
import {
  applyOverlay,
  floatingNodes,
  graphEditsFor,
  overlayIssues,
  resolveOverlay,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

const backend = {
  parse: (text: string): GraphDocument => parseGDScriptDocument(text, 'x.gd'),
  applyOp: (text: string, op: GraphOp) => applyGDScriptOp(text, op, 'x.gd'),
};

const text =
  'extends Node\n\nvar score = 1\n\n\nfunc a() -> void:\n\tprint(1)\n';

function node(doc: GraphDocument, match: (n: GraphNode) => boolean): GraphNode {
  const found = doc.functions.flatMap((f) => f.nodes).find(match);
  if (!found) {
    throw new Error('no node');
  }

  return found;
}

function dataPin(n: GraphNode, direction: 'in' | 'out'): PinRef {
  // Not a call's `self`.
  const pin = n.pins.find(
    (p) => p.kind === 'data' && p.direction === direction && p.id !== 'target'
  );
  if (!pin) {
    throw new Error('no pin');
  }

  return { node: n.id, pin: pin.id };
}

/** The class body: where nodes float when nothing else is under them. */
function topLevel(doc: GraphDocument): string {
  const fn = doc.functions.find((f) => f.name !== 'a');
  if (!fn) {
    throw new Error('no top level');
  }

  return fn.id;
}

/** Floating nodes of a template, kept in an overlay. */
function float(template: Parameters<typeof floatingNodes>[1]): GraphOverlay {
  const doc = backend.parse(text);
  const result = floatingNodes(text, template, topLevel(doc), 'f1', backend);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return { edits: [result.edit] };
}

/** Adds the graph-only edits of an op, as the web app does. */
function edit(overlay: GraphOverlay, op: GraphOp): GraphOverlay {
  const shown = applyOverlay(backend.parse(text), overlay);
  const edits = graphEditsFor(shown, op);
  if (!edits) {
    throw new Error('not a graph edit');
  }

  return { edits: [...overlay.edits, ...edits] };
}

describe('floating nodes', () => {
  it('keeps a statement outside the code until it is wired in', () => {
    let overlay = float({ type: 'call', callee: 'print', args: ['2'] });
    const doc = backend.parse(text);
    const shown = applyOverlay(doc, overlay);
    const floating = node(shown, (n) => n.graphOnly === true);
    expect(floating.floating).toBe(true);
    expect(floating.id.startsWith('overlay:f1/')).toBe(true);
    expect(overlayIssues(doc, shown).map((i) => i.node)).toEqual([floating.id]);
    expect(resolveOverlay(text, overlay, backend).status).toBe('pending');

    const first = node(doc, (n) => n.title === 'print');
    overlay = edit(overlay, {
      type: 'connect',
      from: { node: first.id, pin: 'then' },
      to: { node: floating.id, pin: 'exec' },
    });
    const result = resolveOverlay(text, overlay, backend);
    expect(result).toMatchObject({
      status: 'synced',
      text: 'extends Node\n\nvar score = 1\n\n\nfunc a() -> void:\n\tprint(1)\n\tprint(2)\n',
    });

    // The written node keeps the floating node's place.
    const written = backend.parse(
      result.status === 'synced' ? result.text : ''
    );
    const placed = result.status === 'synced' ? result.placed : undefined;
    expect(placed?.[floating.id]).toBe(
      node(written, (n) => n.title === 'print' && n.id !== first.id).id
    );
  });

  it('writes a floating value into the input it is wired to', () => {
    let overlay = float({ type: 'value', expression: 'score' });
    const doc = backend.parse(text);
    const value = node(applyOverlay(doc, overlay), (n) => n.graphOnly === true);
    const print = node(doc, (n) => n.title === 'print');
    overlay = edit(overlay, {
      type: 'connect',
      from: dataPin(value, 'out'),
      to: dataPin(print, 'in'),
    });
    expect(resolveOverlay(text, overlay, backend)).toMatchObject({
      status: 'synced',
      text: 'extends Node\n\nvar score = 1\n\n\nfunc a() -> void:\n\tprint(score)\n',
    });
  });

  it('drops floating nodes that are deleted again', () => {
    let overlay = float({ type: 'call', callee: 'print', args: ['2'] });
    const floating = node(
      applyOverlay(backend.parse(text), overlay),
      (n) => n.graphOnly === true
    );
    overlay = edit(overlay, { type: 'deleteNodes', nodeIds: [floating.id] });
    expect(resolveOverlay(text, overlay, backend)).toEqual({
      status: 'synced',
      text,
    });
  });

  it('works in a file without functions', () => {
    const empty = 'extends Node\n';
    const doc = backend.parse(empty);
    const result = floatingNodes(
      empty,
      { type: 'branch' },
      doc.functions[0]?.id,
      'f2',
      backend
    );
    expect(result.ok && result.edit.code).toBe('if true:\n\tpass');
  });
});
