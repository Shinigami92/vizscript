import type { SymbolParam, TypeMember } from '@vizscript/core';
import type { FunctionItem, Span } from './ast';
import { RUST_BUILTINS } from './builtins';
import { parseRust } from './convert';
import { dataTypeOf } from './data-type';
import {
  FLOAT,
  FLOATS,
  generic,
  INTEGER,
  INTEGERS,
  normalize,
  STUB_OF,
} from './type-text';

// ------------------------------------------------------------- built-ins

/** A parameter of a stub or of the file's own functions. */
export interface StubParam {
  name: string;
  /** Type as written, with the stub's placeholders (`T`, `Self`). */
  type?: string;
}

export interface Callable {
  /** Result as written, `undefined` for `()`. */
  returns: string | undefined;
  /** Signature for the action menu (`len() -> usize`). */
  detail: string;
  isAsync: boolean;
  params: ReadonlyArray<StubParam>;
}

export function sliceOf(
  text: string,
  span: Span | undefined
): string | undefined {
  return span ? text.slice(span.start, span.end) : undefined;
}

export function callableOf(text: string, fn: FunctionItem): Callable {
  const params = fn.params.map((p) => text.slice(p.start, p.end)).join(', ');
  const returns = sliceOf(text, fn.returns);
  return {
    returns,
    detail: `${fn.name}(${params})${returns ? ` -> ${returns}` : ''}`,
    isAsync: fn.modifiers.includes('async'),
    params: fn.params.map((p): StubParam => {
      const type = sliceOf(text, p.type);
      return {
        name: p.name ?? text.slice(p.pattern.start, p.pattern.end),
        ...(type ? { type } : {}),
      };
    }),
  };
}

const NOWHERE = { start: 0, end: 0 };

/**
 * The parameters of a callable as the call pins need them, with the
 * placeholders filled from the value it is called on (`Vec<Item>::push`
 * takes an `Item`).
 */
export function signatureOf(
  callable: Callable,
  self: string,
  args: ReadonlyArray<string> = []
): SymbolParam[] {
  return callable.params.map((param): SymbolParam => {
    const type = param.type ? substitute(param.type, self, args) : undefined;
    return {
      name: param.name,
      nameRange: NOWHERE,
      ...(type ? { type: { text: type, range: NOWHERE } } : {}),
      dataType: dataTypeOf(type),
    };
  });
}

let builtins: Map<string, Map<string, Callable>> | undefined;

export function rustBuiltins(): Map<string, Map<string, Callable>> {
  if (!builtins) {
    builtins = new Map();
    for (const item of parseRust(RUST_BUILTINS).items) {
      if (item.type === 'Trait') {
        const methods = new Map<string, Callable>();
        for (const member of item.items) {
          if (member.type === 'Function') {
            methods.set(member.name, callableOf(RUST_BUILTINS, member));
          }
        }

        builtins.set(item.name, methods);
      }
    }
  }

  return builtins;
}

/** The stub whose methods a type has (`u32` → `i64`, `[T]` → `Vec`). */
export function stubOf(
  type: string
): { stub: string; args: string[] } | undefined {
  if (INTEGERS.has(type) || type === INTEGER) {
    return { stub: 'i64', args: [] };
  }

  if (FLOATS.has(type) || type === FLOAT) {
    return { stub: 'f64', args: [] };
  }

  const slice = type.match(/^\[(.+)\]$/);
  if (slice?.[1]) {
    return { stub: 'Vec', args: [slice[1]] };
  }

  const { name, args } = generic(type);
  const stub = STUB_OF[name];
  return stub ? { stub, args } : undefined;
}

/** What `T`, `K`, `V`, `E` and `Self` of a stub stand for in a type. */
function placeholders(
  self: string,
  args: ReadonlyArray<string>
): Record<string, string | undefined> {
  const isMap = generic(self).name.endsWith('Map');
  return {
    T: args[0],
    K: args[0],
    V: isMap ? args[1] : undefined,
    E: args[1],
    Self: self,
  };
}

/** A stub's signature with the placeholders it knows filled in. */
function fill(
  detail: string,
  self: string,
  args: ReadonlyArray<string>
): string {
  const values = placeholders(self, args);
  return detail.replaceAll(/\b(?:[TKVE]|Self)\b/g, (name) => {
    const value = values[name];
    return value === undefined || value === '_' ? name : value;
  });
}

/** Fills the placeholders of a stub's result; `undefined` if unknown. */
export function substitute(
  returns: string,
  self: string,
  args: ReadonlyArray<string>
): string | undefined {
  const values = placeholders(self, args);
  let unknown = false;
  const result = returns.replaceAll(/\b(?:[TKVE]|Self)\b/g, (name) => {
    const value = values[name];
    if (value === undefined || value === '_') {
      unknown = true;
      return '_';
    }

    return value;
  });
  return unknown ? undefined : normalize(result);
}

/** A method of a standard type, with String's falling back to str's. */
export function builtinMethod(
  type: string,
  name: string
): Callable | undefined {
  const target = stubOf(type);
  if (!target) {
    return undefined;
  }

  const methods = rustBuiltins();
  return (
    methods.get(target.stub)?.get(name) ??
    (target.stub === 'String' ? methods.get('str')?.get(name) : undefined)
  );
}

const membersCache = new Map<string, ReadonlyArray<TypeMember> | undefined>();

/** Methods of a standard type (`String`, `Vec<Item>`), for the menu. */
export function builtinMembers(
  type: string
): ReadonlyArray<TypeMember> | undefined {
  if (!membersCache.has(type)) {
    const target = stubOf(type);
    const stubs = rustBuiltins();
    const methods = target
      ? [
          ...(stubs.get(target.stub) ?? []),
          ...(target.stub === 'String' ? (stubs.get('str') ?? []) : []),
        ]
      : [];
    membersCache.set(
      type,
      methods.length > 0
        ? methods.map(([name, method]): TypeMember => {
            const returns = method.returns
              ? substitute(method.returns, type, target?.args ?? [])
              : '()';
            return {
              name,
              kind: 'method',
              type: dataTypeOf(returns),
              detail: fill(method.detail, type, target?.args ?? []),
            };
          })
        : undefined
    );
  }

  return membersCache.get(type);
}
