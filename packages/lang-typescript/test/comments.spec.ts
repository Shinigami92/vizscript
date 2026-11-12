import type { GraphDocument, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

const SOURCE = `/**
 * Greets a user.
 */
export function greet(name: string): void {
  // Build the message
  // (twice as nice)
  const message = 'Hello ' + name;

  // #region Output
  console.log(message);
  if (name) {
    console.log('again');
  }
  // #endregion

  log(message); // trailing comments stay in the code
}
`;

function comments(doc: GraphDocument): Array<[string, string]> {
  return doc.functions.flatMap((fn) =>
    fn.nodes.flatMap((n) =>
      n.comment ? [[n.title, n.comment.text] as [string, string]] : []
    )
  );
}

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function nodeId(doc: GraphDocument, title: string): string {
  const node = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === title);
  if (!node) {
    throw new Error(`No node ${title}`);
  }

  return node.id;
}

describe('comments', () => {
  it('attaches comments above statements and functions', () => {
    const doc = parseTypeScript(SOURCE);
    expect(comments(doc)).toEqual([
      ['greet', 'Greets a user.'],
      ['Set message', 'Build the message\n(twice as nice)'],
    ]);
  });

  it('turns regions into comment boxes', () => {
    const doc = parseTypeScript(SOURCE);
    const boxes = doc.functions.flatMap((f) => f.comments ?? []);
    expect(boxes.map((b) => [b.title, b.nodes.length > 0])).toEqual([
      ['Output', true],
    ]);
    const box = boxes[0];
    expect(SOURCE.slice(box?.titleRange.start, box?.titleRange.end)).toBe(
      'Output'
    );
  });

  it('adds a doc comment above an exported function', () => {
    const text = 'export function f(): void {}\n';
    const doc = parseTypeScript(text);
    const entry = doc.functions
      .flatMap((fn) => fn.nodes)
      .find((n) => n.kind === 'entry' && n.title === 'f');
    expect(
      apply(text, {
        type: 'setComment',
        node: entry?.id ?? '',
        text: 'Does f.',
        doc: true,
      })
    ).toBe('/**\n * Does f.\n */\nexport function f(): void {}\n');
  });

  it('edits, adds and removes node comments', () => {
    const doc = parseTypeScript(SOURCE);
    const edited = apply(SOURCE, {
      type: 'setComment',
      node: nodeId(doc, 'Set message'),
      text: 'Compose it',
    });
    expect(edited).toContain('  // Compose it\n  const message');
    expect(edited).not.toContain('twice as nice');

    const doc2 = parseTypeScript(SOURCE);
    const added = apply(SOURCE, {
      type: 'setComment',
      node: nodeId(doc2, 'log'),
      text: 'Log it\nagain',
    });
    expect(added).toContain('  // Log it\n  // again\n  log(message);');

    const doc3 = parseTypeScript(SOURCE);
    const docComment = apply(SOURCE, {
      type: 'setComment',
      node: nodeId(doc3, 'greet'),
      text: 'Says hello.',
    });
    expect(docComment.startsWith('/**\n * Says hello.\n */\nexport')).toBe(
      true
    );

    const removed = apply(SOURCE, {
      type: 'setComment',
      node: nodeId(doc, 'Set message'),
      text: '',
    });
    expect(removed).toContain('{\n  const message');
  });

  it('deletes the comment together with its statement', () => {
    const doc = parseTypeScript(SOURCE);
    const result = apply(SOURCE, {
      type: 'deleteNodes',
      nodeIds: [nodeId(doc, 'Set message')],
    });
    expect(result).not.toContain('Build the message');
    expect(result).toContain('{\n\n  // #region Output');
  });

  it('adds, renames and removes comment boxes', () => {
    const doc = parseTypeScript(SOURCE);
    const added = apply(SOURCE, {
      type: 'addCommentBox',
      nodes: [nodeId(doc, 'Set message')],
      title: 'Prepare',
    });
    expect(added).toContain(
      "  // #region Prepare\n  // Build the message\n  // (twice as nice)\n  const message = 'Hello ' + name;\n  // #endregion\n"
    );

    const box = doc.functions.flatMap((f) => f.comments ?? [])[0];
    const renamed = apply(SOURCE, {
      type: 'renameCommentBox',
      box: box?.id ?? '',
      title: 'Print',
    });
    expect(renamed).toContain('// #region Print\n');

    const removed = apply(SOURCE, {
      type: 'deleteCommentBox',
      box: box?.id ?? '',
    });
    expect(removed).not.toContain('#region');
    expect(removed).not.toContain('#endregion');
    expect(removed).toContain('\n\n  console.log(message);');
  });

  it('boxes nodes of two branches with the whole statement', () => {
    const text = 'if (a) {\n  one();\n} else {\n  two();\n}\n';
    const doc = parseTypeScript(text);
    const result = applyTypeScriptOp(text, {
      type: 'addCommentBox',
      nodes: [nodeId(doc, 'one'), nodeId(doc, 'two')],
      title: 'x',
    });
    // The branch is taken as a whole instead.
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      '// #region x\nif (a) {\n  one();\n} else {\n  two();\n}\n// #endregion\n'
    );
  });
});
