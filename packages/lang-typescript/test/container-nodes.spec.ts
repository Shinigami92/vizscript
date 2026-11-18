import type { GraphNode, GraphOp, TypeInfo } from '@vizscript/core';
import {
  applyTextEdits,
  compactTitle,
  isContainerNode,
  rangeKey,
  searchNodes,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

/** A container node: its word, exec pins, input and output types. */
function describeNode(node: GraphNode): string {
  const types = (direction: string): string =>
    node.pins
      .filter((p) => p.direction === direction && p.kind === 'data')
      .map((p) => p.type)
      .join(', ');
  const exec = node.pins.some((p) => p.kind === 'exec') ? ' [exec]' : '';
  const out = types('out');
  return `${compactTitle(node)}${exec} (${types('in')})${out ? ` -> ${out}` : ''}`;
}

describe('container operations (UE container nodes)', () => {
  it('draws known operations on typed containers as UE nodes', () => {
    const doc = parseTypeScript(
      `function f(items: string[], m: Map<string, number>, s: Set<string>) {
  items.push('x');
  const n = items.length;
  const has = m.has('a');
  const v = m.get('a');
  s.add('y');
}
`,
      't.ts'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual([
      'ADD [exec] (string[], string) -> number',
      'LENGTH (string[]) -> number',
      'HAS (Map<string, number>, string) -> bool',
      'FIND (Map<string, number>, string) -> number, bool',
      'ADD [exec] (Set<string>, string) -> Set<string>',
    ]);
  });

  it('reads strings, removals by index and set operations too', () => {
    const doc = parseTypeScript(
      'function f(name: string, items: string[], a: Set<string>, b: Set<string>) {\n  const n = name.length;\n  items.splice(0, 1);\n  const u = a.union(b);\n}\n',
      't.ts'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual([
      'LENGTH (string) -> number',
      'REMOVE INDEX [exec] (string[], number, number) -> string[]',
      'UNION (Set<string>, Set<string>) -> Set<string>',
    ]);
  });

  it('draws `items.length - 1` as LAST INDEX', () => {
    const doc = parseTypeScript(
      'function f(items: string[]) {\n  return items.length - 1;\n}\n',
      't.ts'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual(['LAST INDEX (string[]) -> number']);
  });

  it('writes whether a Map has the key where FIND’s found is wired', () => {
    const text =
      "function f(m: Map<string, number>) {\n  const v = m.get('a');\n  show(v);\n}\n";
    const nodes = parseTypeScript(text, 't.ts').functions.flatMap(
      (f) => f.nodes
    );
    const finds = nodes.filter((n) => compactTitle(n) === 'FIND');
    const call = nodes.find((n) => n.title === 'show');
    const wired = finds.map((find) => {
      const result = applyTypeScriptOp(
        text,
        {
          type: 'connect',
          from: { node: find.id, pin: 'found' },
          to: { node: call?.id ?? '', pin: 'arg0' },
        },
        't.ts'
      );
      return result.ok
        ? applyTextEdits(text, result.edits)
            .split('\n')
            .find((l) => l.includes('show('))
            ?.trim()
        : result.error;
    });
    expect(wired).toEqual(["show(m.has('a'));"]);
  });

  it('makes container nodes of values only the checker types', () => {
    const text =
      "async function f() {\n  const items = await load();\n  const has = items.includes('a');\n  items.push('b');\n  const n = items.length;\n}\n";
    const plain = parseTypeScript(text, 't.ts');
    // The checker's answer for the reads of `items`.
    const types = new Map<string, TypeInfo>();
    for (const node of plain.functions.flatMap((f) => f.nodes)) {
      const out = node.pins.find((p) => p.direction === 'out' && p.range);
      if (node.kind === 'getVar' && node.title === 'items' && out?.range) {
        types.set(rangeKey(out.range), {
          text: 'string[]',
          dataType: 'string[]',
        });
      }
    }

    const fn = parseTypeScript(text, 't.ts', {
      checked: { text, types },
    }).functions.find((f) => f.name === 'f');
    expect(
      fn?.nodes.filter((n) => isContainerNode(n)).map(describeNode)
    ).toEqual([
      'INCLUDES (string[], string) -> bool',
      'ADD [exec] (string[], string) -> number',
      'LENGTH (string[]) -> number',
    ]);
    // INCLUDES left the exec chain: `const items` runs on into `const has`.
    const titles = (id: string): string =>
      fn?.nodes.find((n) => n.id === id)?.title ?? id;
    expect(
      fn?.edges
        .filter((e) => e.kind === 'exec')
        .map((e) => `${titles(e.from.node)} -> ${titles(e.to.node)}`)
    ).toEqual(expect.arrayContaining(['Set items -> Set has']));
    expect(
      fn?.edges.some(
        (e) =>
          e.kind === 'exec' &&
          [e.from.node, e.to.node].includes(
            fn.nodes.find((n) => compactTitle(n) === 'INCLUDES')?.id ?? ''
          )
      )
    ).toBe(false);
  });

  it('draws an element write as Set Array Elem, a Record’s as ADD', () => {
    const text =
      "function f(items: string[], r: Record<string, number>, n: number) {\n  items[3] = 'date';\n  r['apple'] = 2;\n}\n";
    const nodes = parseTypeScript(text, 't.ts').functions.flatMap(
      (fn) => fn.nodes
    );
    const writes = nodes.filter((n) => n.kind === 'setElement');
    expect(writes.map(describeNode)).toEqual([
      'Set Array Elem [exec] (string[], number, string)',
      'ADD [exec] (Map<string, number>, string, number)',
    ]);
    const [set] = writes;
    const entry = nodes.find((n) => n.kind === 'entry' && n.title === 'f');
    const apply = (op: GraphOp): string => {
      const result = applyTypeScriptOp(text, op, 't.ts');
      return result.ok ? applyTextEdits(text, result.edits) : result.error;
    };
    expect(
      apply({
        type: 'setLiteral',
        node: set?.id ?? '',
        pin: 'index',
        value: '5',
      })
    ).toContain("  items[5] = 'date';\n");
    expect(
      apply({
        type: 'connect',
        from: {
          node: entry?.id ?? '',
          pin: entry?.pins.find((p) => p.name === 'n')?.id ?? '',
        },
        to: { node: set?.id ?? '', pin: 'index' },
      })
    ).toContain("  items[n] = 'date';\n");
    expect(
      apply({ type: 'deleteNodes', nodeIds: [set?.id ?? ''] })
    ).not.toContain('items[');
  });

  it('shows TypeScript’s own words: INCLUDES, HAS; search finds CONTAINS too', () => {
    const doc = parseTypeScript(
      "function f(items: string[], seen: Set<string>) {\n  const a = items.includes('x');\n  const b = seen.has('y');\n}\n",
      't.ts'
    );
    const nodes = doc.functions.flatMap((fn) => fn.nodes);
    expect(nodes.filter((n) => isContainerNode(n)).map(compactTitle)).toEqual([
      'INCLUDES',
      'HAS',
    ]);
    expect(searchNodes(doc, 'contains').map((m) => m.text)).toEqual([
      'CONTAINS',
      'CONTAINS',
    ]);
    // By the method's own name, its title.
    expect(searchNodes(doc, 'includes').map((m) => m.text)).toEqual([
      'includes',
    ]);
  });
});
