import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

describe('break node links', () => {
  it('breaks a node’s own wires, whatever else the function calls', () => {
    // `UNITS.get(…)` is a method with a wired receiver elsewhere in the
    // function: it must not stop breaking the links of `len`.
    const text = [
      'UNITS = {"metric": "°C"}',
      '',
      '',
      'def summary(temps, units):',
      '    symbol = UNITS.get(units, "?")',
      '    average = sum(temps) / len(temps) if temps else 0.0',
      '    return symbol, average',
      '',
    ].join('\n');
    const len = parsePythonDocument(text, 't.py')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === 'len');
    const result = applyPythonOp(
      text,
      { type: 'disconnectNode', node: len?.id ?? '' },
      't.py'
    );
    expect(
      result.ok ? applyTextEdits(text, result.edits) : result.error
    ).toContain('    average = sum(temps) / None if temps else 0.0\n');
  });

  it('still keeps a method that would lose its receiver in the graph', () => {
    const text = 'def f(units):\n    return UNITS.get(units, "?")\n';
    const get = parsePythonDocument(text, 't.py')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === 'UNITS');
    const result = applyPythonOp(
      text,
      { type: 'disconnectNode', node: get?.id ?? '' },
      't.py'
    );
    expect(result.ok).toBe(false);
  });
});
