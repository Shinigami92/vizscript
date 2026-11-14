import type { DataType } from './ir';
import { isTypeCompatible } from './types';

/**
 * A conversion between two pin types, like UE's autocast nodes: wiring a
 * `number` into a `string` input writes `String(total)`.
 */
export interface Conversion {
  from: DataType;
  to: DataType;
  /** Code of the converted value; `$value` stands for the source. */
  template: string;
}

const PLACEHOLDER = '$value';

/** The conversion for a wire that doesn't fit as it is. */
export function findConversion(
  conversions: ReadonlyArray<Conversion> | undefined,
  from: DataType,
  to: DataType
): Conversion | undefined {
  if (isTypeCompatible(from, to)) {
    return undefined;
  }

  return conversions?.find((c) => c.from === from && c.to === to);
}

/** UE's tooltip: "Convert number to string". */
export function conversionLabel(conversion: Conversion): string {
  return `Convert ${conversion.from} to ${conversion.to}`;
}

/** A name, member chain, literal or simple call: safe before `.x` or `as`. */
function isPostfixSafe(expression: string): boolean {
  return /^(?:[\w$.]+(?:\([^()]*\))?|"[^"]*"|'[^']*')$/.test(expression);
}

export function applyConversion(template: string, expression: string): string {
  const wrapped = template.includes(`(${PLACEHOLDER})`);
  const value =
    wrapped || isPostfixSafe(expression) ? expression : `(${expression})`;
  return template.replace(PLACEHOLDER, value);
}

/** Callee of a `Name($value)` template, or `undefined` for other forms. */
function calleeOf(template: string): string | undefined {
  return /^([\w.]+)\(\$value\)$/.exec(template)?.[1];
}

/**
 * Result type of a one-argument call of a conversion function
 * (`String(x)`, `str(x)`), which is drawn as a compact pure node like UE's
 * autocast node; `undefined` for any other call.
 */
export function conversionCall(
  conversions: ReadonlyArray<Conversion>,
  callee: string,
  argumentCount: number
): DataType | undefined {
  if (argumentCount !== 1) {
    return undefined;
  }

  const types = new Set(
    conversions.filter((c) => calleeOf(c.template) === callee).map((c) => c.to)
  );
  const [only] = types;
  return types.size === 1 ? only : undefined;
}
