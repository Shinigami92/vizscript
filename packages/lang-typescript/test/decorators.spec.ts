import { summarizeGraph } from '@vizscript/core';
import type { GraphOp } from '@vizscript/core';
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
