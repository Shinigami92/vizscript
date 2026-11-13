import type { GraphDocument, GraphOverlay, PinRef } from '@vizscript/core';
import {
  applyOverlay,
  applyTextEdits,
  graphEditsFor,
  overlayIssues,
  remapOverlay,
  resolveOverlay,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

const backend = {
  parse: (text: string): GraphDocument => parseTypeScript(text),
  applyOp: applyTypeScriptOp,
};

const text = [
  'function total(items: number[]): number {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item;',
  '  }',
  '  console.log(sum);',
  '  return sum;',
  '}',
  '',
].join('\n');

function nodeId(doc: GraphDocument, title: string): string {
  const node = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === title);
  if (!node) {
    throw new Error(`no node ${title}`);
  }

  return node.id;
}

function pin(doc: GraphDocument, title: string, id: string): PinRef {
  return { node: nodeId(doc, title), pin: id };
}

/** Applies an op like the web app: in the code, else graph-only. */
function edit(
  source: string,
  overlay: GraphOverlay,
  op: Parameters<typeof graphEditsFor>[1]
): GraphOverlay {
  const shown = applyOverlay(parseTypeScript(source), overlay);
  const edits = graphEditsFor(shown, op);
  if (!edits) {
    throw new Error(`not a graph edit: ${op.type}`);
  }

  return { edits: [...overlay.edits, ...edits] };
}

