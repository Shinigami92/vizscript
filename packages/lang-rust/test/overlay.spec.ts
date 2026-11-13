import type { GraphDocument, GraphOverlay, PinRef } from '@vizscript/core';
import {
  applyOverlay,
  floatingNodes,
  graphEditsFor,
  resolveOverlay,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyRustOp, parseRustDocument } from '../src';

const backend = {
  parse: (text: string): GraphDocument => parseRustDocument(text, 'main.rs'),
  applyOp: (text: string, op: Parameters<typeof applyRustOp>[1]) =>
    applyRustOp(text, op, 'main.rs'),
};

const text = [
  'fn main() {',
  '    let first = 1;',
  '    println!("{}", first);',
  '    let second = 2;',
  '}',
  '',
].join('\n');

function pin(doc: GraphDocument, title: string, id: string): PinRef {
  const node = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === title);
  if (!node) {
    throw new Error(`no node ${title}`);
  }

  return { node: node.id, pin: id };
}

describe('graph-only edits in Rust', () => {
  it('moves statements once the graph is wired again', () => {
    const doc = backend.parse(text);
    let overlay: GraphOverlay = { edits: [] };
    for (const op of [
      { type: 'disconnect' as const, pin: pin(doc, 'Set first', 'then') },
      {
        type: 'connect' as const,
        from: pin(doc, 'Set first', 'then'),
        to: pin(doc, 'Set second', 'exec'),
      },
      {
        type: 'connect' as const,
        from: pin(doc, 'Set second', 'then'),
        to: pin(doc, 'println!', 'exec'),
      },
    ]) {
      const edits = graphEditsFor(applyOverlay(doc, overlay), op);
      overlay = { edits: [...overlay.edits, ...(edits ?? [])] };
    }

    expect(resolveOverlay(text, overlay, backend)).toEqual({
      status: 'synced',
      text: [
        'fn main() {',
        '    let first = 1;',
        '    let second = 2;',
        '    println!("{}", first);',
        '}',
        '',
      ].join('\n'),
    });
  });

  it('writes floating nodes where they are wired in', () => {
    const doc = backend.parse(text);
    const main = doc.functions.find((f) => f.name === 'main');
    const result = floatingNodes(
      text,
      { type: 'call', callee: 'tick', args: [] },
      main?.id,
      'f1',
      backend
    );
    if (!result.ok) {
      throw new Error(result.error);
    }

    let overlay: GraphOverlay = { edits: [result.edit] };
    const head = applyOverlay(doc, overlay)
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.floating);
    if (!head) {
      throw new Error('no floating node');
    }

    for (const op of [
      {
        type: 'connect' as const,
        from: pin(doc, 'Set first', 'then'),
        to: { node: head.id, pin: 'exec' },
      },
      {
        type: 'connect' as const,
        from: { node: head.id, pin: 'then' },
        to: pin(doc, 'println!', 'exec'),
      },
    ]) {
      const edits = graphEditsFor(applyOverlay(doc, overlay), op);
      overlay = { edits: [...overlay.edits, ...(edits ?? [])] };
    }

    expect(resolveOverlay(text, overlay, backend)).toMatchObject({
      status: 'synced',
      text: [
        'fn main() {',
        '    let first = 1;',
        '    tick();',
        '    println!("{}", first);',
        '    let second = 2;',
        '}',
        '',
      ].join('\n'),
    });
  });
});
