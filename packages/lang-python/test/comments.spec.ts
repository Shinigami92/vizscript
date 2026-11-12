import type { GraphDocument, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

const SOURCE = `# Loads the data.
@cache
def load(path: str) -> str:
    # region Read
    # Open the file
    with open(path) as f:
        data = f.read()
    # endregion
    return data
`;

function nodeOf(doc: GraphDocument, title: string): string {
  const node = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === title);
  if (!node) {
    throw new Error(`No node ${title}`);
  }

  return node.id;
}

function apply(text: string, op: GraphOp): string {
  const result = applyPythonOp(text, op);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('Python comments', () => {
  it('attaches comments and regions', () => {
    const doc = parsePythonDocument(SOURCE);
    const commented = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.comment)
      .map((n) => [n.kind, n.comment?.text]);
    expect(commented).toEqual([
      ['entry', 'Loads the data.'],
      ['try', 'Open the file'],
    ]);
    const boxes = doc.functions.flatMap((f) => f.comments ?? []);
    expect(boxes.map((b) => b.title)).toEqual(['Read']);
  });

  it('writes # comments and # region markers', () => {
    const doc = parsePythonDocument(SOURCE);
    const boxed = apply(SOURCE, {
      type: 'addCommentBox',
      nodes: [nodeOf(doc, 'Return')],
      title: 'Done',
    });
    expect(boxed).toContain(
      '    # region Done\n    return data\n    # endregion\n'
    );
  });
});
