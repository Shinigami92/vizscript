import { describe, expect, it } from 'vitest';
import type { ContainerOp } from '../src';
import {
  compactTitle,
  markContainerCandidate,
  restyleContainerNodes,
} from '../src';
import type { FunctionGraph, GraphEdge, GraphNode, Pin } from '../src/ir';

const OPS: ReadonlyArray<ContainerOp> = [
  {
    word: 'LENGTH',
    on: ['array'],
    form: 'function',
    name: 'len',
    result: 'number',
  },
  {
    word: 'ADD',
    on: ['array'],
    form: 'method',
    name: 'append',
    args: ['element'],
    mutates: true,
  },
  {
    word: 'CONTAINS',
    on: ['array'],
    form: 'operator',
    name: 'in',
    containerLast: true,
    args: ['element'],
    result: 'bool',
  },
];

function execPin(id: string, direction: Pin['direction']): Pin {
  return { id, name: '', direction, kind: 'exec', type: 'any' };
}

function dataPin(id: string, direction: Pin['direction'], type = 'any'): Pin {
  // Inputs have code (styled container nodes keep only those).
  return {
    id,
    name: '',
    direction,
    kind: 'data',
    type,
    ...(direction === 'in' ? { range: { start: 0, end: 1 } } : {}),
  };
}

function node(
  id: string,
  pins: Pin[],
  extra: Partial<GraphNode> = {}
): GraphNode {
  return {
    id,
    kind: 'call',
    category: 'function',
    purity: 'impure',
    title: id,
    range: { start: 0, end: 0 },
    path: id,
    pins,
    ...extra,
  };
}

function wire(kind: GraphEdge['kind'], from: string, to: string): GraphEdge {
  const [fromNode = '', fromPin = ''] = from.split('.');
  const [toNode = '', toPin = ''] = to.split('.');
  return {
    id: `${from}-${to}`,
    kind,
    from: { node: fromNode, pin: fromPin },
    to: { node: toNode, pin: toPin },
  };
}

/**
 * `names` (a list, typed now) into `len(names)` between two statements,
 * `names.append(x)` and `"a" in names`, all lowered untyped.
 */
function graph(): FunctionGraph {
  const names = node('names', [dataPin('value', 'out', 'string[]')], {
    kind: 'getVar',
    purity: 'pure',
    category: 'variable',
  });
  const before = node('before', [
    execPin('exec', 'in'),
    execPin('then', 'out'),
  ]);
  const len = node('len', [
    execPin('exec', 'in'),
    execPin('then', 'out'),
    dataPin('arg0', 'in'),
    dataPin('return', 'out'),
  ]);
  const after = node('after', [execPin('exec', 'in'), execPin('then', 'out')]);
  const append = node('append', [
    execPin('exec', 'in'),
    execPin('then', 'out'),
    dataPin('target', 'in'),
    dataPin('arg0', 'in'),
  ]);
  const has = node(
    'in',
    [dataPin('a', 'in', 'string'), dataPin('b', 'in'), dataPin('value', 'out')],
    { kind: 'operator', purity: 'pure', category: 'pure' }
  );
  markContainerCandidate(len, {
    form: 'function',
    name: 'len',
    args: 0,
    pin: 'arg0',
    statement: false,
    code: 'len(names)',
  });
  markContainerCandidate(append, {
    form: 'method',
    name: 'append',
    args: 1,
    pin: 'target',
    statement: true,
    code: 'names.append(x)',
  });
  markContainerCandidate(has, {
    form: 'operator',
    name: 'in',
    args: 1,
    pin: 'a',
    statement: false,
    code: '"a" in names',
  });
  return {
    id: 'f',
    name: 'f',
    range: { start: 0, end: 0 },
    nodes: [names, before, len, after, append, has],
    edges: [
      wire('exec', 'before.then', 'len.exec'),
      wire('exec', 'len.then', 'after.exec'),
      wire('exec', 'after.then', 'append.exec'),
      wire('data', 'names.value', 'len.arg0'),
      wire('data', 'names.value', 'append.target'),
      wire('data', 'names.value', 'in.b'),
    ],
  };
}

describe('restyleContainerNodes', () => {
  it('makes a typed read a pure container node off the exec chain', () => {
    const fn = restyleContainerNodes(graph(), OPS);
    const len = fn.nodes.find((n) => n.id === 'len');
    expect(len && compactTitle(len)).toBe('LENGTH');
    expect(len?.purity).toBe('pure');
    expect(len?.pins.some((p) => p.kind === 'exec')).toBe(false);
    expect(len?.pins.find((p) => p.id === 'arg0')?.type).toBe('string[]');
    expect(len?.pins.find((p) => p.id === 'return')?.meta).toMatchObject({
      sourceText: 'len(names)',
    });
    expect(
      fn.edges
        .filter((e) => e.kind === 'exec')
        .map((e) => `${e.from.node} -> ${e.to.node}`)
        .toSorted()
    ).toEqual(['after -> append', 'before -> after']);
  });

  it('keeps a change of the container on the exec chain', () => {
    const append = restyleContainerNodes(graph(), OPS).nodes.find(
      (n) => n.id === 'append'
    );
    expect(append && compactTitle(append)).toBe('ADD');
    expect(append?.purity).toBe('impure');
  });

  it('finds the container of an operator by its operands', () => {
    const has = restyleContainerNodes(graph(), OPS).nodes.find(
      (n) => n.id === 'in'
    );
    expect(has && compactTitle(has)).toBe('CONTAINS');
    expect(
      has?.pins.filter((p) => p.direction === 'in').map((p) => p.id)
    ).toEqual(['b', 'a']);
  });

  it('leaves untyped candidates and their function as they are', () => {
    const untyped = graph();
    const names = untyped.nodes[0];
    if (names) {
      names.pins = [dataPin('value', 'out', 'any')];
    }

    expect(restyleContainerNodes(untyped, OPS)).toBe(untyped);
  });
});
