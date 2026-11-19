import { summarizeGraph } from '@vizscript/core';
import type { GraphOp, ScriptSymbol } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import {
  applyTypeScriptOp,
  parseTypeScript,
  typeScriptReferences,
} from '../src';

// The shape of a NestJS controller (apps/api/src/layout/layout.controller.ts).
const CONTROLLER = `import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { LayoutService } from './layout.service';

@Controller('layouts/:owner')
export class LayoutController {
  public constructor(
    @Inject(LayoutService) private readonly layouts: LayoutService
  ) {}

  @Get()
  public async get(
    @Param('owner') owner: string,
    @Query('path') path?: string
  ): Promise<string> {
    return this.layouts.get(owner, path);
  }
}
`;

describe('decorators', () => {
  it('parse in TypeScript, also on parameters', () => {
    const doc = parseTypeScript(CONTROLLER, 'layout.controller.ts');
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(
      (doc.symbols ?? [])
        .filter((s) => s.kind === 'method')
        .map(
          (s) => `${s.name}(${(s.params ?? []).map((p) => p.name).join(', ')})`
        )
    ).toEqual(['constructor(layouts)', 'get(owner, path)']);
    expect(summarizeGraph(doc)).toContain('call "get"');
  });

  it('keep the imports they use', () => {
    const references = typeScriptReferences(CONTROLLER, 'layout.controller.ts');
    expect(references.map((r) => r.specifier)).toContain('./layout.service');
  });

  it('parse in JavaScript (standard decorators)', () => {
    const doc = parseTypeScript(
      'export @sealed class A {\n  @logged\n  run() {}\n}\n',
      'a.js'
    );
    expect(doc.diagnostics ?? []).toEqual([]);
    expect((doc.symbols ?? []).map((s) => s.name)).toContain('run');
  });
});

const GENERIC = `@Injectable()
class Store<T extends object = {}> {
  @Get()
  @UseGuards(A, B)
  async get(@Param('a') a: string, @Query('b') b?: string): Promise<T> {
    return use(a, b);
  }

  @Input() name = '';
}

export function call<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

export interface Box<T> {
  value: T;
}
`;

