import type { SymbolParam, TypeMember } from '@vizscript/core';
import type { FunctionDef, Span } from './ast';
import { PYTHON_BUILTINS } from './builtins';
import { parsePython } from './convert';
import { dataTypeOf } from './lower-utils';
import { generic, known } from './type-text';

// ------------------------------------------------------------- built-ins

/** A parameter of a stub or of the file's own functions. */
export interface StubParam {
  name: string;
  /** Annotation as written, with the stub's placeholders (`T`). */
  type?: string;
  defaultText?: string;
  rest?: boolean;
}

export interface Callable {
  /** Result as written, `undefined` when not annotated. */
  returns: string | undefined;
  /** Signature for the action menu (`upper() -> str`). */
  detail: string;
  isAsync: boolean;
  params: ReadonlyArray<StubParam>;
}

export interface StubClass {
  methods: Map<string, Callable>;
  fields: Map<string, string | undefined>;
}

export function sliceOf(
  text: string,
  span: Span | undefined
): string | undefined {
  return span ? text.slice(span.start, span.end) : undefined;
}

export function callableOf(
  text: string,
  fn: FunctionDef,
  method: boolean
): Callable {
  const own = fn.params.filter((p, i) => !(method && i === 0));
  const params = own.map((p) => text.slice(p.start, p.end)).join(', ');
  const returns = sliceOf(text, fn.returns);
  return {
    returns,
    detail: `${fn.name}(${params})${returns ? ` -> ${returns}` : ''}`,
    isAsync: fn.isAsync,
    params: own.map((p): StubParam => {
      const type = sliceOf(text, p.annotation);
      const defaultText = sliceOf(text, p.defaultValue);
      return {
        name: p.name.replace(/^\*+/, ''),
        ...(type ? { type } : {}),
        ...(defaultText ? { defaultText } : {}),
        ...(p.name.startsWith('*') ? { rest: true } : {}),
      };
    }),
  };
}

const NOWHERE = { start: 0, end: 0 };

/**
 * The parameters of a callable as the call pins need them, with the
 * placeholders of a built-in generic filled (`list[Item].append(item: T)`
 * takes an `Item`).
 */
export function signatureOf(
  callable: Callable,
  args: ReadonlyArray<string> = []
): SymbolParam[] {
  return callable.params.map((param): SymbolParam => {
    const type = param.type ? substitute(param.type, args) : undefined;
    return {
      name: param.name,
      nameRange: NOWHERE,
      ...(type ? { type: { text: type, range: NOWHERE } } : {}),
      dataType: dataTypeOf(type),
      ...(param.defaultText ? { defaultText: param.defaultText } : {}),
      ...(param.rest ? { rest: true } : {}),
    };
  });
}

export interface Builtins {
  classes: Map<string, StubClass>;
  functions: Map<string, Callable>;
}

let builtins: Builtins | undefined;

export function pythonBuiltins(): Builtins {
  if (builtins) {
    return builtins;
  }

  const text = PYTHON_BUILTINS;
  const result: Builtins = { classes: new Map(), functions: new Map() };
  for (const stmt of parsePython(text).body) {
    if (stmt.type === 'FunctionDef') {
      result.functions.set(stmt.name, callableOf(text, stmt, false));
    } else if (stmt.type === 'ClassDef') {
      const methods = new Map<string, Callable>();
      for (const member of stmt.body.body) {
        if (member.type === 'FunctionDef') {
          methods.set(member.name, callableOf(text, member, true));
        }
      }

      result.classes.set(stmt.name, { methods, fields: new Map() });
    }
  }

  builtins = result;
  return result;
}

/** Fills `T`, `K` and `V` of a built-in generic's member. */
export function substitute(
  returns: string,
  args: ReadonlyArray<string>
): string | undefined {
  const values: Record<string, string | undefined> = {
    T: known(args[0]),
    K: known(args[0]),
    V: known(args[1]),
  };
  let unknown = false;
  const result = returns.replaceAll(/\b[TKV]\b/g, (name) => {
    const value = values[name];
    if (value === undefined) {
      unknown = true;
      return 'Any';
    }

    return value;
  });
  if (unknown && /^[TKV]$/.test(returns)) {
    return undefined;
  }

  return result;
}

/** A stub's signature with the item types it knows filled in. */
function fill(detail: string, args: ReadonlyArray<string>): string {
  const values: Record<string, string | undefined> = {
    T: known(args[0]),
    K: known(args[0]),
    V: known(args[1]),
  };
  return detail.replaceAll(/\b[TKV]\b/g, (name) => values[name] ?? name);
}

const membersCache = new Map<string, ReadonlyArray<TypeMember> | undefined>();

/** Members of a built-in type (`str`, `list[int]`), for the action menu. */
export function builtinMembers(
  type: string
): ReadonlyArray<TypeMember> | undefined {
  if (!membersCache.has(type)) {
    const { name, args } = generic(type);
    const cls = pythonBuiltins().classes.get(name);
    membersCache.set(
      type,
      cls
        ? [...cls.methods].map(([member, method]): TypeMember => {
            const returns = method.returns
              ? substitute(method.returns, args)
              : undefined;
            return {
              name: member,
              kind: 'method',
              type: dataTypeOf(returns),
              detail: fill(method.detail, args),
            };
          })
        : undefined
    );
  }

  return membersCache.get(type);
}
