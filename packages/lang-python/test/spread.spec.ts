import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, pinLabel } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

function nodeOf(text: string, kind: GraphNode['kind']): GraphNode {
  const found = parsePythonDocument(text, 't.py')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === kind);
  if (!found) {
    throw new Error(`no ${kind} node`);
  }

  return found;
}

function spread(
  text: string,
  kind: GraphNode['kind'],
  pin: string,
  on: boolean
): ReturnType<typeof applyPythonOp> & { text?: string } {
  const node = nodeOf(text, kind);
  const op: GraphOp = {
    type: 'setSpread',
    pin: { node: node.id, pin },
    spread: on,
  };
  const result = applyPythonOp(text, op, 't.py');
  return result.ok
    ? { ...result, text: applyTextEdits(text, result.edits) }
    : result;
}

describe('spread values (Python)', () => {
  it('unpacks an argument with * and passes it as one value again', () => {
    expect(spread('show(a, b)\n', 'call', 'arg1', true).text).toBe(
      'show(a, *b)\n'
    );
    expect(spread('show(a, *b)\n', 'call', 'arg1', false).text).toBe(
      'show(a, b)\n'
    );
  });

  it('unpacks an element of a list', () => {
    expect(spread('xs = [a, b]\n', 'makeArray', 'e1', true).text).toBe(
      'xs = [a, *b]\n'
    );
    const node = nodeOf('xs = [a, *b]\n', 'makeArray');
    const pin = node.pins.find((p) => p.id === 'e1');
    expect(pin && pinLabel(node, pin)).toBe('*');
  });

  it('keeps ** and keyword arguments as they are', () => {
    expect(spread('show(**opts)\n', 'call', 'arg0', false).ok).toBe(false);
    expect(spread('show(size=b)\n', 'call', 'arg0', true).ok).toBe(false);
  });
});