/** `GENERIC` after an op, and whether it still parses. */
function edited(op: GraphOp): string {
  const result = applyTypeScriptOp(GENERIC, op, 'store.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  let text = GENERIC;
  for (const edit of result.edits.toSorted((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }

  expect(parseTypeScript(text, 'store.ts').diagnostics ?? []).toEqual([]);
  return text;
}

describe('decorators and type parameters in symbols', () => {
  const doc = parseTypeScript(GENERIC, 'store.ts');
  const symbol = (id: string): NonNullable<typeof doc.symbols>[number] => {
    const found = doc.symbols?.find((s) => s.id === id);
    if (!found) {
      throw new Error(id);
    }

    return found;
  };

  it('lists decorators as modifiers and on parameters', () => {
    expect(symbol('class:Store').modifiers).toEqual(['@Injectable()']);
    expect(symbol('method:Store.get').modifiers).toEqual([
      '@Get()',
      '@UseGuards(A, B)',
      'async',
    ]);
    expect(symbol('variable:Store.name').modifiers).toEqual(['@Input()']);
    expect(symbol('method:Store.get').params?.map((p) => p.decorators)).toEqual(
      [["@Param('a')"], ["@Query('b')"]]
    );
  });

  it('lists type parameters as written', () => {
    expect(symbol('class:Store').typeParams).toEqual(['T extends object = {}']);
    expect(symbol('function:call').typeParams).toEqual(['T']);
    expect(symbol('type:Box').typeParams).toEqual(['T']);
    expect(symbol('method:Store.get').typeParams).toBeUndefined();
  });

  it('writes keywords after the decorators', () => {
    expect(
      edited({
        type: 'setModifier',
        symbol: 'method:Store.get',
        modifier: 'private',
        enabled: true,
      })
    ).toContain('@UseGuards(A, B)\n  private async get(');
    expect(
      edited({
        type: 'setModifier',
        symbol: 'class:Store',
        modifier: 'export',
        enabled: true,
      })
    ).toContain('@Injectable()\nexport class Store');
  });

  it('removes and moves inputs with their decorators', () => {
    expect(
      edited({
        type: 'removeParameter',
        symbol: 'method:Store.get',
        index: 0,
      })
    ).toContain("get(@Query('b') b?: string)");
    expect(
      edited({
        type: 'removeParameter',
        symbol: 'method:Store.get',
        index: 1,
      })
    ).toContain("get(@Param('a') a: string)");
    expect(
      edited({
        type: 'moveParameter',
        symbol: 'method:Store.get',
        from: 1,
        to: 0,
      })
    ).toContain("get(@Query('b') b?: string, @Param('a') a: string)");
  });
});

function decorate(
  symbol: string,
  change: { param?: number; index?: number; text: string | null }
): string {
  return edited({ type: 'setDecorator', symbol, ...change });
}

/** Why an op on `GENERIC` was refused. */
function refused(op: GraphOp): string | undefined {
  const result = applyTypeScriptOp(GENERIC, op, 'store.ts');
  return result.ok ? undefined : result.error;
}

function typed(symbol: string, text: string): string {
  return edited({ type: 'setTypeParams', symbol, text });
}

describe('editing decorators and type parameters', () => {
  it('adds decorators in the style of the others', () => {
    expect(decorate('method:Store.get', { text: "@Header('x')" })).toContain(
      "@UseGuards(A, B)\n  @Header('x')\n  async get("
    );
    // `@` is added when it is missing.
    expect(decorate('class:Store', { text: "Controller('x')" })).toContain(
      "@Injectable()\n@Controller('x')\nclass Store"
    );
    expect(decorate('variable:Store.name', { text: '@Output()' })).toContain(
      "@Input() @Output() name = '';"
    );
    expect(
      decorate('method:Store.get', { param: 0, text: '@Body()' })
    ).toContain("get(@Param('a') @Body() a: string");
  });

  it('replaces and removes decorators', () => {
    expect(
      decorate('method:Store.get', { index: 1, text: '@UseGuards(C)' })
    ).toContain('@Get()\n  @UseGuards(C)\n  async get(');
    expect(decorate('method:Store.get', { index: 0, text: null })).toContain(
      '{\n  @UseGuards(A, B)\n  async get('
    );
    expect(
      decorate('method:Store.get', { param: 1, index: 0, text: null })
    ).toContain("@Param('a') a: string, b?: string)");
  });

  it('refuses what is no decorator, or where none can be', () => {
    expect(
      refused({
        type: 'setDecorator',
        symbol: 'method:Store.get',
        text: '@Get(',
      })
    ).toBe('"@Get(" is not a valid decorator.');
    expect(
      refused({
        type: 'setDecorator',
        symbol: 'method:Store.get',
        text: '@A() m() {} @B()',
      })
    ).toMatch(/not a valid decorator/);
    expect(
      refused({ type: 'setDecorator', symbol: 'function:call', text: '@Log()' })
    ).toBe('Only classes and their members have decorators in TypeScript.');
    expect(
      refused({
        type: 'setTypeParams',
        symbol: 'function:call',
        text: 'T extends',
      })
    ).toBe('"T extends" are not valid type parameters.');
  });

  it('sets, adds and removes type parameters', () => {
    expect(typed('class:Store', 'T, K extends keyof T')).toContain(
      'class Store<T, K extends keyof T> {'
    );
    expect(typed('function:call', '')).toContain('export function call(fn:');
    expect(typed('method:Store.get', '<R = void>')).toContain(
      'async get<R = void>(@Param'
    );
    expect(typed('type:Box', 'T extends () => void')).toContain(
      'interface Box<T extends () => void> {'
    );
  });
});

describe('a new decorator with its import', () => {
  it('joins the import of its module, in one edit', () => {
    const text = [
      "import { Controller, Get } from '@nestjs/common';",
      '',
      "@Controller('x')",
      'export class C {',
      '  @Get()',
      '  get(): void {}',
      '}',
      '',
    ].join('\n');
    const result = applyTypeScriptOp(
      text,
      {
        type: 'withImport',
        import: {
          path: '',
          from: 'c.ts',
          name: 'Header',
          imported: 'Header',
          module: '@nestjs/common',
        },
        op: {
          type: 'setDecorator',
          symbol: 'method:C.get',
          text: "@Header('a', 'b')",
        },
      },
      'c.ts'
    );
    expect(result.ok && applyEdits(text, result.edits)).toBe(
      [
        "import { Controller, Get, Header } from '@nestjs/common';",
        '',
        "@Controller('x')",
        'export class C {',
        '  @Get()',
        "  @Header('a', 'b')",
        '  get(): void {}',
        '}',
        '',
      ].join('\n')
    );
  });
});

describe('a new name in an import written one per line', () => {
  it('gets a line of its own', () => {
    const text = [
      'import {',
      '  Controller,',
      '  Get,',
      "} from '@nestjs/common';",
      '',
      'export class C {}',
      '',
    ].join('\n');
    const result = applyTypeScriptOp(
      text,
      {
        type: 'addImport',
        import: {
          path: '',
          from: 'c.ts',
          name: 'Header',
          imported: 'Header',
          module: '@nestjs/common',
        },
      },
      'c.ts'
    );
    expect(result.ok && applyEdits(text, result.edits)).toContain(
      "  Get,\n  Header,\n} from '@nestjs/common';"
    );
  });
});

function applyEdits(
  text: string,
  edits: ReadonlyArray<{ start: number; end: number; text: string }>
): string {
  let result = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }

  return result;
}

describe('calls of generics', () => {
  it('give wildcards for type parameters until the checker knows', () => {
    const doc = parseTypeScript(
      [
        'function first<T>(items: T[]): T {',
        '  return items[0] as T;',
        '}',
        'function pair<K, V>(key: K, value: V): Map<K, V> {',
        '  return new Map([[key, value]]);',
        '}',
        'const n = first([1, 2]);',
        "const m = pair('a', 1);",
        '',
      ].join('\n'),
      'a.ts'
    );
    const nodes = doc.functions.flatMap((f) => f.nodes);
    const result = (title: string): string | undefined =>
      nodes
        .find((n) => n.kind === 'call' && n.title === title)
        ?.pins.find((p) => p.id === 'return')?.type;
    expect(result('first')).toBe('any');
    expect(result('pair')).toBe('map');
    // Inside the generic, T is a type of its own.
    expect(symbolOf(doc.symbols, 'function:first').params?.[0]?.dataType).toBe(
      'T[]'
    );
  });

  it('give wildcards for imported generics', () => {
    const declaration: ScriptSymbol = {
      id: 'function:first',
      kind: 'function',
      name: 'first',
      scope: '',
      range: { start: 0, end: 0 },
      nameRange: { start: 0, end: 0 },
      dataType: 'function',
      modifiers: ['export'],
      typeParams: ['T'],
      params: [
        {
          name: 'items',
          nameRange: { start: 0, end: 0 },
          dataType: 'T[]',
        },
      ],
      returnType: 'T',
    };
    const doc = parseTypeScript(
      "import { first } from './util';\n\nconst n = first(list);\n",
      'a.ts',
      { imports: [{ name: 'first', declaration }] }
    );
    const call = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.kind === 'call' && n.title === 'first');
    expect(
      call?.pins
        .filter((p) => p.kind === 'data')
        .map((p) => `${p.direction} ${p.name}:${p.type}`)
    ).toEqual(['in this:object', 'in items:array', 'out :any']);
  });
});

function symbolOf(
  symbols: ReadonlyArray<ScriptSymbol> | undefined,
  id: string
): ScriptSymbol {
  const found = symbols?.find((s) => s.id === id);
  if (!found) {
    throw new Error(id);
  }

  return found;
}
