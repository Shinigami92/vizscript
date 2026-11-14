import type { GraphDocument, GraphNode, GraphOp } from '@vizscript/core';
import {
  applyTextEdits,
  calleeText,
  reconcilePositions,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 'test.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function node(
  doc: GraphDocument,
  predicate: (n: GraphNode) => boolean
): GraphNode {
  const found = doc.functions.flatMap((f) => f.nodes).find(predicate);
  if (!found) {
    throw new Error('node not found');
  }

  return found;
}

const source = `function greeter(person: string): string {
  return "Hello, " + person;
}

const user: string = "Jane User";
console.log(greeter(user));
foo(1);
`;

describe('applyTypeScriptOp', () => {
  it('edits string literals preserving the quote style', () => {
    const doc = parseTypeScript(source);
    const op = node(doc, (n) => n.kind === 'operator');
    const result = apply(source, {
      type: 'setLiteral',
      node: op.id,
      pin: 'a',
      value: 'Hi "you", ',
    });
    expect(result).toContain('return "Hi \\"you\\", " + person;');
  });

  it('rejects invalid numbers', () => {
    const doc = parseTypeScript(source);
    const call = node(doc, (n) => n.title === 'foo');
    const result = applyTypeScriptOp(source, {
      type: 'setLiteral',
      node: call.id,
      pin: 'arg0',
      value: 'abc',
    });
    expect(result.ok).toBe(false);
  });

  it('deletes statements including their line', () => {
    const doc = parseTypeScript(source);
    const call = node(doc, (n) => n.title === 'foo');
    const result = apply(source, { type: 'deleteNodes', nodeIds: [call.id] });
    expect(result).not.toContain('foo(1)');
    expect(result.endsWith('console.log(greeter(user));\n')).toBe(true);
  });

  it('replaces deleted pure nodes with undefined', () => {
    const doc = parseTypeScript(source);
    const op = node(doc, (n) => n.kind === 'operator');
    const result = apply(source, { type: 'deleteNodes', nodeIds: [op.id] });
    expect(result).toContain('return undefined;');
  });

  it('reorders statements when rewiring exec pins', () => {
    const doc = parseTypeScript(source);
    const entry = node(doc, (n) => n.kind === 'entry' && n.title === 'Module');
    const call = node(doc, (n) => n.title === 'foo');
    const result = apply(source, {
      type: 'connect',
      from: { node: entry.id, pin: 'then' },
      to: { node: call.id, pin: 'exec' },
    });
    expect(result.indexOf('foo(1)')).toBeLessThan(result.indexOf('const user'));
    expect(parseTypeScript(result).diagnostics).toEqual([]);
  });

  it('wires variables into inputs', () => {
    const doc = parseTypeScript(source);
    const setUser = node(doc, (n) => n.title === 'Set user');
    const call = node(doc, (n) => n.title === 'foo');
    const result = apply(source, {
      type: 'connect',
      from: { node: setUser.id, pin: 'out' },
      to: { node: call.id, pin: 'arg0' },
    });
    expect(result).toContain('foo(user);');
  });

  it('moves a call into the statement right after it when wiring it', () => {
    const doc = parseTypeScript(source);
    const log = node(doc, (n) => n.title === 'log');
    const call = node(doc, (n) => n.title === 'foo');
    const result = apply(source, {
      type: 'connect',
      from: { node: log.id, pin: 'return' },
      to: { node: call.id, pin: 'arg0' },
    });
    expect(result).toContain('\nfoo(console.log(greeter(user)));\n');
    expect(result).not.toContain('\nconsole.log(greeter(user));');
  });

  it('binds call results to a variable when wiring them further away', () => {
    const text = 'console.log(1);\nbar();\nfoo(2);\n';
    const doc = parseTypeScript(text);
    const log = node(doc, (n) => n.title === 'log');
    const call = node(doc, (n) => n.title === 'foo');
    const result = apply(text, {
      type: 'connect',
      from: { node: log.id, pin: 'return' },
      to: { node: call.id, pin: 'arg0' },
    });
    expect(result).toBe(
      'const logResult = console.log(1);\nbar();\nfoo(logResult);\n'
    );
  });

  it('rejects wiring values that are not available yet', () => {
    const doc = parseTypeScript(source);
    const setUser = node(doc, (n) => n.title === 'Set user');
    const log = node(doc, (n) => n.title === 'log');
    const call = node(doc, (n) => n.title === 'foo');
    const result = applyTypeScriptOp(source, {
      type: 'connect',
      from: { node: call.id, pin: 'return' },
      to: { node: setUser.id, pin: 'value' },
    });
    expect(result.ok).toBe(false);
    expect(log).toBeDefined();
  });

  it('disconnects data inputs', () => {
    const doc = parseTypeScript(source);
    const log = node(doc, (n) => n.title === 'log');
    const result = apply(source, {
      type: 'disconnect',
      pin: { node: log.id, pin: 'arg0' },
    });
    expect(result).toContain('console.log(undefined);');
  });

  it('adds nodes after an exec pin', () => {
    const doc = parseTypeScript(source);
    const greeter = node(
      doc,
      (n) => n.kind === 'entry' && n.title === 'greeter'
    );
    const result = apply(source, {
      type: 'addNode',
      template: { type: 'call', callee: 'console.debug' },
      after: { node: greeter.id, pin: 'then' },
    });
    expect(result).toContain(
      'function greeter(person: string): string {\n  console.debug();\n  return'
    );
  });
});

