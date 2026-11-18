import type { GraphNode, GraphOp } from '@vizscript/core';
import {
  applyTextEdits,
  compactTitle,
  containerPinOf,
  isContainerNode,
  searchNodes,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

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

/** The data output of a node. */
function outputOf(node: GraphNode | undefined): { node: string; pin: string } {
  return {
    node: node?.id ?? '',
    pin: node?.pins.find((p) => p.direction === 'out')?.id ?? '',
  };
}

/** The two lines of a function body after its `def`. */
function line(code: string): string {
  return code.split('\n').slice(1, 3).join('\n');
}

describe('container operations (UE container nodes)', () => {
  it('draws known operations on typed containers as UE nodes', () => {
    const doc = parsePythonDocument(
      `def f(items: list[str], d: dict[str, int], s: set[str]):
    items.append("x")
    n = len(items)
    has = "a" in d
    v = d.get("a")
    u = s | s
`,
      't.py'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual([
      'ADD [exec] (string[], string)',
      'LENGTH (string[]) -> number',
      'CONTAINS (Map<string, number>, string) -> bool',
      'FIND (Map<string, number>, string) -> number, bool',
      'UNION (Set<string>, Set<string>) -> Set<string>',
    ]);
  });

  it('reads strings, removals by index and appends too', () => {
    const doc = parsePythonDocument(
      'def f(name: str, items: list[str], more: list[str], s: set[str]):\n    n = len(name)\n    last = items.pop(0)\n    items.extend(more)\n    s.update(s)\n',
      't.py'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual([
      'LENGTH (string) -> number',
      'REMOVE INDEX [exec] (string[], number) -> string',
      'APPEND [exec] (string[], string[])',
      'ADD ITEMS [exec] (Set<string>, Set<string>)',
    ]);
  });

  it('finds container nodes by their word', () => {
    const doc = parsePythonDocument(
      'def f(items: list[str]):\n    items.append("x")\n',
      't.py'
    );
    expect(
      searchNodes(doc, 'add').map((m) => `${m.node.title} ${m.text}`)
    ).toEqual(['append ADD']);
  });

  it('draws `len(items) - 1` as LAST INDEX, other subtractions not', () => {
    const doc = parsePythonDocument(
      'def f(items: list[str], name: str):\n    a = len(items) - 1\n    b = len(items) - 2\n    c = len(name) - 1\n',
      't.py'
    );
    const nodes = doc.functions.flatMap((f) => f.nodes);
    expect(nodes.filter((n) => isContainerNode(n)).map(describeNode)).toEqual([
      'LAST INDEX (string[]) -> number',
      'LENGTH (string[]) -> number',
      'LENGTH (string) -> number',
    ]);
    expect(nodes.filter((n) => n.title === '-')).toHaveLength(2);
  });

  it('edits LAST INDEX as the whole `len(items) - 1`', () => {
    const text =
      'def f(items: list[str], more: list[str]):\n    last = len(items) - 1\n    print(more)\n';
    const nodes = parsePythonDocument(text, 't.py').functions.flatMap(
      (f) => f.nodes
    );
    const last = nodes.find((n) => compactTitle(n) === 'LAST INDEX');
    const entry = nodes.find((n) => n.kind === 'entry' && n.title === 'f');
    const print = nodes.find((n) => n.title === 'print');
    const apply = (op: GraphOp): string => {
      const result = applyPythonOp(text, op, 't.py');
      return result.ok ? applyTextEdits(text, result.edits) : result.error;
    };

    expect(last?.range).toEqual({
      start: text.indexOf('len('),
      end: text.indexOf(' - 1') + 4,
    });
    // Another list into its container pin.
    expect(
      apply({
        type: 'connect',
        from: {
          node: entry?.id ?? '',
          pin: entry?.pins.find((p) => p.name === 'more')?.id ?? '',
        },
        to: {
          node: last?.id ?? '',
          pin: containerPinOf(last as GraphNode)?.id ?? '',
        },
      })
    ).toContain('last = len(more) - 1\n');
    // Its value wired elsewhere is the whole expression.
    expect(
      apply({
        type: 'connect',
        from: {
          node: last?.id ?? '',
          pin: last?.pins.find((p) => p.direction === 'out')?.id ?? '',
        },
        to: { node: print?.id ?? '', pin: 'arg0' },
      })
    ).toContain('print(len(items) - 1)');
  });

  describe('`x not in items` as CONTAINS wired into NOT', () => {
    const text =
      'def f(x: str, y: str, items: list[str], flag: bool):\n    ok = x not in items\n    print(ok)\n';
    const nodes = parsePythonDocument(text, 't.py').functions.flatMap(
      (f) => f.nodes
    );
    const contains = nodes.find((n) => compactTitle(n) === 'CONTAINS');
    const not = nodes.find((n) => n.title === 'not');
    const entry = nodes.find((n) => n.kind === 'entry' && n.title === 'f');
    const print = nodes.find((n) => n.title === 'print');
    const param = (name: string): { node: string; pin: string } => ({
      node: entry?.id ?? '',
      pin: entry?.pins.find((p) => p.name === name)?.id ?? '',
    });
    const apply = (op: GraphOp): string => {
      const result = applyPythonOp(text, op, 't.py');
      return result.ok ? applyTextEdits(text, result.edits) : result.error;
    };

    it('draws the same nodes as `not x in items`', () => {
      expect(contains && describeNode(contains)).toBe(
        'CONTAINS (string[], string) -> bool'
      );
      expect(
        not?.pins.filter((p) => p.kind === 'data').map((p) => p.type)
      ).toEqual(['bool', 'bool']);
    });

    it('rewires the element and the container', () => {
      expect(
        line(
          apply({
            type: 'connect',
            from: param('y'),
            to: { node: contains?.id ?? '', pin: 'a' },
          })
        )
      ).toBe('    ok = y not in items\n    print(ok)');
    });

    it('writes a value wired into NOT after `not`', () => {
      expect(
        line(
          apply({
            type: 'connect',
            from: param('flag'),
            to: { node: not?.id ?? '', pin: 'a' },
          })
        )
      ).toBe('    ok = not flag\n    print(ok)');
      expect(
        line(
          apply({ type: 'disconnect', pin: { node: not?.id ?? '', pin: 'a' } })
        )
      ).toBe('    ok = not None\n    print(ok)');
    });

    it('deletes either node', () => {
      expect(
        line(apply({ type: 'deleteNodes', nodeIds: [contains?.id ?? ''] }))
      ).toBe('    ok = not None\n    print(ok)');
      expect(
        line(apply({ type: 'deleteNodes', nodeIds: [not?.id ?? ''] }))
      ).toBe('    ok = None\n    print(ok)');
    });

    it('copies `x in items` where CONTAINS is wired', () => {
      expect(
        line(
          apply({
            type: 'connect',
            from: outputOf(contains),
            to: { node: print?.id ?? '', pin: 'arg0' },
          })
        )
      ).toBe('    ok = x not in items\n    print(x in items)');
    });

    it('stores CONTAINS in a variable, NOT keeps its `not`', () => {
      const promoted = apply({
        type: 'promote',
        pin: outputOf(contains),
        name: 'found',
      });
      expect(promoted).toContain(
        '    found = x in items\n    ok = not found\n'
      );
      const extracted = apply({
        type: 'extract',
        pin: { node: not?.id ?? '', pin: 'a' },
        name: 'found',
      });
      expect(extracted).toContain(
        '    found = x in items\n    ok = not found\n'
      );
      const whole = apply({
        type: 'promote',
        pin: outputOf(not),
        name: 'missing',
      });
      expect(whole).toContain(
        '    missing = x not in items\n    ok = missing\n'
      );
    });
  });

  it('writes whether a map has the key where FIND’s found is wired', () => {
    const text =
      'def f(d: dict[str, int]):\n    v = d.get("a")\n    w = d["b"]\n    print(v)\n';
    const nodes = parsePythonDocument(text, 't.py').functions.flatMap(
      (f) => f.nodes
    );
    const finds = nodes.filter((n) => compactTitle(n) === 'FIND');
    const call = nodes.find((n) => n.title === 'print');
    const wired = finds.map((find) => {
      const result = applyPythonOp(
        text,
        {
          type: 'connect',
          from: { node: find.id, pin: 'found' },
          to: { node: call?.id ?? '', pin: 'arg0' },
        },
        't.py'
      );
      return result.ok
        ? applyTextEdits(text, result.edits)
            .split('\n')
            .find((l) => l.includes('print('))
            ?.trim()
        : result.error;
    });
    expect(wired).toEqual(['print("a" in d)', 'print("b" in d)']);
  });

  it('makes container nodes of values typed only after lowering', () => {
    // `sorted` returns a list: known from the stubs, after lowering.
    const fn = parsePythonDocument(
      'def f():\n    names = sorted(["b", "a"])\n    n = len(names)\n    has = "a" in names\n    names.append("c")\n',
      't.py'
    ).functions.find((f) => f.name === 'f');
    expect(
      fn?.nodes.filter((n) => isContainerNode(n)).map(describeNode)
    ).toEqual([
      'LENGTH (string[]) -> number',
      'CONTAINS (string[], string) -> bool',
      'ADD [exec] (string[], string)',
    ]);
    // The reads left the exec chain: `names = …` runs on into `n = …`.
    const title = (id: string): string =>
      fn?.nodes.find((n) => n.id === id)?.title ?? id;
    expect(
      fn?.edges
        .filter((e) => e.kind === 'exec')
        .map((e) => `${title(e.from.node)} -> ${title(e.to.node)}`)
    ).toContain('Set names -> Set n');
  });
});
