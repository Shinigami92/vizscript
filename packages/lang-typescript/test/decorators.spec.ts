import { summarizeGraph } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript, typeScriptReferences } from '../src';

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
