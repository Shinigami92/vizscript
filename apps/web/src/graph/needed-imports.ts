import type { GraphOp, ImportRequest } from '@vizscript/core';

/** Code an op writes that may name things to import. */
export interface WrittenCode {
  text: string;
  /** Written where a type goes (TypeScript imports it as `import type`). */
  asType: boolean;
}

/**
 * The code an op writes that may need imports: types and decorators.
 * `isClass` tells a class (whose `extends` names a value) from a type.
 */
export function writtenCode(
  op: GraphOp,
  isClass: (symbol: string) => boolean = () => false
): WrittenCode[] {
  switch (op.type) {
    case 'setDecorator': {
      return op.text ? [{ text: op.text, asType: false }] : [];
    }

    case 'setSymbolType':
    case 'setParameterType':
    case 'setReturnType': {
      return op.typeText ? [{ text: op.typeText, asType: true }] : [];
    }

    case 'addParameter': {
      return op.typeText ? [{ text: op.typeText, asType: true }] : [];
    }

    case 'setTypeParams': {
      return op.text ? [{ text: op.text, asType: true }] : [];
    }

    case 'setHeritage': {
      // A base class is a value at run time; interfaces are types.
      const asType = op.clause === 'implements' || !isClass(op.symbol);
      return op.text ? [{ text: op.text, asType }] : [];
    }

    default: {
      return [];
    }
  }
}

const STRING = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const NAME = /[A-Za-z_$][\w$]*/g;

/**
 * The names code refers to, in order, each once: not members (`.REQUEST`
 * of `Scope.REQUEST`), keys and parameter names (`{ scope: … }`, `(a:
 * string) => …`) or the insides of strings.
 */
export function referencedNames(code: string): string[] {
  const text = code.replaceAll(STRING, (s) => ' '.repeat(s.length));
  const names: string[] = [];
  for (const match of text.matchAll(NAME)) {
    const at = match.index;
    const before = text.slice(0, at).trimEnd();
    const after = text.slice(at + match[0].length).trimStart();
    const member = before.endsWith('.') || before.endsWith('?.');
    const key = /[{,;(]$/.test(before) && /^\??:/.test(after);
    if (!member && !key && !names.includes(match[0])) {
      names.push(match[0]);
    }
  }

  return names;
}

/** The op with its imports, the first written first (one undo step). */
export function withImports(
  op: GraphOp,
  requests: ReadonlyArray<ImportRequest>
): GraphOp {
  return requests.reduceRight<GraphOp>(
    (inner, request) => ({ type: 'withImport', import: request, op: inner }),
    op
  );
}
