import type { GraphDocument, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

const SOURCE = `extends Node

## Moves the player.
func move(delta: float) -> void:
	# Integrate velocity
	position += velocity * delta
	#region Clamp
	if position.x < 0:
		position.x = 0
	#endregion
	print(position)
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
  const result = applyGDScriptOp(text, op);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('GDScript comments', () => {
  it('attaches comments and regions', () => {
    const doc = parseGDScriptDocument(SOURCE);
    const commented = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.comment)
      .map((n) => [n.kind, n.comment?.text]);
    expect(commented).toEqual([
      ['entry', 'Moves the player.'],
      ['setVar', 'Integrate velocity'],
    ]);
    const boxes = doc.functions.flatMap((f) => f.comments ?? []);
    expect(boxes.map((b) => b.title)).toEqual(['Clamp']);
  });

  it('writes # comments and #region markers', () => {
    const doc = parseGDScriptDocument(SOURCE);
    const commented = apply(SOURCE, {
      type: 'setComment',
      node: nodeOf(doc, 'print'),
      text: 'Debug',
    });
    expect(commented).toContain('\t# Debug\n\tprint(position)');

    const boxed = apply(SOURCE, {
      type: 'addCommentBox',
      nodes: [nodeOf(doc, 'print')],
      title: 'Log',
    });
    expect(boxed).toContain('\t#region Log\n\tprint(position)\n\t#endregion\n');
  });
});
