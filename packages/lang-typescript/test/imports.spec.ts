import type { GraphOp, ParseOptions, ScriptSymbol } from '@vizscript/core';
import {
  applyTextEdits,
  defaultExport,
  exportedSymbols,
  summarizeGraph,
  summarizeSymbols,
  withReexports,
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

/** Calls `greet` at the start of `f`, importing it from `path`. */
function useGreet(
  text: string,
  path = 'src/util.ts',
  imported = 'greet'
): string {
  const doc = parseTypeScript(text, 'src/main.ts');
  const entry = doc.functions
    .find((f) => f.name === 'f')
    ?.nodes.find((n) => n.kind === 'entry');
  const result = applyTypeScriptOp(
    text,
    {
      type: 'withImport',
      import: { path, from: 'src/main.ts', name: 'greet', imported },
      op: {
        type: 'addNode',
        template: { type: 'call', callee: 'greet' },
        after: { node: entry?.id ?? '', pin: 'then' },
      },
    },
    'src/main.ts'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('adding imports', () => {
  it('adds an import on top', () => {
    expect(useGreet('function f() {\n}\n')).toBe(
      "import { greet } from './util';\n\nfunction f() {\n  greet();\n}\n"
    );
  });

  it('joins an import of the same module', () => {
    expect(
      useGreet(
        'import { a } from "./util";\nimport b from "./b";\n\nfunction f() {\n}\n'
      )
    ).toBe(
      'import { a, greet } from "./util";\nimport b from "./b";\n\nfunction f() {\n  greet();\n}\n'
    );
  });

  it('follows the file style of paths, quotes and semicolons', () => {
    expect(
      useGreet(
        'import { b } from "./b.js"\n\nfunction f() {\n}\n',
        'lib/greet/index.ts'
      )
    ).toBe(
      'import { b } from "./b.js"\nimport { greet } from "../lib/greet/index.js"\n\nfunction f() {\n  greet();\n}\n'
    );
  });

  it('imports default exports and directories', () => {
    expect(
      useGreet('function f() {\n}\n', 'src/greet/index.ts', 'default')
    ).toBe("import greet from './greet';\n\nfunction f() {\n  greet();\n}\n");
  });

  it('keeps an existing import', () => {
    expect(
      useGreet("import { greet } from './util';\n\nfunction f() {\n}\n")
    ).toBe(
      "import { greet } from './util';\n\nfunction f() {\n  greet();\n}\n"
    );
  });

  it('refuses a name that is taken', () => {
    expect(() => useGreet('const greet = 1;\nfunction f() {\n}\n')).toThrow(
      'greet already exists in this file.'
    );
  });
});

describe('re-exports', () => {
  it('follows re-exports of declaration files', async () => {
    const files: Record<string, string> = {
      'index.d.ts': [
        "export * from './a';",
        "export { b as bee, c } from './b';",
        'export declare function own(x: number): void;',
        'export { own as alias };',
        '',
      ].join('\n'),
      'a.d.ts': 'export declare function a(name: string): string;\n',
      'b.d.ts':
        'export declare function b(): number;\nexport declare const c: string;\n',
    };
    const read = async (path: string): Promise<ScriptSymbol[]> => {
      const text = files[path] ?? '';
      const doc = parseTypeScript(text, path);
      return withReexports(
        exportedSymbols(doc, text),
        doc.reexports ?? [],
        (module) => read(`${module.slice(2)}.d.ts`)
      );
    };
    const exports = await read('index.d.ts');
    expect(
      exports.map(
        (s) => `${s.name}(${(s.params ?? []).map((p) => p.name).join(', ')})`
      )
    ).toEqual(['own(x)', 'a(name)', 'bee()', 'c()', 'alias(x)']);
  });
});
