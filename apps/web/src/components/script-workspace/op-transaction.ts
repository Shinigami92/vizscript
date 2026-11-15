import type { TextChange, TextEdit } from '@vizscript/core';
import { applyTextEdits, diffEdits } from '@vizscript/core';
import type { PendingPlacement } from './placement';

/**
 * A graph edit written into the code, from the editor applying its edits to
 * the parse of the result: only that parse takes what the edit noted
 * beforehand (placement, kept Gets, kept nodes).
 */
export interface OpTransaction {
  /** The text the edits were made on. */
  readonly base: string;
  readonly edits: ReadonlyArray<TextEdit>;
  /** The text once the editor applied the edits. */
  readonly after: string;
  /** Parses up to this number started before the edits were applied. */
  readonly parsesBefore: number;
  /** Where the new nodes go (where the wire was dropped, the menu opened). */
  readonly placement?: PendingPlacement;
}

export function opTransaction(
  base: string,
  edits: ReadonlyArray<TextEdit>,
  parsesBefore: number,
  placement?: PendingPlacement | null
): OpTransaction {
  return {
    base,
    edits,
    after: applyTextEdits(base, edits),
    parsesBefore,
    ...(placement ? { placement } : {}),
  };
}

/**
 * What a finished parse (number `seq`) is for a pending transaction:
 * - `result`: it parsed the written code (maybe with typing after it);
 * - `earlier`: it started before the edits were written, so the
 *   transaction waits for the next one;
 * - `none`: there is no transaction.
 */
export function parseRole(
  transaction: OpTransaction | null,
  seq: number
): 'result' | 'earlier' | 'none' {
  if (!transaction) {
    return 'none';
  }

  return seq > transaction.parsesBefore ? 'result' : 'earlier';
}

/**
 * The change nodes are followed through from `before` (the last parsed
 * text) to `source`: the transaction's own edits when the parse is exactly
 * its result, else the difference of the texts (typing, undo, redo).
 */
export function textChange(
  transaction: OpTransaction | null,
  before: string,
  source: string
): TextChange {
  return {
    before,
    edits:
      transaction && transaction.base === before && transaction.after === source
        ? transaction.edits
        : diffEdits(before, source),
  };
}
