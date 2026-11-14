import type { GraphNode, TypeInfo, TypeProvider } from '@vizscript/core';
import { applyTypes, resolveTypes, typeQueries } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

const TEXT = `const TAX_RATE = 0.2;

async function load(url: string, retries = 3) {
  console.log(url);
  const logged = console.log(retries);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('failed');
  }
  return response.json();
}
`;

const RESPONSE: TypeInfo = {
  text: 'Response',
  dataType: 'Response',
  members: [
    { name: 'ok', kind: 'property', type: 'bool', detail: 'ok: boolean' },
    {
      name: 'json',
      kind: 'method',
      type: 'any',
      detail: 'json(): Promise<any>',
    },
  ],
};

/** A checker that knows the types of some source texts. */
function fakeProvider(known: Record<string, TypeInfo>): TypeProvider & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    typesAt: (text, _fileName, ranges) => {
      const answers = ranges.map((r) => {
        const source = text.slice(r.start, r.end);
        asked.push(source);
        return known[source];
      });
      return Promise.resolve(answers);
    },
  };
}

function nodeTitled(nodes: ReadonlyArray<GraphNode>, title: string): GraphNode {
  const node = nodes.find((n) => n.title === title);
  if (!node) {
    throw new Error(`no node ${title}`);
  }

  return node;
}

describe('type information from a checker', () => {
  const doc = parseTypeScript(TEXT, 'load.ts');

  it('asks for data outputs and untyped declarations only', () => {
    const asked = typeQueries(doc).map((r) => TEXT.slice(r.start, r.end));
    expect(asked).toContain('fetch(url)');
    expect(asked).toContain('response.ok');
    expect(asked).toContain('response.json()');
    // untyped: the constant and the parameter with a default value
    expect(asked).toContain('TAX_RATE');
    expect(asked).toContain('retries');
    // typed parameters keep their declared type
    expect(asked).not.toContain('url');
  });

  it('refines pins, symbols and collects members', async () => {
    const provider = fakeProvider({
      'fetch(url)': RESPONSE,
      response: RESPONSE,
      'response.ok': { text: 'boolean', dataType: 'bool' },
      'response.json()': { text: 'Promise<any>', dataType: 'any' },
      TAX_RATE: { text: 'number', dataType: 'number' },
      retries: { text: 'number', dataType: 'number' },
      'console.log(url)': { text: 'void', dataType: 'void' },
      'console.log(retries)': { text: 'void', dataType: 'void' },
    });
    const typed = await resolveTypes(doc, TEXT, 'load.ts', provider);
    const nodes = typed.functions.flatMap((f) => f.nodes);

    const fetchOut = nodeTitled(nodes, 'fetch').pins.find(
      (p) => p.direction === 'out' && p.kind === 'data'
    );
    expect(fetchOut).toMatchObject({ type: 'Response', typeText: 'Response' });

    // The SET of the variable: its value takes the variable's type.
    const set = nodeTitled(nodes, 'Set response');
    expect(
      set.pins.filter((p) => p.kind === 'data').map((p) => [p.id, p.type])
    ).toEqual([
      ['value', 'Response'],
      ['out', 'Response'],
    ]);

    const ok = nodes
      .flatMap((n) => n.pins)
      .find(
        (p) =>
          p.range &&
          TEXT.slice(p.range.start, p.range.end) === 'response.ok' &&
          p.direction === 'out'
      );
    expect(ok?.type).toBe('bool');

    // `any` answers keep the parser's type
    const json = nodeTitled(nodes, 'response.json').pins.find(
      (p) => p.direction === 'out' && p.kind === 'data'
    );
    expect(json?.typeText).toBeUndefined();

    const symbols = typed.symbols ?? [];
    expect(symbols.find((s) => s.name === 'TAX_RATE')?.dataType).toBe('number');
    const params = symbols.find((s) => s.name === 'load')?.params ?? [];
    expect(params.map((p) => [p.name, p.dataType])).toEqual([
      ['url', 'string'],
      ['retries', 'number'],
    ]);

    // Results of nothing lose their pin, unless the code uses them.
    const logs = nodes.filter((n) => n.title === 'console.log');
    expect(
      logs.map((n) =>
        n.pins.filter((p) => p.id === 'return').map((p) => p.type)
      )
    ).toEqual([[], ['void']]);

    expect(typed.typeMembers?.Response?.map((m) => m.name)).toEqual([
      'ok',
      'json',
    ]);
  });

  it('shares unchanged parts and leaves the parsed document alone', () => {
    const before = JSON.stringify(doc);
    const same = applyTypes(doc, new Map());
    expect(same).toBe(doc);

    const typed = applyTypes(
      doc,
      new Map([['0:0', { text: 'never', dataType: 'never' }]])
    );
    expect(typed.functions[0]).toBe(doc.functions[0]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('keeps the parsed document when the provider fails', async () => {
    const failing: TypeProvider = {
      typesAt: () => Promise.reject(new Error('worker gone')),
    };
    expect(await resolveTypes(doc, TEXT, 'load.ts', failing)).toBe(doc);
  });
});
