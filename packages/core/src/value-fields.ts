import type { TypeSystemInfo } from './ops';
import type { ScriptSymbol } from './symbols';

/**
 * Values the Details panel edits with fields instead of code, like UE's
 * vector, color and enum widgets.
 */
export type FieldValue =
  | {
      type: 'vector';
      name: string;
      fields: ReadonlyArray<string>;
      values: ReadonlyArray<string>;
    }
  | {
      type: 'color';
      name: string;
      /** 0…1 each. */
      rgba: readonly [number, number, number, number];
      /** Written as `Color("#rrggbb")` rather than `Color(r, g, b)`. */
      html: boolean;
      hasAlpha: boolean;
    }
  | {
      type: 'enum';
      choices: ReadonlyArray<{ label: string; code: string }>;
      current: string;
    };

const NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;

const NAMED_COLORS: Record<string, string> = {
  BLACK: '#000000',
  WHITE: '#ffffff',
  RED: '#ff0000',
  GREEN: '#00ff00',
  BLUE: '#0000ff',
  YELLOW: '#ffff00',
  CYAN: '#00ffff',
  MAGENTA: '#ff00ff',
  ORANGE: '#ffa500',
  GRAY: '#bebebe',
  TRANSPARENT: '#ffffff00',
};

function hexToRgba(hex: string): [number, number, number, number] | undefined {
  const digits = hex.replace(/^#/, '');
  if (!/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(digits)) {
    return undefined;
  }

  const part = (i: number): number =>
    Number.parseInt(digits.slice(i, i + 2), 16) / 255;
  return [part(0), part(2), part(4), digits.length === 8 ? part(6) : 1];
}

/** One color channel (0…1) as two hex digits. */
function hexPart(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0');
}

export function rgbaToHex(
  rgba: readonly [number, number, number, number],
  alpha: boolean
): string {
  return `#${hexPart(rgba[0])}${hexPart(rgba[1])}${hexPart(rgba[2])}${alpha ? hexPart(rgba[3]) : ''}`;
}

function args(code: string, name: string): string[] | undefined {
  const match = code.match(/^([A-Za-z_]\w*)\s*\(([^()]*)\)$/);
  return match?.[1] === name
    ? (match[2] ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
    : undefined;
}

function vectorValue(
  code: string,
  typeName: string,
  vectors: Record<string, ReadonlyArray<string>>
): FieldValue | undefined {
  const name =
    code.match(/^([A-Za-z_]\w*)\s*[(.]/)?.[1] ?? (code === '' ? typeName : '');
  const fields = vectors[name];
  if (!fields) {
    return undefined;
  }

  if (code === '') {
    return { type: 'vector', name, fields, values: fields.map(() => '') };
  }

  const constant = code.match(/^\w+\.(ZERO|ONE)$/)?.[1];
  if (constant) {
    const value = constant === 'ONE' ? '1' : '0';
    return { type: 'vector', name, fields, values: fields.map(() => value) };
  }

  const values = args(code, name);
  return values?.length === fields.length && values.every((v) => NUMBER.test(v))
    ? { type: 'vector', name, fields, values }
    : undefined;
}

function colorValue(
  code: string,
  typeName: string,
  color: string
): FieldValue | undefined {
  const base = { type: 'color' as const, name: color };
  if (code === '') {
    return typeName === color
      ? { ...base, rgba: [1, 1, 1, 1], html: false, hasAlpha: false }
      : undefined;
  }

  const named = code.match(new RegExp(String.raw`^${color}\.([A-Z_]+)$`))?.[1];
  if (named) {
    const rgba = NAMED_COLORS[named]
      ? hexToRgba(NAMED_COLORS[named])
      : undefined;
    return rgba
      ? { ...base, rgba, html: false, hasAlpha: rgba[3] < 1 }
      : undefined;
  }

  const html = code.match(
    new RegExp(String.raw`^${color}(?:\.html)?\(\s*["']([^"']+)["']\s*\)$`)
  )?.[1];
  if (html) {
    const rgba = hexToRgba(html);
    return rgba
      ? {
          ...base,
          rgba,
          html: true,
          hasAlpha: html.replace('#', '').length === 8,
        }
      : undefined;
  }

  const values = args(code, color);
  if (
    values &&
    (values.length === 3 || values.length === 4) &&
    values.every((v) => NUMBER.test(v))
  ) {
    const [r = 1, g = 1, b = 1, a = 1] = values.map(Number);
    return {
      ...base,
      rgba: [r, g, b, a],
      html: false,
      hasAlpha: values.length === 4,
    };
  }

  return undefined;
}

/** Members of an enum type of the file (`State.IDLE`), or literal unions. */
function enumValue(
  code: string,
  typeName: string,
  symbols: ReadonlyArray<ScriptSymbol>,
  text: string
): FieldValue | undefined {
  // `'small' | 'big'` written as the type, or as a type alias.
  const alias = symbols.find((s) => s.kind === 'type' && s.name === typeName);
  const union = typeName.includes('|')
    ? typeName
    : alias
      ? text.slice(alias.range.start, alias.range.end).match(/=\s*([^;]+)/)?.[1]
      : undefined;
  if (union) {
    const parts = union.split('|').map((p) => p.trim());
    if (
      parts.length > 1 &&
      parts.every((p) => /^(?:"[^"]*"|'[^']*'|[-\d.]+)$/.test(p))
    ) {
      return {
        type: 'enum',
        choices: parts.map((p) => ({
          label: p.replaceAll(/["']/g, ''),
          code: p,
        })),
        current: code,
      };
    }
  }

  // An enum of the file, by the type or by the value (`State.IDLE`).
  const name = symbols.some((s) => s.kind === 'enum' && s.name === typeName)
    ? typeName
    : code.match(/^([A-Za-z_]\w*)\.\w+$/)?.[1];
  const declared = symbols.find((s) => s.kind === 'enum' && s.name === name);
  if (!declared || !name) {
    return undefined;
  }

  // Python's enum members are constants of the class.
  const members =
    declared.members ??
    symbols
      .filter((s) => s.kind === 'constant' && s.scope === name)
      .map((s) => s.name);
  return members.length > 0
    ? {
        type: 'enum',
        choices: members.map((m) => ({ label: m, code: `${name}.${m}` })),
        current: code,
      }
    : undefined;
}

/** Fields for a value, when its type or code has a widget. */
export function fieldValue(
  code: string,
  typeName: string,
  info: TypeSystemInfo | null,
  symbols: ReadonlyArray<ScriptSymbol>,
  text: string
): FieldValue | undefined {
  const editors = info?.valueEditors;
  return (
    (editors?.vectors
      ? vectorValue(code, typeName, editors.vectors)
      : undefined) ??
    (editors?.color ? colorValue(code, typeName, editors.color) : undefined) ??
    enumValue(code, typeName, symbols, text)
  );
}

function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The code of edited fields. */
export function vectorCode(
  name: string,
  values: ReadonlyArray<string>
): string {
  return `${name}(${values.map((v) => v.trim() || '0').join(', ')})`;
}

export function colorCode(
  name: string,
  rgba: readonly [number, number, number, number],
  html: boolean,
  hasAlpha: boolean
): string {
  const alpha = hasAlpha || rgba[3] < 1;
  if (html) {
    return `${name}("${rgbaToHex(rgba, alpha)}")`;
  }

  const parts = (alpha ? rgba : rgba.slice(0, 3)).map(round);
  return `${name}(${parts.join(', ')})`;
}