describe('graph-only edits', () => {
  it('keeps a broken exec wire in the graph only', () => {
    const doc = parseTypeScript(text);
    expect(
      applyTypeScriptOp(text, {
        type: 'disconnect',
        pin: pin(doc, 'Set sum', 'then'),
      }).ok
    ).toBe(false);

    const overlay = edit(
      text,
      { edits: [] },
      {
        type: 'disconnect',
        pin: pin(doc, 'Set sum', 'then'),
      }
    );
    const shown = applyOverlay(doc, overlay);
    const issues = overlayIssues(doc, shown);
    expect(issues.map((i) => i.node)).toContain(nodeId(doc, 'For Each'));
    expect(resolveOverlay(text, overlay, backend).status).toBe('pending');
  });

  it('writes the code once the cut-off statement is wired again', () => {
    const doc = parseTypeScript(text);
    let overlay = edit(
      text,
      { edits: [] },
      {
        type: 'disconnect',
        pin: pin(doc, 'Set sum', 'then'),
      }
    );
    // Set sum → console.log, console.log → For Each, For Each → return.
    overlay = edit(text, overlay, {
      type: 'connect',
      from: pin(doc, 'Set sum', 'then'),
      to: pin(doc, 'console.log', 'exec'),
    });
    overlay = edit(text, overlay, {
      type: 'connect',
      from: pin(doc, 'console.log', 'then'),
      to: pin(doc, 'For Each', 'exec'),
    });
    overlay = edit(text, overlay, {
      type: 'connect',
      from: pin(doc, 'For Each', 'completed'),
      to: pin(doc, 'Return', 'exec'),
    });

    const result = resolveOverlay(text, overlay, backend);
    expect(result).toEqual({
      status: 'synced',
      text: [
        'function total(items: number[]): number {',
        '  let sum = 0;',
        '  console.log(sum);',
        '  for (const item of items) {',
        '    sum += item;',
        '  }',
        '  return sum;',
        '}',
        '',
      ].join('\n'),
    });
  });

  it('is in sync again when a broken wire is wired back', () => {
    const doc = parseTypeScript(text);
    let overlay = edit(
      text,
      { edits: [] },
      {
        type: 'disconnect',
        pin: pin(doc, 'Set sum', 'then'),
      }
    );
    overlay = edit(text, overlay, {
      type: 'connect',
      from: pin(doc, 'Set sum', 'then'),
      to: pin(doc, 'For Each', 'exec'),
    });
    expect(resolveOverlay(text, overlay, backend)).toEqual({
      status: 'synced',
      text,
    });
  });

  it('deletes the cut-off nodes in the code', () => {
    const doc = parseTypeScript(text);
    let overlay = edit(
      text,
      { edits: [] },
      {
        type: 'disconnect',
        pin: pin(doc, 'Set sum', 'then'),
      }
    );
    overlay = edit(text, overlay, {
      type: 'connect',
      from: pin(doc, 'Set sum', 'then'),
      to: pin(doc, 'console.log', 'exec'),
    });
    overlay = edit(text, overlay, {
      type: 'deleteNodes',
      nodeIds: [nodeId(doc, 'For Each')],
    });

    const result = resolveOverlay(text, overlay, backend);
    expect(result.status).toBe('synced');
    expect(result.status === 'synced' && result.text).not.toContain('for (');
  });

  it('follows the code when it is edited while out of sync', () => {
    const doc = parseTypeScript(text);
    const overlay = edit(
      text,
      { edits: [] },
      {
        type: 'disconnect',
        pin: pin(doc, 'Set sum', 'then'),
      }
    );
    const edits = [{ start: 0, end: 0, text: 'const unit = "€";\n\n' }];
    const next = applyTextEdits(text, edits);
    const nextDoc = parseTypeScript(next);
    const remapped = remapOverlay(doc, nextDoc, overlay, {
      before: text,
      edits,
    });
    expect(remapped.dropped).toBe(0);
    const issues = overlayIssues(
      nextDoc,
      applyOverlay(nextDoc, remapped.overlay)
    );
    expect(issues.map((i) => i.node)).toContain(nodeId(nextDoc, 'For Each'));
  });

  it('waits for a wired value until the code computes it first', () => {
    const source = [
      'function show(): void {',
      '  const a = 1;',
      '  console.log(a);',
      '  const b = 2;',
      '}',
      '',
    ].join('\n');
    const doc = parseTypeScript(source);
    const wire = {
      type: 'connect' as const,
      from: pin(doc, 'Set b', 'out'),
      to: pin(doc, 'console.log', 'arg0'),
    };
    expect(applyTypeScriptOp(source, wire).ok).toBe(false);

    let overlay = edit(source, { edits: [] }, wire);
    const pending = resolveOverlay(source, overlay, backend);
    expect(pending.status).toBe('pending');
    expect(pending.status === 'pending' && pending.issues[0]?.message).toBe(
      'That value is not available yet at this point of the code.'
    );

    // Run `b` before the log: a → b → log.
    overlay = edit(source, overlay, {
      type: 'connect',
      from: pin(doc, 'Set a', 'then'),
      to: pin(doc, 'Set b', 'exec'),
    });
    overlay = edit(source, overlay, {
      type: 'connect',
      from: pin(doc, 'Set b', 'then'),
      to: pin(doc, 'console.log', 'exec'),
    });
    expect(resolveOverlay(source, overlay, backend)).toEqual({
      status: 'synced',
      text: [
        'function show(): void {',
        '  const a = 1;',
        '  const b = 2;',
        '  console.log(b);',
        '}',
        '',
      ].join('\n'),
    });
  });

  it('moves the statement around a call inside an expression', () => {
    const source = [
      'const user = "Jane";',
      'const text = greet(user);',
      'console.log(greet(user));',
      '',
    ].join('\n');
    const doc = parseTypeScript(source);
    const calls = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.title === 'greet');
    const [first, second] = calls;
    if (!first || !second) {
      throw new Error('no greet calls');
    }

    let overlay = edit(
      source,
      { edits: [] },
      {
        type: 'disconnect',
        pin: pin(doc, 'Set user', 'then'),
      }
    );
    overlay = edit(source, overlay, {
      type: 'connect',
      from: pin(doc, 'Set user', 'then'),
      to: { node: second.id, pin: 'exec' },
    });
    overlay = edit(source, overlay, {
      type: 'connect',
      from: pin(doc, 'console.log', 'then'),
      to: { node: first.id, pin: 'exec' },
    });
    expect(resolveOverlay(source, overlay, backend)).toEqual({
      status: 'synced',
      text: [
        'const user = "Jane";',
        'console.log(greet(user));',
        'const text = greet(user);',
        '',
      ].join('\n'),
    });
  });

  it('drops edits whose nodes were deleted in the code', () => {
    const doc = parseTypeScript(text);
    const overlay = edit(
      text,
      { edits: [] },
      {
        type: 'disconnect',
        pin: pin(doc, 'console.log', 'then'),
      }
    );
    const next = text.replace('  console.log(sum);\n', '');
    const remapped = remapOverlay(doc, parseTypeScript(next), overlay);
    expect(remapped.dropped).toBe(1);
    expect(remapped.overlay.edits).toEqual([]);
  });
});
