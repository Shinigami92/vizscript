import type { SourceRange } from '@vizscript/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { checkerTypesAt } from '../src/monaco/checker-types';

const LIB = `
interface Response { readonly ok: boolean; readonly status: number; json(): Promise<any>; }
declare function fetch(url: string): Promise<Response>;
`;

function program(text: string): ts.Program {
  const files: Record<string, string> = { '/main.ts': text, '/lib.d.ts': LIB };
  // ES2022 without the DOM: `Response` and `fetch` come from LIB.
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) => {
    const source = files[name];
    return source === undefined
      ? read(name, version, ...rest)
      : ts.createSourceFile(name, source, version, true);
  };
  return ts.createProgram(['/main.ts', '/lib.d.ts'], options, host);
}

/** Range of the `index`th occurrence of `part`. */
function at(text: string, part: string, index = 0): SourceRange {
  let start = -1;
  for (let i = 0; i <= index; i++) {
    start = text.indexOf(part, start + 1);
  }

  return { start, end: start + part.length };
}

const TEXT = `const TAX_RATE = 0.2;
const names = ['a', 'b'];
async function load(url: string, retries = 3) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  retry(retries);
  return { body: await response.json(), names };
}
function retry(times: number, delay?: number, label = 'x'): void {}
`;

function types(...ranges: SourceRange[]): ReturnType<typeof checkerTypesAt> {
  return checkerTypesAt(ts, program(TEXT), '/main.ts', ranges);
}

describe('checkerTypesAt', () => {
  it('reads the types of expressions', () => {
    const [call, awaited, ok, not] = types(
      at(TEXT, 'fetch(url)'),
      at(TEXT, 'await fetch(url)'),
      at(TEXT, 'response.ok'),
      at(TEXT, '!response.ok')
    );
    expect(call).toMatchObject({
      text: 'Promise<Response>',
      dataType: 'Promise<Response>',
    });
    expect(awaited?.dataType).toBe('Response');
    expect(awaited?.members?.map((m) => [m.name, m.kind, m.type])).toEqual([
      ['ok', 'property', 'bool'],
      ['status', 'property', 'number'],
      ['json', 'method', 'Promise<any>'],
    ]);
    expect(awaited?.members?.[2]?.detail).toBe('json(): Promise<any>');
    expect(ok).toEqual({ text: 'boolean', dataType: 'bool' });
    expect(not?.dataType).toBe('bool');
  });

  it('widens literals and reads declarations by name', () => {
    const [rate, names, retries, url] = types(
      at(TEXT, 'TAX_RATE'),
      at(TEXT, 'names'),
      at(TEXT, 'retries = 3'),
      at(TEXT, 'url: string')
    );
    expect(rate).toEqual({ text: 'number', dataType: 'number' });
    expect(names?.dataType).toBe('string[]');
    expect(retries?.dataType).toBe('number');
    expect(url?.dataType).toBe('string');
  });

  it('maps object literals, any and missing places', () => {
    const [object, json, nothing] = types(
      at(TEXT, '{ body: await response.json(), names }'),
      at(TEXT, 'await response.json()'),
      { start: 9999, end: 10_000 }
    );
    expect(object?.dataType).toBe('object');
    expect(object?.members?.map((m) => m.name)).toEqual(['body', 'names']);
    expect(json).toEqual({ text: 'any', dataType: 'any' });
    expect(nothing).toBeUndefined();
  });
});

describe('type texts', () => {
  it('name types of other files as written', () => {
    const files: Record<string, string> = {
      '/main.ts': "import { make } from './lib';\nconst made = make();\n",
      '/lib.ts':
        'export class Thing { size = 1; }\nexport function make(): Thing { return new Thing(); }\n',
    };
    const options: ts.CompilerOptions = { lib: ['lib.es2022.d.ts'] };
    const host = ts.createCompilerHost(options);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (name, version, ...rest) => {
      const source = files[name];
      return source === undefined
        ? read(name, version, ...rest)
        : ts.createSourceFile(name, source, version, true);
    };
    host.fileExists = (name) => name in files || ts.sys.fileExists(name);
    host.readFile = (name) => files[name] ?? ts.sys.readFile(name);
    const text = files['/main.ts'] ?? '';
    const [made] = checkerTypesAt(
      ts,
      ts.createProgram(['/main.ts'], options, host),
      '/main.ts',
      [at(text, 'make()')]
    );
    expect(made).toMatchObject({ text: 'Thing', dataType: 'Thing' });
    expect(made?.members?.map((m) => m.name)).toEqual(['size']);
  });

  it('reads the parameters a call resolves to', () => {
    const [call] = types(at(TEXT, 'retry(retries)'));
    expect(call?.signature).toEqual([
      expect.objectContaining({ name: 'times', dataType: 'number' }),
      expect.objectContaining({
        name: 'delay',
        dataType: 'number',
        defaultText: 'undefined',
      }),
      expect.objectContaining({
        name: 'label',
        dataType: 'string',
        defaultText: "'x'",
      }),
    ]);
  });
});
