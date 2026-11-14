import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  OpResult,
} from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function run(text: string, op: GraphOp): OpResult {
  return applyTypeScriptOp(text, op, 'a.ts');
}

function apply(text: string, op: GraphOp): string {
  const result = run(text, op);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function node(doc: GraphDocument, match: (n: GraphNode) => boolean): GraphNode {
  const found = doc.functions.flatMap((f) => f.nodes).find(match);
  if (!found) {
    throw new Error('no node');
  }

  return found;
}

function entryOf(doc: GraphDocument, name: string): string {
  return node(doc, (n) => n.kind === 'entry' && n.title === name).id;
}

describe('empty blocks', () => {
  it('puts the closing brace on its own line', () => {
    for (const [text, name, expected] of [
      ['function f() {}\n', 'f', 'function f() {\n  log(1);\n}\n'],
      [
        "on('x', (err) => {});\n",
        'on callback',
        "on('x', (err) => {\n  log(1);\n});\n",
      ],
    ] as const) {
      const doc = parseTypeScript(text, 'a.ts');
      expect(
        apply(text, {
          type: 'addNode',
          template: { type: 'call', callee: 'log', args: ['1'] },
          after: { node: entryOf(doc, name), pin: 'then' },
        })
      ).toBe(expected);
    }
  });
});

describe('return', () => {
  it('is refused in the top level of a file', () => {
    const text = 'log(1);\n';
    const doc = parseTypeScript(text, 'a.ts');
    const result = run(text, {
      type: 'addNode',
      template: { type: 'return' },
      after: { node: node(doc, (n) => n.title === 'log').id, pin: 'then' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('moved statements', () => {
  it('take the comment above them along', () => {
    const text = ['a();', '', '// Explains b', 'b();', '', 'c();', ''].join(
      '\n'
    );
    const doc = parseTypeScript(text, 'a.ts');
    expect(
      apply(text, {
        type: 'connect',
        from: { node: node(doc, (n) => n.title === 'c').id, pin: 'then' },
        to: { node: node(doc, (n) => n.title === 'b').id, pin: 'exec' },
      })
    ).toBe(['a();', '', 'c();', '// Explains b', 'b();', ''].join('\n'));
  });
});

/** `useValue` on the result of the last call (or the one titled so). */
function chain(text: string, expression: string, title?: string): string {
  const doc = parseTypeScript(text, 'a.ts');
  const last = doc.functions
    .flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'call' && (!title || n.title === title))
    .at(-1);
  const pin = last?.pins.find(
    (p) => p.kind === 'data' && p.direction === 'out'
  );
  if (!last || !pin) {
    throw new Error('no call');
  }

  return apply(text, {
    type: 'useValue',
    pin: { node: last.id, pin: pin.id },
    expression,
  });
}

describe('fluent chains', () => {
  it('continue the chain of an unused call result', () => {
    expect(chain("program.name('x');\n", '$value.version()')).toBe(
      "program.name('x').version();\n"
    );
    expect(
      chain("program\n  .name('x')\n  .description('d');\n", '$value.help')
    ).toBe("program\n  .name('x')\n  .description('d')\n  .help;\n");
  });

  it('bind a used result first', () => {
    expect(chain('log(make());\n', '$value.version()', 'make')).toContain(
      'Result.version()'
    );
  });
});
