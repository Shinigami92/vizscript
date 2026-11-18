import type { GraphNode } from '@vizscript/core';
import { exportedSymbols, typeWildcardPins } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parsePythonDocument, pythonLibrary } from '../src';

/** The types of the values of the Format Text nodes of `nodes`. */
function formatValues(nodes: ReadonlyArray<GraphNode>): string[] {
  return nodes
    .filter((n) => n.kind === 'template')
    .flatMap((n) =>
      n.pins
        .filter((p) => p.direction === 'in' && p.id !== 'format')
        .map((p) => p.type)
    );
}

describe('types of values read from flow nodes', () => {
  it("reads an except clause's error with its class", () => {
    const fn = parsePythonDocument(
      'def f():\n    try:\n        pass\n    except TimeoutError as error:\n        print(f"failed: {error}")\n',
      't.py'
    ).functions.find((f) => f.name === 'f');
    expect(formatValues(fn?.nodes ?? [])).toEqual(['TimeoutError']);
  });

  it('types the values of a Format Text like their wires', () => {
    const fn = parsePythonDocument(
      'def f(data):\n    s = f"{data}"\n',
      't.py'
    ).functions.find((f) => f.name === 'f');
    if (!fn) {
      throw new Error('no function');
    }

    // The checker found the type of `data`.
    const wire = fn.edges.find((e) =>
      fn.nodes.some((n) => n.id === e.to.node && n.kind === 'template')
    );
    const typed = typeWildcardPins({
      ...fn,
      nodes: fn.nodes.map((n) => ({
        ...n,
        pins: n.pins.map((p) =>
          n.id === wire?.from.node && p.id === wire.from.pin
            ? { ...p, type: 'Item' }
            : p
        ),
      })),
    });
    expect(formatValues(typed.nodes)).toEqual(['Item']);
  });

  it('types the sum of unknown items', () => {
    const fn = parsePythonDocument(
      'def f(data):\n    total = sum(data)\n    return total\n',
      't.py'
    ).functions.find((f) => f.name === 'f');
    const outOf = (title: string): string | undefined =>
      fn?.nodes
        .find((n) => n.title === title)
        ?.pins.find((p) => p.direction === 'out' && p.kind === 'data')?.type;
    expect(outOf('sum')).toBe('number');
  });

  it('types the classes library functions return', () => {
    const stub = pythonLibrary('urllib.request');
    const members = exportedSymbols(
      parsePythonDocument(stub?.text ?? '', stub?.fileName),
      stub?.text ?? ''
    );
    const text =
      'from urllib.request import urlopen\n\ndef f(url: str):\n    with urlopen(url) as response:\n        code = response.status\n        return response.read()\n';
    const doc = parsePythonDocument(text, 't.py', {
      imports: [
        {
          name: 'urlopen',
          declaration: members.find((m) => m.name === 'urlopen'),
        },
      ],
    });
    const types = new Map(
      doc.functions
        .flatMap((f) => f.nodes)
        .flatMap((n) => n.pins)
        .filter((p) => p.direction === 'out' && p.kind === 'data' && p.range)
        .map((p) => [
          text.slice(p.range?.start ?? 0, p.range?.end ?? 0),
          p.typeText ?? p.type,
        ])
    );
    expect(types.get('response')).toBe('HTTPResponse');
    expect(types.get('response.status')).toBe('int');
    expect(types.get('response.read()')).toBe('bytes');
    expect(
      doc.typeMembers?.HTTPResponse?.map((m) => `${m.kind} ${m.name}`)
    ).toContain('property status');
  });

  it('shows untyped results with the type of where they go', () => {
    const fn = parsePythonDocument(
      'def f(text: str) -> dict:\n    a = None\n    print(make(text))\n    return make(text)\n\ndef make(text):\n    return text\n',
      't.py'
    ).functions.find((f) => f.name === 'f');
    const results = (fn?.nodes ?? [])
      .filter((n) => n.title === 'make')
      .map((n) => n.pins.find((p) => p.id === 'return'))
      .map((p) => `${p?.type}${p?.usedAs ? ' (used as)' : ''}`);
    // Into print (anything): untyped; into the Return of a dict: a map.
    expect(results).toEqual(['any', 'map (used as)']);
  });
});
