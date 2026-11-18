import type { GraphNode } from '@vizscript/core';
import { compactTitle, isContainerNode } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseRustDocument } from '../src';

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
    const doc = parseRustDocument(
      `use std::collections::HashMap;
fn f(mut items: Vec<String>, m: HashMap<String, i32>) {
    items.push(String::new());
    let n = items.len();
    let has = m.contains_key("a");
}
`,
      't.rs'
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
    ]);
  });

  it('draws set operators on references as UNION, INTERSECTION, DIFFERENCE', () => {
    const doc = parseRustDocument(
      `use std::collections::HashSet;
fn f(a: HashSet<u32>, b: HashSet<u32>) {
    let all = &a | &b;
    let both = &a & &b;
    let only = &a - &b;
    let lazy = a.union(&b);
}
`,
      't.rs'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual([
      'UNION (Set<number>, Set<number>) -> Set<number>',
      'INTERSECTION (Set<number>, Set<number>) -> Set<number>',
      'DIFFERENCE (Set<number>, Set<number>) -> Set<number>',
    ]);
  });

  it('draws `items.len() - 1` as LAST INDEX', () => {
    const doc = parseRustDocument(
      'fn f(items: Vec<u32>) -> usize {\n    items.len() - 1usize\n}\n',
      't.rs'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual(['LAST INDEX (number[]) -> number']);
  });
});