describe('module entry', () => {
  it('moves statements before the first executable statement', () => {
    const doc = parseTypeScript(source);
    const entry = node(doc, (n) => n.kind === 'entry' && n.title === 'Module');
    const log = node(doc, (n) => n.title === 'log');
    const result = apply(source, {
      type: 'connect',
      from: { node: entry.id, pin: 'then' },
      to: { node: log.id, pin: 'exec' },
    });
    expect(result).toBe(`function greeter(person: string): string {
  return "Hello, " + person;
}

console.log(greeter(user));
const user: string = "Jane User";
foo(1);
`);
  });
});

describe('wire dropped on empty space', () => {
  const text = 'const total = sum(xs);\nshow(total + 1);\n';

  it('calls a function with an impure result (binding it first)', () => {
    const doc = parseTypeScript(text);
    const sum = node(doc, (n) => n.title === 'sum');
    expect(
      apply(text, {
        type: 'callWith',
        pin: { node: sum.id, pin: 'return' },
        callee: 'console.log',
      })
    ).toBe(
      'const sumResult = sum(xs);\nconst total = sumResult;\nconsole.log(sumResult);\nshow(total + 1);\n'
    );
  });

  it('stores a call result statement in a variable', () => {
    const doc = parseTypeScript('fetchAll();\n');
    const call = node(doc, (n) => n.title === 'fetchAll');
    expect(
      apply('fetchAll();\n', {
        type: 'promote',
        pin: { node: call.id, pin: 'return' },
        name: 'items',
      })
    ).toBe('const items = fetchAll();\n');
  });

  it('extracts an input of a nested pure expression', () => {
    const doc = parseTypeScript(text);
    const plus = node(doc, (n) => n.title === '+');
    expect(
      apply(text, {
        type: 'extract',
        pin: { node: plus.id, pin: 'b' },
        name: 'step',
      })
    ).toBe('const total = sum(xs);\nconst step = 1;\nshow(total + step);\n');
  });

  it('rejects storing a value that already has a name', () => {
    const doc = parseTypeScript(text);
    const total = node(doc, (n) => n.title === 'Set total');
    const result = applyTypeScriptOp(text, {
      type: 'promote',
      pin: { node: total.id, pin: 'out' },
      name: 'x',
    });
    expect(result.ok).toBe(false);
  });
});

