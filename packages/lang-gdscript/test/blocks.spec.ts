import type { GraphDocument, GraphOp } from '@vizscript/core';
import { applyTextEdits, renamedNodes } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyGDScriptOp(text, op, 'x.gd');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function entryOf(doc: GraphDocument, name: string): string {
  const entry = doc.functions
    .find((f) => f.name === name)
    ?.nodes.find((n) => n.kind === 'entry');
  if (!entry) {
    throw new Error(`no function ${name}`);
  }

  return entry.id;
}

function printOf(doc: GraphDocument): string | undefined {
  return doc.functions.flatMap((f) => f.nodes).find((n) => n.title === 'print')
    ?.id;
}

describe('indented blocks', () => {
  it('keeps pass when deleting every statement of a block', () => {
    const text =
      'func a() -> void:\n\tprint(1)\n\tprint(2)\n\n\nfunc b() -> void:\n\tprint(3)\n';
    const doc = parseGDScriptDocument(text, 'x.gd');
    const nodeIds = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.kind !== 'entry')
      .map((n) => n.id);
    expect(apply(text, { type: 'deleteNodes', nodeIds })).toBe(
      'func a() -> void:\n\tpass\n\n\nfunc b() -> void:\n\tpass\n'
    );
  });

  it('replaces a lone pass with the first code of the block', () => {
    let text = 'func a() -> void:\n\tpass\n';
    let doc = parseGDScriptDocument(text, 'x.gd');
    text = apply(text, {
      type: 'addNode',
      template: { type: 'branch' },
      after: { node: entryOf(doc, 'a'), pin: 'then' },
    });
    expect(text).toBe('func a() -> void:\n\tif true:\n\t\tpass\n');

    doc = parseGDScriptDocument(text, 'x.gd');
    const branch = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'Branch');
    if (!branch) {
      throw new Error('no branch');
    }

    text = apply(text, {
      type: 'addNode',
      template: { type: 'call', callee: 'print', args: ['1'] },
      after: { node: branch.id, pin: 'true' },
    });
    expect(text).toBe('func a() -> void:\n\tif true:\n\t\tprint(1)\n');
  });
});

describe('class header', () => {
  it('keeps the ## class description with extends', () => {
    const text =
      'class_name Collector\nextends Node\n## Picks up coins.\n\n\nfunc a() -> void:\n\tpass\n';
    const next = apply(text, {
      type: 'addVariable',
      scope: '',
      name: 'score',
    });
    expect(
      next.startsWith(
        'class_name Collector\nextends Node\n## Picks up coins.\n\n'
      )
    ).toBe(true);
    expect(next).toContain('var score');
  });
});

describe('renamed functions', () => {
  it('follows the nodes of a renamed function', () => {
    const text = 'func a() -> void:\n\tprint(1)\n';
    const next = text.replace('func a()', 'func b()');
    const before = parseGDScriptDocument(text, 'x.gd');
    const after = parseGDScriptDocument(next, 'x.gd');
    const renamed = renamedNodes(before, after, {
      before: text,
      edits: [{ start: 5, end: 6, text: 'b' }],
    });
    expect(renamed.get(printOf(before) ?? '')).toBe(printOf(after));
    expect(renamed.get(entryOf(before, 'a'))).toBe(entryOf(after, 'b'));
  });
});
