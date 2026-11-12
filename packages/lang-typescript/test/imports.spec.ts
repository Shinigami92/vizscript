import type { GraphOp, ParseOptions, ScriptSymbol } from '@vizscript/core';
import {
  applyTextEdits,
  defaultExport,
  exportedSymbols,
  summarizeGraph,
  summarizeSymbols,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function imports(doc: {
  symbols?: ReadonlyArray<{
    kind: string;
    name: string;
    module?: string;
    imported?: string;
    modifiers: string[];
  }>;
}): string[] {
  return (doc.symbols ?? [])
    .filter((s) => s.kind === 'import')
    .map(
      (s) =>
        `${s.name} ← ${s.imported} of ${s.module}${s.modifiers.length > 0 ? ` [${s.modifiers.join(' ')}]` : ''}`
    );
}

describe('import symbols', () => {
  it('collects TypeScript imports', () => {
    const doc = parseTypeScript(
      "import a, { b as c, type D } from './x';\nimport * as ns from 'y';\nimport type { E } from './e';\n",
      't.ts'
    );
    expect(imports(doc)).toMatchInlineSnapshot(`
      [
        "a ← default of ./x",
        "c ← b of ./x",
        "D ← D of ./x [type]",
        "ns ← * of y",
        "E ← E of ./e [type]",
      ]
    `);
  });
});

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function del(text: string, name: string): string {
  return apply(text, { type: 'deleteSymbol', symbol: `import:${name}` });
}

describe('deleting imports', () => {
  it('removes one name of a list', () => {
    const text = "import { a, b, c } from './x';\nconsole.log(a);\n";
    expect(del(text, 'a')).toBe(
      "import { b, c } from './x';\nconsole.log(a);\n"
    );
    expect(del(text, 'c')).toBe(
      "import { a, b } from './x';\nconsole.log(a);\n"
    );
  });

  it('removes braces left empty', () => {
    expect(del("import a, { b } from './x';\n", 'b')).toBe(
      "import a from './x';\n"
    );
    expect(del("import a, { b } from './x';\n", 'a')).toBe(
      "import { b } from './x';\n"
    );
  });

  it('removes the statement with its last name', () => {
    expect(del("import { a } from './x';\n\nconst y = 1;\n", 'a')).toBe(
      'const y = 1;\n'
    );
  });
});

describe('declarations of imported files', () => {
  const util = [
    "export function greet(name: string, punctuation = '!'): string {",
    '  return name + punctuation;',
    '}',
    'export const LIMIT = 3;',
    'function hidden(): void {}',
    'export default function main(): void {}',
    '',
  ].join('\n');
  const exports = exportedSymbols(parseTypeScript(util, 'util.ts'), util);
  const declaration = (name: string): ScriptSymbol | undefined =>
    exports.find((s) => s.name === name);
  const options: ParseOptions = {
    imports: [
      { name: 'main', declaration: defaultExport(exports) },
      { name: 'greet', declaration: declaration('greet') },
      { name: 'LIMIT', declaration: declaration('LIMIT') },
      { name: 'u', members: exports },
    ],
  };
  const text = [
    "import main, { greet, LIMIT } from './util';",
    "import * as u from './util';",
    "greet('a');",
    "u.greet('b', '?');",
    'main();',
    'console.log(LIMIT);',
    '',
  ].join('\n');

  it('exports only exported names', () => {
    expect(exports.map((s) => s.name)).toEqual(['greet', 'LIMIT', 'main']);
  });

  it('gives imports their declarations', () => {
    const doc = parseTypeScript(text, 'm.ts', options);
    expect(summarizeSymbols(doc)).toMatchInlineSnapshot(`
      "import main(): void ← default of ./util
      import greet(name: string, punctuation = …): string ← greet of ./util
      import LIMIT ~number ← LIMIT of ./util
      import u ← * of ./util"
    `);
    expect(summarizeGraph(doc)).toMatchInlineSnapshot(`
      "function Module
        #0 entry "Module" (m.ts) [>then:▶]
        #1 call "greet" [<exec:▶ >then:▶ <arg0:string='a' <param:punctuation:string= >return:string]
        #2 call "u.greet" [<exec:▶ >then:▶ <arg0:string='b' <arg1:string='?' >return:string]
        #3 call "main" [<exec:▶ >then:▶]
        #4 getVar "LIMIT" [>value:number]
        #5 call "console.log" [<exec:▶ >then:▶ <arg0:any >return:any]
        ==> #0.then -> #1.exec
        ==> #1.then -> #2.exec
        ==> #2.then -> #3.exec
        --> #4.value -> #5.arg0
        ==> #3.then -> #5.exec"
    `);
  });

  it('fills in arguments of imported functions', () => {
    const doc = parseTypeScript(text, 'm.ts', options);
    const call = doc.functions[0]?.nodes.find(
      (n) => n.kind === 'call' && n.title === 'greet'
    );
    const result = applyTypeScriptOp(
      text,
      {
        type: 'setLiteral',
        node: call?.id ?? '',
        pin: 'param:punctuation',
        value: '?',
      },
      'm.ts',
      options
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toContain(
      "greet('a', '?');"
    );
  });
});
