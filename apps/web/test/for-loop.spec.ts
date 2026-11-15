import type { GraphDocument, GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import {
  applyGDScriptOp,
  parseGDScriptDocument,
} from '@vizscript/lang-gdscript';
import { applyPythonOp, parsePythonDocument } from '@vizscript/lang-python';
import { applyRustOp, parseRustDocument } from '@vizscript/lang-rust';
import { applyTypeScriptOp, parseTypeScript } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';

interface Language {
  name: string;
  text: string;
  parse: (text: string) => GraphDocument;
  apply: (text: string, op: GraphOp) => ReturnType<typeof applyTypeScriptOp>;
  /** The code after setting First Index to 2. */
  first: string;
}

const LANGUAGES: ReadonlyArray<Language> = [
  {
    name: 'TypeScript',
    text: 'function f(n: number) {\n  for (let i = 0; i < n; i++) {\n    g(i);\n  }\n}\n',
    parse: (text) => parseTypeScript(text, 't.ts'),
    apply: (text, op) => applyTypeScriptOp(text, op, 't.ts'),
    first: 'for (let i = 2; i < n; i++)',
  },
  {
    name: 'Python',
    text: 'def f(n):\n    for i in range(n):\n        print(i)\n',
    parse: (text) => parsePythonDocument(text, 't.py'),
    apply: (text, op) => applyPythonOp(text, op, 't.py'),
    first: 'for i in range(2, n):',
  },
  {
    name: 'GDScript',
    text: 'func f(n):\n\tfor i in range(n):\n\t\tprint(i)\n',
    parse: (text) => parseGDScriptDocument(text, 't.gd'),
    apply: (text, op) => applyGDScriptOp(text, op, 't.gd'),
    first: 'for i in range(2, n):',
  },
  {
    name: 'Rust',
    text: 'fn f(n: i32) {\n    for i in 0..n {\n        println!("{}", i);\n    }\n}\n',
    parse: (text) => parseRustDocument(text, 't.rs'),
    apply: (text, op) => applyRustOp(text, op, 't.rs'),
    first: 'for i in 2..n {',
  },
];

function loopOf(doc: GraphDocument): GraphNode | undefined {
  return doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === 'For Loop');
}

describe.each(LANGUAGES)('counting loops in $name', (language) => {
  it('are one For Loop node with index pins (like UE)', () => {
    const doc = language.parse(language.text);
    const loop = loopOf(doc);
    expect(
      loop?.pins.filter((p) => p.kind === 'data').map((p) => p.id)
    ).toEqual(['first', 'end', 'element']);
    // No node for the condition or `range(…)`.
    const fn = doc.functions.find((f) => f.name === 'f');
    expect(fn?.nodes.some((n) => ['<', 'range', '..'].includes(n.title))).toBe(
      false
    );
  });

  it('writes its First Index', () => {
    const loop = loopOf(language.parse(language.text));
    const result = language.apply(language.text, {
      type: 'setLiteral',
      node: loop?.id ?? '',
      pin: 'first',
      value: '2',
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    expect(applyTextEdits(language.text, result.edits)).toContain(
      language.first
    );
  });
});
