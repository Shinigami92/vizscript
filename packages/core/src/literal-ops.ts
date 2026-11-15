import type { InputPinMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type { GraphDocument, LiteralKind, PinRef } from './ir';
import { failed, succeeded } from './op-result';
import { operandText } from './operand-parens';
import type { OpResult } from './ops';
import { findNode } from './reconcile';
import { findPin, inputEdit } from './text-op-helpers';
import type { StatementSyntax } from './text-ops';

/** Words that are values in every supported language. */
const VALUE_WORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'None',
  'True',
  'False',
  'NaN',
  'Infinity',
]);

/** Globals of the supported languages that typed code often starts with. */
const KNOWN_GLOBALS = new Set([
  'Math',
  'JSON',
  'console',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Date',
  'Promise',
  'globalThis',
  'window',
  'document',
  'this',
  'self',
  'len',
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'range',
  'print',
  'Vector2',
  'Vector3',
  'Color',
]);

/**
 * Whether a typed value is code rather than text: a number, a quoted
 * string, `[…]` / `{…}` / `(…)`, or something that starts with a name the
 * script knows (`user`, `count + 1`, `greet(user)`, `Math.max(a, b)`).
 * `Jane User`, `Hello, ` or `Hello!` are text.
 */
export function looksLikeCode(value: string, doc: GraphDocument): boolean {
  if (/^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) {
    return true;
  }

  if (VALUE_WORDS.has(value) || /^["'`[{(]/.test(value)) {
    return true;
  }

  const leading = value.match(/^(?:[-!]|not\s+)*([A-Za-z_$][\w$]*)/)?.[1];
  if (!leading) {
    return false;
  }

  const known = new Set<string>(KNOWN_GLOBALS);
  for (const symbol of doc.symbols ?? []) {
    known.add(symbol.name);
    for (const param of symbol.params ?? []) {
      known.add(param.name);
    }
  }

  return known.has(leading);
}

/** Source of a value typed into a pin that has no code yet. */
function literalSource(
  value: string,
  kind: LiteralKind,
  doc: GraphDocument,
  syntax: StatementSyntax
): string | { error: string } {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { error: 'Value must not be empty.' };
  }

  switch (kind) {
    case 'string':
    case 'template': {
      return syntax.declarations?.string(value) ?? JSON.stringify(value);
    }

    case 'number': {
      if (!Number.isNaN(Number(trimmed.replaceAll('_', '')))) {
        return trimmed;
      }

      return looksLikeCode(trimmed, doc)
        ? trimmed
        : { error: `"${value}" is not a number.` };
    }

    case 'boolean': {
      const words = syntax.booleans ?? { true: 'true', false: 'false' };
      const normalized = trimmed.toLowerCase();
      if (normalized === 'true' || normalized === 'false') {
        return words[normalized];
      }

      return looksLikeCode(trimmed, doc)
        ? trimmed
        : { error: `A boolean must be ${words.true} or ${words.false}.` };
    }

    default: {
      return looksLikeCode(trimmed, doc)
        ? trimmed
        : (syntax.declarations?.string(value) ?? JSON.stringify(value));
    }
  }
}

export function setLiteral(
  doc: GraphDocument,
  nodeId: string,
  pinId: string,
  value: string,
  syntax: StatementSyntax
): OpResult {
  const node = findNode(doc, nodeId);
  const pin = findPin(node, pinId);
  const insert = pin ? getMeta<InputPinMeta>(pin) : undefined;
  if (pin?.literal && !pin.range && insert?.insertInitAt !== undefined) {
    // A missing argument: its value is inserted (UE: a pin's default box).
    const source = literalSource(value, pin.literal.kind, doc, syntax);
    if (typeof source !== 'string') {
      return failed(source.error);
    }

    return succeeded([
      {
        start: insert.insertInitAt,
        end: insert.insertInitAt,
        text: `${insert.insertPrefix ?? ' = '}${source}${insert.insertSuffix ?? ''}`,
      },
    ]);
  }

  if (!pin?.literal || !pin.range) {
    return failed('This pin has no editable value.');
  }

  const literal = pin.literal;
  let replacement: string;
  switch (literal.kind) {
    case 'string':
    case 'template': {
      replacement = syntax.quote(value, literal);
      break;
    }

    case 'number': {
      const trimmed = value.trim();
      if (trimmed === '' || Number.isNaN(Number(trimmed.replaceAll('_', '')))) {
        // Code stays code (`count * 2`), like in an empty input.
        if (node && looksLikeCode(trimmed, doc)) {
          replacement = operandText(node, pin, trimmed);
          break;
        }

        return failed(`"${value}" is not a number.`);
      }

      replacement = syntax.number?.(trimmed, literal.raw) ?? trimmed;
      break;
    }

    case 'boolean': {
      const words = syntax.booleans ?? { true: 'true', false: 'false' };
      const trimmed = value.trim();
      const normalized = trimmed.toLowerCase();
      if (normalized !== 'true' && normalized !== 'false') {
        // Code stays code (`!response.ok`), like in an empty input.
        if (node && looksLikeCode(trimmed, doc)) {
          replacement = operandText(node, pin, trimmed);
          break;
        }

        return failed(`A boolean must be ${words.true} or ${words.false}.`);
      }

      replacement = normalized === 'true' ? words.true : words.false;
      break;
    }

    default: {
      if (value.trim() === '') {
        return failed('Value must not be empty.');
      }

      // A placeholder (`undefined`, `None`) has no type yet: plain text is
      // a string, like UE's text box; code stays code.
      replacement =
        (literal.kind === 'undefined' || literal.kind === 'null') &&
        !looksLikeCode(value.trim(), doc)
          ? (syntax.declarations?.string(value) ?? JSON.stringify(value))
          : node
            ? operandText(node, pin, value.trim())
            : value.trim();
    }
  }

  return succeeded([inputEdit(pin, pin.range, replacement)]);
}

export function setInput(
  doc: GraphDocument,
  ref: PinRef,
  expression: string
): OpResult {
  const node = findNode(doc, ref.node);
  const pin = findPin(node, ref.pin);
  if (!node || !pin || pin.kind !== 'data' || pin.direction !== 'in') {
    return failed('Only data inputs can be given a value.');
  }

  const trimmed = expression.trim();
  if (!trimmed || trimmed.includes('\n')) {
    return failed('Enter a single-line expression.');
  }

  const value = operandText(node, pin, trimmed);

  if (pin.range) {
    return succeeded([inputEdit(pin, pin.range, value)]);
  }

  const meta = getMeta<InputPinMeta>(pin);
  if (meta.insertInitAt !== undefined) {
    return succeeded([
      {
        start: meta.insertInitAt,
        end: meta.insertInitAt,
        text: `${meta.insertPrefix ?? ' = '}${value}${meta.insertSuffix ?? ''}`,
      },
    ]);
  }

  return failed('This input cannot be given a value.');
}
