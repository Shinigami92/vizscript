import type { ScriptSymbol } from '@vizscript/core';
import type { Callable, StubParam } from './builtin-types';
import { normalize } from './type-text';

/**
 * A type of an imported signature with its generic parameters unknown
 * (`Result<T>` of `from_str<T>` is a `Result<_>`): by Rust's naming, one
 * capital letter.
 */
function withoutGenerics(type: string | undefined): string | undefined {
  return type?.replaceAll(/\b[A-Z]\b(?!\s*::)/g, '_');
}

/**
 * A function or method of another file or crate, as a callable; the
 * signature shown keeps its generic parameters.
 */
export function importedCallable(
  symbol: ScriptSymbol,
  self?: string
): Callable {
  const params = (symbol.params ?? []).map((p): StubParam => {
    const type = withoutGenerics(p.type?.text);
    return { name: p.name, ...(type ? { type } : {}) };
  });
  const returns = symbol.returns?.text;
  const list = (symbol.params ?? [])
    .map((p) => (p.type ? `${p.name}: ${p.type.text}` : p.name))
    .join(', ');
  return {
    returns: normalize(withoutGenerics(returns), self),
    detail: `${symbol.name}(${list})${returns ? ` -> ${returns}` : ''}`,
    isAsync: symbol.modifiers.includes('async'),
    params,
  };
}
