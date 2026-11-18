import type { InputPinMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type { GraphDocument, Pin, PinRef } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult } from './ops';
import { findNode } from './reconcile';
import { findPin } from './text-op-helpers';

/**
 * The spread token a value is written with (`...` of `...items`, Python's
 * `*` / `**`), if any: the value is unpacked into the call or collection.
 */
export function spreadOf(pin: Pin): string | undefined {
  return getMeta<InputPinMeta>(pin).spread;
}

/** The token a value can be spread with here, if the language has one. */
export function spreadableWith(pin: Pin): string | undefined {
  return getMeta<InputPinMeta>(pin).spreadable;
}

/** A pin's name with its spread token (`...items`). */
export function spreadName(pin: Pin): string {
  return `${spreadOf(pin) ?? ''}${pin.name}`;
}

/**
 * Writes the value of an input as a spread (`items.push(...more)`) or as
 * one value again (`items.push(more)`): the language's token before it.
 * Only for values the backend marked `spreadable` (arguments, elements of
 * a collection), not for an empty input.
 */
export function setSpread(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  spread: boolean
): OpResult {
  const pin = findPin(findNode(doc, ref.node), ref.pin);
  const token = pin ? spreadableWith(pin) : undefined;
  const range = pin?.range;
  if (!pin || !token || !range || range.end <= range.start) {
    return failed('This value cannot be spread.');
  }

  const own = spreadOf(pin);
  if (spread) {
    return own
      ? succeeded([])
      : succeeded([{ start: range.start, end: range.start, text: token }]);
  }

  if (!own) {
    return succeeded([]);
  }

  // The token right before the value, maybe with spaces (`... items`).
  const before = text.slice(0, range.start);
  const at = before.trimEnd().length - own.length;
  if (at < 0 || before.slice(at, at + own.length) !== own) {
    return failed('The spread of this value was not found.');
  }

  return succeeded([{ start: at, end: range.start, text: '' }]);
}
