import type { GraphDocument, PinRef, Point } from './ir';
import type { ModuleReference } from './module-refs';

/** A text replacement on the original source. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export type NodeTemplate =
  | {
      type: 'call';
      callee: string;
      /** Argument expressions (source text), e.g. a wired value. */
      args?: string[];
    }
  | { type: 'setVar'; name: string; declaration: 'const' | 'let' | 'none' }
  | { type: 'branch' }
  | { type: 'return' };

/**
 * Language-agnostic graph edit operations. Each language backend translates
 * them into {@link TextEdit}s on its own source code.
 */
export type GraphOp =
  | { type: 'deleteNodes'; nodeIds: string[] }
  | { type: 'setLiteral'; node: string; pin: string; value: string }
  | { type: 'connect'; from: PinRef; to: PinRef }
  | { type: 'disconnect'; pin: PinRef }
  | {
      type: 'addNode';
      template: NodeTemplate;
      /** Exec output pin the new statement should follow. */
      after?: PinRef;
      /** Exec input pin of a statement the new one should precede. */
      before?: PinRef;
      position?: Point;
    }
  /** Replaces the expression feeding a data input. */
  | { type: 'setInput'; pin: PinRef; expression: string }
  /** Moves the expression feeding a data input into a new variable. */
  | { type: 'extract'; pin: PinRef; name: string; position?: Point }
  /** Stores the value of a data output in a new variable. */
  | { type: 'promote'; pin: PinRef; name: string; position?: Point }
  /** Adds a call that receives the value of a data output. */
  | { type: 'callWith'; pin: PinRef; callee: string; position?: Point }
  /** Sets the comment above a node's code (empty text removes it). */
  | { type: 'setComment'; node: string; text: string }
  /** Puts the statements of the nodes into a titled region. */
  | { type: 'addCommentBox'; nodes: string[]; title: string }
  | { type: 'renameCommentBox'; box: string; title: string }
  /** Removes the region markers; the code inside stays. */
  | { type: 'deleteCommentBox'; box: string };

export type OpResult =
  | { ok: true; edits: TextEdit[] }
  | { ok: false; error: string };

export interface LanguageBackend {
  /** Unique id, e.g. `typescript`. */
  id: string;
  /** Human readable name. */
  name: string;
  /** Handled file extensions including the dot. */
  extensions: ReadonlyArray<string>;
  parse(text: string, fileName?: string): GraphDocument;
  applyOp(text: string, op: GraphOp, fileName?: string): OpResult;
  /** Files referenced by the source (imports, …) for Ctrl/Cmd+click. */
  references?(text: string, fileName?: string): ModuleReference[];
}

/**
 * Applies non-overlapping edits. Edits are applied back to front so offsets
 * stay valid.
 */
export function applyTextEdits(
  text: string,
  edits: ReadonlyArray<TextEdit>
): string {
  const sorted = [...edits].toSorted(
    (a, b) => b.start - a.start || b.end - a.end
  );
  let result = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) {
      throw new Error(
        `Overlapping text edits at ${edit.start}-${edit.end} and ${lastStart}`
      );
    }

    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    lastStart = edit.start;
  }

  return result;
}
