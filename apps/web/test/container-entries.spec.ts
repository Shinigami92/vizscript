import type { GraphOp, Pin, TypeSystemInfo } from '@vizscript/core';
import { pythonBackend } from '@vizscript/lang-python';
import { rustBackend } from '@vizscript/lang-rust';
import { typescriptBackend } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import { containerEntries } from '../src/components/graph-canvas/container-entries';
import { elementEntries } from '../src/components/graph-canvas/make-entries';

function output(type: string, typeText?: string): Pin {
  return {
    id: 'out',
    name: '',
    direction: 'out',
    kind: 'data',
    type,
    ...(typeText ? { typeText } : {}),
  };
}

/** `Label: code` of the entries offered from an output of `pin`'s type. */
function offered(
  types: TypeSystemInfo | undefined,
  pin: Pin,
  entries = containerEntries
): string[] {
  const ops: GraphOp[] = [];
  return entries(types, pin, { node: 'n', pin: 'out' }, { x: 0, y: 0 }, (op) =>
    ops.push(op)
  ).map((entry) => {
    entry.action('');
    const op = ops.at(-1);
    return `${entry.label}: ${op?.type === 'useValue' ? op.expression : ''}`;
  });
}

describe('container nodes in the action menu', () => {
  it('writes Python operations the way Python does', () => {
    const entries = offered(pythonBackend.typeSystem, output('string[]'));
    expect(entries).toContain('Length: len($value)');
    expect(entries).toContain('Contains: "" in $value');
    expect(entries).toContain('Add: $value.append("")');
    expect(entries).toContain('Remove Index: $value.pop(0)');
  });

  it('writes references where Rust takes them', () => {
    const entries = offered(
      rustBackend.typeSystem,
      output('Map<number, string>')
    );
    expect(entries).toContain('Contains: $value.contains_key(&0)');
    expect(entries).toContain('Find: $value.get(&0)');
  });

  it("offers TypeScript's Map methods on a Map, an index on a Record", () => {
    const types = typescriptBackend.typeSystem;
    const map = output('Map<string, number>', 'Map<string, number>');
    const record = output('Map<string, number>', 'Record<string, number>');
    expect(offered(types, map)).toContain("Find: $value.get('')");
    expect(offered(types, record)).not.toContain("Find: $value.get('')");
    expect(offered(types, record, elementEntries)).toEqual([
      "Find: $value['']",
    ]);
    expect(offered(types, map, elementEntries)).toEqual([]);
  });

  it('prefers a FIND of the language over an index', () => {
    expect(
      offered(
        pythonBackend.typeSystem,
        output('Map<string, number>'),
        elementEntries
      )
    ).toEqual([]);
  });
});
