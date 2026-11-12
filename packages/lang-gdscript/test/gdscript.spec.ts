import type { GraphDocument, GraphOp } from '@vizscript/core';
import { applyTextEdits, summarizeGraph } from '@vizscript/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyGDScriptOp,
  dataTypeOf,
  parseGDScript,
  parseGDScriptDocument,
} from '../src';

const turret = readFileSync(
  join(import.meta.dirname, 'fixtures', 'turret.gd'),
  'utf8'
);

function apply(text: string, op: GraphOp): string {
  const result = applyGDScriptOp(text, op, 'test.gd');
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

describe('parseGDScript', () => {
  it('parses the fixture without diagnostics', () => {
    const { script, diagnostics } = parseGDScript(turret);
    expect(diagnostics).toEqual([]);
    expect(script.className).toBe('Turret');
    expect(script.extendsName).toBe('Node3D');
  });

  it('follows Godot operator precedence', () => {
    const { script } = parseGDScript(
      'var a = x as int + 1 if c else not d in e\n'
    );
    const decl = script.body[0];
    // (((x as int) + 1) if c else (not (d in e)))
    expect(decl).toMatchObject({
      type: 'Var',
      value: {
        type: 'Ternary',
        consequent: { type: 'Binary', op: '+', left: { type: 'Cast' } },
        alternate: { type: 'Unary', op: 'not', argument: { op: 'in' } },
      },
    });
  });

  it('handles multi-line lambdas inside calls', () => {
    const text = [
      'func _ready():',
      '\tbutton.pressed.connect(',
      '\t\tfunc(x: int) -> void:',
      '\t\t\tprint(x)',
      '\t\t\tqueue_free()',
      '\t)',
      '\tprint("after")',
      '',
    ].join('\n');
    const { script, diagnostics } = parseGDScript(text);
    expect(diagnostics).toEqual([]);
    const ready = script.body[0];
    expect(ready?.type === 'Func' && ready.body.body.length).toBe(2);
  });

  it('recovers from errors and keeps parsing', () => {
    const { script, diagnostics } = parseGDScript(
      'func a():\n\tvar = 1\n\tprint(1)\n\nfunc b():\n\tpass\n'
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(script.body.filter((s) => s.type === 'Func')).toHaveLength(2);
  });
});

describe('parseGDScriptDocument', () => {
  it('lowers the fixture', () => {
    expect(
      summarizeGraph(parseGDScriptDocument(turret, 'turret.gd'))
    ).toMatchSnapshot();
  });

  it('maps Godot types to pin types', () => {
    expect(dataTypeOf('float')).toBe('number');
    expect(dataTypeOf('StringName')).toBe('string');
    expect(dataTypeOf('Array[Node]')).toBe('Node[]');
    expect(dataTypeOf('PackedVector3Array')).toBe('Vector3[]');
    expect(dataTypeOf('Array')).toBe('array');
    expect(dataTypeOf('Dictionary[String, int]')).toBe('object');
    expect(dataTypeOf('Node3D')).toBe('Node3D');
  });

  it('marks engine callbacks as events and wires parameters', () => {
    const doc = parseGDScriptDocument(turret, 'turret.gd');
    const process = fn(doc, '_process');
    const entry = process.nodes[0];
    expect(entry?.subtitle).toBe('event');
    expect(entry?.pins.find((p) => p.name === 'delta')?.type).toBe('number');
    expect(fn(doc, 'ammo.set').nodes[0]?.subtitle).toBe('setter');
    expect(doc.functions.map((f) => f.name)).toContain('Turret');
  });
});

describe('applyGDScriptOp', () => {
  const doc = parseGDScriptDocument(turret, 'turret.gd');

  it('edits string literals keeping the quote style', () => {
    const ready = fn(doc, '_ready');
    const print = ready.nodes.find((n) => n.title === 'print');
    const operator = ready.nodes.find((n) => n.title === '%');
    const literalPin = operator?.pins.find((p) => p.literal);
    expect(print).toBeDefined();
    const next = apply(turret, {
      type: 'setLiteral',
      node: operator?.id ?? '',
      pin: literalPin?.id ?? '',
      value: 'Ready: "%d"',
    });
    expect(next).toContain(String.raw`print("Ready: \"%d\"" % ammo)`);
  });

  it('replaces the only statement of a block with pass', () => {
    const text = 'func f():\n\tif x:\n\t\tfoo()\n\tbar()\n';
    const d = parseGDScriptDocument(text);
    const foo = fn(d, 'f').nodes.find((n) => n.title === 'foo');
    expect(apply(text, { type: 'deleteNodes', nodeIds: [foo?.id ?? ''] })).toBe(
      'func f():\n\tif x:\n\t\tpass\n\tbar()\n'
    );
  });

  it('deletes statements line-aware and keeps elif branches', () => {
    const text = 'func f():\n\tfoo()\n\tbar()\n';
    const d = parseGDScriptDocument(text);
    const foo = fn(d, 'f').nodes.find((n) => n.title === 'foo');
    expect(apply(text, { type: 'deleteNodes', nodeIds: [foo?.id ?? ''] })).toBe(
      'func f():\n\tbar()\n'
    );

    const process = fn(doc, '_process');
    const elif = process.nodes.find((n) => n.subtitle === 'elif');
    const result = applyGDScriptOp(turret, {
      type: 'deleteNodes',
      nodeIds: [elif?.id ?? ''],
    });
    expect(result.ok).toBe(false);
  });

  it('adds statements after an exec pin using the file indentation', () => {
    const text = 'func f():\n\tfoo()\n';
    const d = parseGDScriptDocument(text);
    const foo = fn(d, 'f').nodes.find((n) => n.title === 'foo');
    expect(
      apply(text, {
        type: 'addNode',
        template: { type: 'branch' },
        after: { node: foo?.id ?? '', pin: 'then' },
      })
    ).toBe('func f():\n\tfoo()\n\tif true:\n\t\tpass\n');
    expect(
      apply(text, {
        type: 'addNode',
        template: { type: 'setVar', name: 'speed', declaration: 'const' },
        after: { node: fn(d, 'f').nodes[0]?.id ?? '', pin: 'then' },
      })
    ).toBe('func f():\n\tvar speed = null\n\tfoo()\n');
  });

  it('binds call results to snake_case variables when wiring them', () => {
    const text = 'func f():\n\tget_target()\n\taim()\n\tshoot(null)\n';
    const d = parseGDScriptDocument(text);
    const nodes = fn(d, 'f').nodes;
    const get = nodes.find((n) => n.title === 'get_target');
    const shoot = nodes.find((n) => n.title === 'shoot');
    expect(
      apply(text, {
        type: 'connect',
        from: { node: get?.id ?? '', pin: 'return' },
        to: { node: shoot?.id ?? '', pin: 'arg0' },
      })
    ).toBe(
      'func f():\n\tvar get_target_result = get_target()\n\taim()\n\tshoot(get_target_result)\n'
    );
  });

  it('moves a call into the next statement and back into a bare return', () => {
    const text = 'func f():\n\tget_target()\n\treturn\n';
    const d = parseGDScriptDocument(text);
    const nodes = fn(d, 'f').nodes;
    const get = nodes.find((n) => n.title === 'get_target');
    const ret = nodes.find((n) => n.kind === 'return');
    expect(
      apply(text, {
        type: 'connect',
        from: { node: get?.id ?? '', pin: 'return' },
        to: { node: ret?.id ?? '', pin: 'value' },
      })
    ).toBe('func f():\n\treturn get_target()\n');
  });

  it('extracts an input value to a variable before its statement', () => {
    const text =
      'func f(amount):\n\tset(&"parameters/move/blend_amount", amount)\n';
    const d = parseGDScriptDocument(text);
    const set = fn(d, 'f').nodes.find((n) => n.title === 'set');
    expect(
      apply(text, {
        type: 'extract',
        pin: { node: set?.id ?? '', pin: 'arg0' },
        name: 'blend_amount',
      })
    ).toBe(
      'func f(amount):\n\tvar blend_amount = &"parameters/move/blend_amount"\n\tset(blend_amount, amount)\n'
    );
  });

  it('moves statements when rewiring exec pins', () => {
    const text = 'func f():\n\ta()\n\tb()\n\tc()\n';
    const d = parseGDScriptDocument(text);
    const nodes = fn(d, 'f').nodes;
    const entry = nodes[0];
    const c = nodes.find((n) => n.title === 'c');
    expect(
      apply(text, {
        type: 'connect',
        from: { node: entry?.id ?? '', pin: 'then' },
        to: { node: c?.id ?? '', pin: 'exec' },
      })
    ).toBe('func f():\n\tc()\n\ta()\n\tb()\n');
  });
});