describe('deleting and restoring a return', () => {
  const sha = `export function sha(core: Core): string {
  const { length = 40 } = options;
  return hex(core, {
    length,
    casing: 'lower',
  });
}
`;

  it('keeps the call when only the return is deleted', () => {
    const doc = parseTypeScript(sha);
    const ret = node(doc, (n) => n.kind === 'return');
    const deleted = apply(sha, { type: 'deleteNodes', nodeIds: [ret.id] });
    expect(deleted).toBe(`export function sha(core: Core): string {
  const { length = 40 } = options;
  hex(core, {
    length,
    casing: 'lower',
  });
}
`);

    // Add a Return after the call, then wire the call's result into it.
    const doc2 = parseTypeScript(deleted);
    const call = node(doc2, (n) => n.title === 'hex');
    const withReturn = apply(deleted, {
      type: 'addNode',
      template: { type: 'return' },
      after: { node: call.id, pin: 'then' },
    });
    expect(withReturn).toContain('  });\n  return;\n}');

    const doc3 = parseTypeScript(withReturn);
    const call3 = node(doc3, (n) => n.title === 'hex');
    const ret3 = node(doc3, (n) => n.kind === 'return');
    const out = call3.pins.find(
      (p) => p.kind === 'data' && p.direction === 'out'
    );
    const restored = apply(withReturn, {
      type: 'connect',
      from: { node: call3.id, pin: out?.id ?? '' },
      to: { node: ret3.id, pin: 'value' },
    });
    expect(restored).toBe(sha);
  });

  it('keeps the call when the return input is disconnected', () => {
    const doc = parseTypeScript(sha);
    const ret = node(doc, (n) => n.kind === 'return');
    expect(
      apply(sha, { type: 'disconnect', pin: { node: ret.id, pin: 'value' } })
    ).toBe(`export function sha(core: Core): string {
  const { length = 40 } = options;
  hex(core, {
    length,
    casing: 'lower',
  });
  return;
}
`);
  });

  it('breaks every data wire of a node', () => {
    const text = 'const total = price * count;\nlog(total, price);\n';
    const doc = parseTypeScript(text);
    const times = node(doc, (n) => n.kind === 'operator');
    // Its value stays as a statement, with its own inputs cleared.
    expect(apply(text, { type: 'disconnectNode', node: times.id })).toBe(
      'price;\ncount;\nundefined * undefined;\nconst total = undefined;\nlog(total, price);\n'
    );
    const log = node(doc, (n) => n.title === 'log');
    expect(apply(text, { type: 'disconnectNode', node: log.id })).toBe(
      'const total = price * count;\ntotal;\nprice;\nlog(undefined, undefined);\n'
    );
  });

  it('replaces the variable of a Get or Set and the function of a call', () => {
    const text =
      'let a = 1;\nlet b = 2;\na = 3;\nlog(a);\nclass C {\n  x = 1;\n  m() { this.x = 2; }\n}\n';
    const doc = parseTypeScript(text);
    const replace = (n: GraphNode, name: string): string =>
      apply(text, { type: 'replaceReference', node: n.id, name });
    const get = node(doc, (n) => n.kind === 'getVar' && n.title === 'a');
    expect(replace(get, 'b')).toContain('log(b);');
    const set = node(
      doc,
      (n) => n.kind === 'setVar' && n.title === 'Set a' && n.range.start > 20
    );
    expect(replace(set, 'b')).toContain('\nb = 3;');
    const call = node(doc, (n) => n.title === 'log');
    expect(replace(call, 'console.warn')).toContain('console.warn(a);');
    const member = node(
      doc,
      (n) => n.kind === 'setVar' && n.title.endsWith('x') && n.range.start > 60
    );
    expect(replace(member, 'this.y')).toContain('this.y = 2;');
    const declaration = node(
      doc,
      (n) => n.kind === 'setVar' && n.range.start === 0
    );
    expect(
      applyTypeScriptOp(
        text,
        { type: 'replaceReference', node: declaration.id, name: 'b' },
        'test.ts'
      ).ok
    ).toBe(false);
  });

  it('replaces the method of a call on a value', () => {
    const text = 'function f(items: string[]) {\n  items.pop();\n}\n';
    const doc = parseTypeScript(text);
    const call = node(doc, (n) => n.kind === 'call' && n.title === 'pop');
    expect(calleeText(text, call)).toBe('items.pop');
    expect(
      apply(text, { type: 'replaceReference', node: call.id, name: 'shift' })
    ).toContain('  items.shift();');
  });

  it("writes an empty text default in the file's quotes", () => {
    const text = 'const a = "x";\nlet b;\n';
    const b = parseTypeScript(text).symbols?.find((s) => s.name === 'b');
    expect(
      apply(text, {
        type: 'setSymbolType',
        symbol: b?.id ?? '',
        typeText: 'string',
        defaultValue: "''",
      })
    ).toBe('const a = "x";\nlet b: string = "";\n');
  });

  it('leaves no extra blank lines when deleting several statements', () => {
    const text =
      'function f() {\n}\n\nconst a = 1;\n\nconst b = 2;\n\nlog(a, b);\n';
    const doc = parseTypeScript(text);
    const ids = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.kind !== 'entry')
      .map((n) => n.id);
    expect(apply(text, { type: 'deleteNodes', nodeIds: ids })).toBe(
      'function f() {\n}\n'
    );
    const b = node(doc, (n) => n.title === 'Set b');
    expect(apply(text, { type: 'deleteNodes', nodeIds: [b.id] })).toBe(
      'function f() {\n}\n\nconst a = 1;\n\nlog(a, b);\n'
    );
  });

  it('keeps positions with their code when equal nodes swap ids', () => {
    const text =
      'const user = "Jane";\nconst t = greeter(user);\nlog(greeter(user));\n';
    const before = parseTypeScript(text);
    const calls = before.functions[0]?.nodes.filter(
      (n) => n.title === 'greeter'
    );
    const [first, second] = calls ?? [];
    const set = node(before, (n) => n.title === 'Set t');
    const result = applyTypeScriptOp(text, {
      type: 'deleteNodes',
      nodeIds: [set.id],
    });
    if (!result.ok || !first || !second) {
      throw new Error('no edit');
    }

    const after = parseTypeScript(applyTextEdits(text, result.edits));
    const positions = reconcilePositions(
      before,
      after,
      { [first.id]: { x: 1, y: 1 }, [second.id]: { x: 2, y: 2 } },
      { edits: result.edits, before: text }
    );
    const log = node(after, (n) => n.title === 'log');
    const nested = after.functions[0]?.edges.find((e) => e.to.node === log.id)
      ?.from.node;
    // The call inside log() keeps the place of the call inside log().
    expect(positions[nested ?? '']).toEqual({ x: 2, y: 2 });
  });

  it('keeps positions with code moved to another place', () => {
    const text =
      'const user = "Jane";\nconst t = greeter(user);\nlog(greeter(user));\n';
    const before = parseTypeScript(text);
    const module = before.functions[0];
    const [first, second] =
      module?.nodes.filter((n) => n.title === 'greeter') ?? [];
    const entry = module?.nodes.find((n) => n.kind === 'entry');
    const log = node(before, (n) => n.title === 'log');
    const result = applyTypeScriptOp(text, {
      type: 'connect',
      from: { node: entry?.id ?? '', pin: 'then' },
      to: { node: log.id, pin: 'exec' },
    });
    if (!result.ok || !first || !second) {
      throw new Error('no edit');
    }

    const moved = applyTextEdits(text, result.edits);
    expect(moved.startsWith('log(greeter(user));')).toBe(true);
    const after = parseTypeScript(moved);
    const positions = reconcilePositions(
      before,
      after,
      { [first.id]: { x: 1, y: 1 }, [second.id]: { x: 2, y: 2 } },
      { edits: result.edits, before: text }
    );
    const calls = after.functions[0]?.nodes.filter(
      (n) => n.title === 'greeter'
    );
    const inLog = calls?.find((n) => n.range.start < 10);
    const inSet = calls?.find((n) => n.range.start > 10);
    expect(positions[inLog?.id ?? '']).toEqual({ x: 2, y: 2 });
    expect(positions[inSet?.id ?? '']).toEqual({ x: 1, y: 1 });
  });

  it('leaves no blank line where a moved statement was', () => {
    const text = 'log(a);\n\nconst a = 1;\n\nconst b = 2;\n';
    const doc = parseTypeScript(text);
    const log = node(doc, (n) => n.title === 'log');
    const b = node(doc, (n) => n.title === 'Set b');
    expect(
      apply(text, {
        type: 'connect',
        from: { node: b.id, pin: 'then' },
        to: { node: log.id, pin: 'exec' },
      })
    ).toBe('const a = 1;\n\nconst b = 2;\nlog(a);\n');
  });

  it('removes a comment box whose nodes are all deleted', () => {
    const text =
      'function f() {\n  // #region Box\n  a();\n  b();\n  // #endregion\n  c();\n}\n';
    const doc = parseTypeScript(text);
    const ids = doc.functions
      .flatMap((fn) => fn.nodes)
      .filter((n) => n.title === 'a' || n.title === 'b')
      .map((n) => n.id);
    expect(apply(text, { type: 'deleteNodes', nodeIds: ids })).toBe(
      'function f() {\n  c();\n}\n'
    );
  });

  it('changes the operator of an assignment', () => {
    const text = 'let total = 0;\ntotal = total + 1;\ntotal += 2;\n';
    const doc = parseTypeScript(text);
    const sets = doc.functions
      .flatMap((fn) => fn.nodes)
      .filter((n) => n.title === 'Set total');
    const [declaration, plain, compound] = sets;
    const set = (id: string, operator: string): string =>
      apply(text, { type: 'setAssignOperator', node: id, operator });
    expect(set(plain?.id ?? '', '-=')).toContain('\ntotal -= total + 1;');
    expect(set(compound?.id ?? '', '=')).toContain('\ntotal = 2;');
    expect(
      applyTypeScriptOp(text, {
        type: 'setAssignOperator',
        node: declaration?.id ?? '',
        operator: '+=',
      }).ok
    ).toBe(false);
  });

  it('keeps a call argument as its own statement when disconnected', () => {
    const text = 'foo(bar(1), 2);\n';
    const doc = parseTypeScript(text);
    const foo = node(doc, (n) => n.title === 'foo');
    expect(
      apply(text, { type: 'disconnect', pin: { node: foo.id, pin: 'arg0' } })
    ).toBe('bar(1);\nfoo(undefined, 2);\n');
  });

  it('keeps value nodes when their wire is removed and wires them back', () => {
    const text =
      'function greet(person: string): string {\n  return "Hello, " + person;\n}\n';
    const doc = parseTypeScript(text);
    const ret = node(doc, (n) => n.kind === 'return');
    const removed = apply(text, {
      type: 'disconnect',
      pin: { node: ret.id, pin: 'value' },
    });
    expect(removed).toBe(
      'function greet(person: string): string {\n  "Hello, " + person;\n  return;\n}\n'
    );

    // Shown as an unconnected "+" node (no exec node), then wired back.
    const doc2 = parseTypeScript(removed);
    const plus = node(doc2, (n) => n.kind === 'operator');
    expect(
      doc2.functions.flatMap((f) => f.nodes).some((n) => n.kind === 'unknown')
    ).toBe(false);
    const ret2 = node(doc2, (n) => n.kind === 'return');
    expect(
      apply(removed, {
        type: 'connect',
        from: { node: plus.id, pin: 'value' },
        to: { node: ret2.id, pin: 'value' },
      })
    ).toBe(text);

    // Deleting the unconnected node removes its line.
    expect(apply(removed, { type: 'deleteNodes', nodeIds: [plus.id] })).toBe(
      'function greet(person: string): string {\n  return;\n}\n'
    );
  });

  it('keeps the key of shorthand properties', () => {
    const text = 'const length = 4;\nhex({ length, casing: "lower" });\n';
    const doc = parseTypeScript(text);
    const obj = node(doc, (n) => n.kind === 'makeObject');
    const removed = apply(text, {
      type: 'disconnect',
      pin: { node: obj.id, pin: 'p0' },
    });
    expect(removed).toBe(
      'const length = 4;\nlength;\nhex({ length: undefined, casing: "lower" });\n'
    );
    const doc2 = parseTypeScript(removed);
    const obj2 = node(doc2, (n) => n.kind === 'makeObject');
    expect(obj2.pins[0]?.name).toBe('length');
    const getter = node(doc2, (n) => n.kind === 'getVar');
    expect(
      apply(removed, {
        type: 'connect',
        from: { node: getter.id, pin: 'value' },
        to: { node: obj2.id, pin: 'p0' },
      })
    ).toBe(text);
  });

  it('deletes a value node and picks the variable again', () => {
    const text =
      'const { length = 40 } = options;\nhex({ length, casing: "lower" });\n';
    const doc = parseTypeScript(text);
    const set = node(doc, (n) => n.kind === 'setVar');
    expect(set.meta?.declares).toEqual(['length']);

    const getter = node(
      doc,
      (n) => n.kind === 'getVar' && n.title === 'length'
    );
    const deleted = apply(text, { type: 'deleteNodes', nodeIds: [getter.id] });
    expect(deleted).toBe(
      'const { length = 40 } = options;\nhex({ length: undefined, casing: "lower" });\n'
    );

    const obj = node(parseTypeScript(deleted), (n) => n.kind === 'makeObject');
    expect(
      apply(deleted, {
        type: 'setInput',
        pin: { node: obj.id, pin: 'p0' },
        expression: 'length',
      })
    ).toBe(text);
  });

  it('adds a node after a call inside a return by storing its result', () => {
    const text =
      'function f(): string {\n  return hex(core, {\n    length,\n  });\n}\n';
    const doc = parseTypeScript(text);
    const call = node(doc, (n) => n.title === 'hex');
    expect(
      apply(text, {
        type: 'addNode',
        template: { type: 'call', callee: 'console.log' },
        after: { node: call.id, pin: 'then' },
      })
    ).toBe(
      'function f(): string {\n  const hexResult = hex(core, {\n    length,\n  });\n  console.log();\n  return hexResult;\n}\n'
    );
  });

  it('wraps object literals that become statements of their own', () => {
    const text = 'foo({ a: 1 });\n';
    const doc = parseTypeScript(text);
    const foo = node(doc, (n) => n.title === 'foo');
    expect(
      apply(text, { type: 'disconnect', pin: { node: foo.id, pin: 'arg0' } })
    ).toBe('({ a: 1 });\nfoo(undefined);\n');
  });

  it('keeps the call of a deleted variable declaration', () => {
    const text = 'const x = await load(url);\nuse(1);\n';
    const doc = parseTypeScript(text);
    const set = node(doc, (n) => n.kind === 'setVar');
    expect(apply(text, { type: 'deleteNodes', nodeIds: [set.id] })).toBe(
      'await load(url);\nuse(1);\n'
    );
  });

  it('still deletes calls that are deleted too', () => {
    const doc = parseTypeScript(sha);
    const ids = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.kind === 'return' || n.title === 'hex')
      .map((n) => n.id);
    expect(apply(sha, { type: 'deleteNodes', nodeIds: ids })).not.toContain(
      'hex('
    );
  });
});
