import type { GraphDocument, GraphOp } from '@vizscript/core';
import { applyTextEdits, summarizeGraph } from '@vizscript/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPythonOp,
  dataTypeOf,
  parsePython,
  parsePythonDocument,
} from '../src';

const shop = readFileSync(
  join(import.meta.dirname, 'fixtures', 'shop.py'),
  'utf8'
);

function apply(text: string, op: GraphOp): string {
  const result = applyPythonOp(text, op, 'test.py');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function fn(doc: GraphDocument, name: string) {
  const found = doc.functions.find((f) => f.name === name);
  if (!found) {
    throw new Error(`no function ${name}`);
  }

  return found;
}

describe('parsePython', () => {
  it('parses the fixture without diagnostics', () => {
    const { body, diagnostics } = parsePython(shop);
    expect(diagnostics).toEqual([]);
    expect(body.map((s) => s.type)).toEqual([
      'Expr',
      'Import',
      'Import',
      'Assign',
      'ClassDef',
      'FunctionDef',
      'FunctionDef',
      'If',
    ]);
  });

  it('accepts valid syntax the Lezer grammar does not know', () => {
    const text = [
      'def f(lib):',
      '    with lib.load() as (src, dst):',
      '        dst.items = [a for a, *_rest in src]',
      '    yield',
      '',
    ].join('\n');
    const { body, diagnostics } = parsePython(text);
    expect(diagnostics).toEqual([]);
    expect(body[0]).toMatchObject({
      type: 'FunctionDef',
      body: { body: [{ type: 'With' }, { type: 'Yield' }] },
    });
  });

  it('reports real syntax errors', () => {
    expect(
      parsePython('def f(:\n    pass\n').diagnostics.length
    ).toBeGreaterThan(0);
  });
});

describe('parsePythonDocument', () => {
  it('lowers the fixture', () => {
    expect(
      summarizeGraph(parsePythonDocument(shop, 'shop.py'))
    ).toMatchSnapshot();
  });

  it('maps type hints to pin types', () => {
    expect(dataTypeOf('int')).toBe('number');
    expect(dataTypeOf('str | None')).toBe('string');
    expect(dataTypeOf('Optional[float]')).toBe('number');
    expect(dataTypeOf('list[Item]')).toBe('Item[]');
    expect(dataTypeOf('tuple[int, ...]')).toBe('number[]');
    expect(dataTypeOf('tuple[int, str]')).toBe('array');
    expect(dataTypeOf('dict[str, int]')).toBe('object');
    expect(dataTypeOf('Item')).toBe('Item');
  });

  it('wires parameters, loop variables and exception names', () => {
    const doc = parsePythonDocument(shop, 'shop.py');
    const checkout = fn(doc, 'checkout');
    const entry = checkout.nodes[0];
    expect(entry?.subtitle).toBe('async def');
    expect(entry?.pins.find((p) => p.name === 'items')?.type).toBe('Item[]');
    const tryNode = checkout.nodes.find((n) => n.kind === 'try');
    expect(
      tryNode?.pins.some((p) => p.name.startsWith('Except (ConnectionError'))
    ).toBe(true);
    expect(fn(doc, 'Item').nodes[0]?.subtitle).toBe('class @dataclass');
    expect(fn(doc, 'Item.total').nodes[0]?.pins[1]?.type).toBe('Item');
  });
});

describe('applyPythonOp', () => {
  it('edits strings keeping prefix and quotes', () => {
    const text = 'name = r"C:\\temp"\nprint(\'hi\')\n';
    const doc = parsePythonDocument(text);
    const print = fn(doc, 'Module').nodes.find((n) => n.title === 'print');
    const pin = print?.pins.find((p) => p.literal);
    expect(
      apply(text, {
        type: 'setLiteral',
        node: print?.id ?? '',
        pin: pin?.id ?? '',
        value: "it's",
      })
    ).toBe("name = r\"C:\\temp\"\nprint('it\\'s')\n");
  });

  it('replaces the only statement of a block with pass', () => {
    const text = 'def f():\n    if x:\n        foo()\n    bar()\n';
    const doc = parsePythonDocument(text);
    const foo = fn(doc, 'f').nodes.find((n) => n.title === 'foo');
    expect(apply(text, { type: 'deleteNodes', nodeIds: [foo?.id ?? ''] })).toBe(
      'def f():\n    if x:\n        pass\n    bar()\n'
    );
  });

  it('adds statements with the file indentation', () => {
    const text = 'def f():\n    foo()\n';
    const doc = parsePythonDocument(text);
    const foo = fn(doc, 'f').nodes.find((n) => n.title === 'foo');
    expect(
      apply(text, {
        type: 'addNode',
        template: { type: 'branch' },
        after: { node: foo?.id ?? '', pin: 'then' },
      })
    ).toBe('def f():\n    foo()\n    if True:\n        pass\n');
    expect(
      apply('x = 1\n', {
        type: 'addNode',
        template: { type: 'call', callee: 'main' },
      })
    ).toBe('x = 1\nmain()\n');
  });

  it('binds call results to snake_case variables when wiring them', () => {
    const text = 'def f():\n    getTarget()\n    aim()\n    shoot(None)\n';
    const doc = parsePythonDocument(text);
    const nodes = fn(doc, 'f').nodes;
    const get = nodes.find((n) => n.title === 'getTarget');
    const shoot = nodes.find((n) => n.title === 'shoot');
    expect(
      apply(text, {
        type: 'connect',
        from: { node: get?.id ?? '', pin: 'return' },
        to: { node: shoot?.id ?? '', pin: 'arg0' },
      })
    ).toBe(
      'def f():\n    get_target_result = getTarget()\n    aim()\n    shoot(get_target_result)\n'
    );
  });

  it('keeps the call when deleting only its return', () => {
    const text = 'def f():\n    return load(path)\n';
    const doc = parsePythonDocument(text);
    const ret = fn(doc, 'f').nodes.find((n) => n.kind === 'return');
    expect(apply(text, { type: 'deleteNodes', nodeIds: [ret?.id ?? ''] })).toBe(
      'def f():\n    load(path)\n'
    );
  });

  it('writes Python booleans', () => {
    const text = 'path.mkdir(exist_ok=True)\n';
    const doc = parsePythonDocument(text);
    const mkdir = fn(doc, 'Module').nodes.find((n) => n.title === 'path.mkdir');
    expect(
      apply(text, {
        type: 'setLiteral',
        node: mkdir?.id ?? '',
        pin: 'arg0',
        value: 'false',
      })
    ).toBe('path.mkdir(exist_ok=False)\n');
  });

  it('handles actions of wires dropped on empty space', () => {
    const text = 'def f(xs):\n    total = sum(xs)\n    show(total + 1)\n';
    const doc = parsePythonDocument(text);
    const nodes = fn(doc, 'f').nodes;
    const sum = nodes.find((n) => n.title === 'sum');
    const show = nodes.find((n) => n.title === 'show');
    const plus = nodes.find((n) => n.title === '+');
    const setTotal = nodes.find((n) => n.title === 'Set total');

    // Data output → call a function with the value.
    expect(
      apply(text, {
        type: 'callWith',
        pin: { node: setTotal?.id ?? '', pin: 'out' },
        callee: 'print',
      })
    ).toBe(
      'def f(xs):\n    total = sum(xs)\n    print(total)\n    show(total + 1)\n'
    );

    // Pure output → store in a variable before its statement.
    expect(
      apply(text, {
        type: 'promote',
        pin: { node: plus?.id ?? '', pin: 'value' },
        name: 'shown',
      })
    ).toBe(
      'def f(xs):\n    total = sum(xs)\n    shown = total + 1\n    show(shown)\n'
    );

    // Data input → new expression.
    expect(
      apply(text, {
        type: 'setInput',
        pin: { node: sum?.id ?? '', pin: 'arg0' },
        expression: 'range(10)',
      })
    ).toBe('def f(xs):\n    total = sum(range(10))\n    show(total + 1)\n');

    // Exec input → statement before.
    expect(
      apply(text, {
        type: 'addNode',
        template: { type: 'call', callee: 'log' },
        before: { node: show?.id ?? '', pin: 'exec' },
      })
    ).toBe('def f(xs):\n    total = sum(xs)\n    log()\n    show(total + 1)\n');
  });

  it('disconnects inputs with None and keeps the value node', () => {
    const text = 'print(total)\n';
    const doc = parsePythonDocument(text);
    const print = fn(doc, 'Module').nodes.find((n) => n.title === 'print');
    expect(
      apply(text, {
        type: 'disconnect',
        pin: { node: print?.id ?? '', pin: 'arg0' },
      })
    ).toBe('total\nprint(None)\n');
  });

  it('shows an unused value as unconnected nodes', () => {
    const doc = parsePythonDocument('def f(a):\n    a + 1\n    return\n');
    const nodes = fn(doc, 'f').nodes;
    expect(nodes.map((n) => n.kind)).toEqual(['entry', 'operator', 'return']);
  });

  it('adds a node after a call inside a return by storing its result', () => {
    const text = 'def f(path):\n    return load(path)\n';
    const doc = parsePythonDocument(text);
    const call = fn(doc, 'f').nodes.find((n) => n.title === 'load');
    expect(
      apply(text, {
        type: 'addNode',
        template: { type: 'call', callee: 'print' },
        after: { node: call?.id ?? '', pin: 'then' },
      })
    ).toBe(
      'def f(path):\n    load_result = load(path)\n    print()\n    return load_result\n'
    );
  });
});
