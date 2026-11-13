import type { GraphDocument, GraphOp, Positions } from '@vizscript/core';
import { applyTextEdits, diffEdits, reconcilePositions } from '@vizscript/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

const FILE = 'inventory.ts';
const text = readFileSync(join(import.meta.dirname, 'fixtures', FILE), 'utf8');

function parse(source: string): GraphDocument {
  return parseTypeScript(source, FILE);
}

/** Every node at its own place, like a laid-out graph. */
function placed(doc: GraphDocument): Positions {
  const positions: Positions = {};
  for (const [i, node] of doc.functions.flatMap((f) => f.nodes).entries()) {
    positions[node.id] = { x: i * 100, y: i * 10 };
  }

  return positions;
}

/**
 * An op, then undo (the editor puts the old text back), like the web app:
 * positions follow the op's edits, then the text diff of the undo.
 * Returns the nodes that are not where they were.
 */
function afterUndo(op: GraphOp): string[] | undefined {
  const before = parse(text);
  const positions = placed(before);
  const result = applyTypeScriptOp(text, op, FILE);
  if (!result.ok || result.edits.length === 0) {
    return undefined;
  }

  const memory: Positions = {};
  const edited = applyTextEdits(text, result.edits);
  const editedDoc = parse(edited);
  const between = reconcilePositions(
    before,
    editedDoc,
    positions,
    { before: text, edits: result.edits },
    memory
  );
  const undone = parse(text);
  const back = reconcilePositions(
    editedDoc,
    undone,
    between,
    { before: edited, edits: diffEdits(edited, text) },
    memory
  );
  return undone.functions
    .flatMap((f) => f.nodes)
    .filter(
      (n) => JSON.stringify(back[n.id]) !== JSON.stringify(positions[n.id])
    )
    .map((n) => `${n.title} (${n.id})`);
}

const doc = parse(text);
const nodes = doc.functions
  .flatMap((f) => f.nodes)
  .filter((n) => n.kind !== 'entry');
const wires = doc.functions.flatMap((f) => f.edges);

describe('undo keeps the layout', () => {
  it.each(nodes.map((n) => [`${n.title} ${n.id}`, n.id]))(
    'deleting %s',
    (_, id) => {
      expect(afterUndo({ type: 'deleteNodes', nodeIds: [id] })).toEqual([]);
    }
  );

  it.each(
    wires
      .filter((e) => e.kind === 'data')
      .map((e) => [e.id, e.to.node, e.to.pin])
  )('disconnecting %s', (_, node, pin) => {
    // Some wires can't be broken in code (no result is fine).
    expect(afterUndo({ type: 'disconnect', pin: { node, pin } }) ?? []).toEqual(
      []
    );
  });
});
