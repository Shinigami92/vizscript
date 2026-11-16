import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

/** Adds a call of `fetch` after the module statement that sets `name`. */
function callAfterSet(text: string, name: string): string {
  const doc = parsePythonDocument(text, 'main.py');
  const set = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.kind === 'setVar' && n.title === `Set ${name}`);
  const op: GraphOp = {
    type: 'addNode',
    template: { type: 'call', callee: 'fetch' },
    after: { node: set?.id ?? '', pin: 'then' },
  };
  const result = applyPythonOp(text, op, 'main.py');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('statements of the module', () => {
  it('go below the functions they may call', () => {
    const text = 'API = 1\n\n\ndef fetch():\n    return API\n';
    expect(callAfterSet(text, 'API')).toBe(
      'API = 1\n\n\ndef fetch():\n    return API\n\n\nfetch()\n'
    );
  });

  it('stay before the next statement of the module', () => {
    const text = 'API = 1\n\n\ndef fetch():\n    return API\n\n\nprint(API)\n';
    expect(callAfterSet(text, 'API')).toBe(
      'API = 1\n\n\ndef fetch():\n    return API\n\n\nfetch()\n\n\nprint(API)\n'
    );
  });

  it('follow their anchor when no definition comes between', () => {
    const text = 'API = 1\nUNITS = 2\n\n\ndef fetch():\n    return API\n';
    expect(callAfterSet(text, 'API')).toBe(
      'API = 1\nfetch()\nUNITS = 2\n\n\ndef fetch():\n    return API\n'
    );
  });
});
