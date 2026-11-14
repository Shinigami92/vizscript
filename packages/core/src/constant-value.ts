/** Strings of the supported languages, with their prefixes (`f`, `r`, `b`, `&`). */
const STRINGS =
  /[rbuRBU&^]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
/** Numbers with Rust's suffixes, hex and `_` separators. */
const NUMBERS =
  /\b(?:0x[\da-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[-+]?\d+)?)(?:[iu](?:8|16|32|64|128|size)|f32|f64|n)?\b/gi;
const WORDS = /\b(?:true|false|True|False|null|None|undefined|nil)\b/g;

/**
 * Whether a value written in code is a constant, like UE's Default Value,
 * rather than computed when the code runs: literals (numbers, text,
 * booleans, empty values), arithmetic of them, and lists, maps and objects
 * made of them (`[1, 2]`, `{ name: 'Keyboard' }`, `vec![1, 2]`). Calls,
 * names of other values and interpolated text are computed. Value types
 * and enum members (`Vector2(1, 2)`, `State.IDLE`) have their own fields
 * (`fieldValue`), judged before this.
 */
export function isConstantValue(code: string): boolean {
  const trimmed = code.trim();
  // Interpolation reads other values: `${a}`, f"{a}".
  if (
    /`[^`]*\$\{/.test(trimmed) ||
    /(?:^|[^\w])[fF]["'][^"']*\{/.test(trimmed)
  ) {
    return false;
  }

  const rest = trimmed
    .replaceAll(STRINGS, ' 0 ')
    .replaceAll(/\bvec!\s*/g, '')
    // Keys of objects (`{ name: … }`); dict keys are strings already.
    .replaceAll(/([{,]\s*)[A-Za-z_$][\w$]*\s*:/g, '$1')
    .replaceAll(WORDS, ' 0 ')
    .replaceAll(NUMBERS, ' 0 ');
  return /^[\s0[\](){},:;+\-*/%.]*$/.test(rest);
}
