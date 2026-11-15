import type { GraphDocument, SourceRange } from '@vizscript/core';
import type { InjectionKey } from 'vue';

/** A value that is no node, parsed in its host file (`valueHost`). */
export interface ParsedValue {
  doc: GraphDocument;
  text: string;
  /** Where the value starts in `text`. */
  start: number;
}

/**
 * Parses a function input's default in its host file (provided by the
 * script workspace, which talks to the parser worker).
 */
export const PARSE_VALUE: InjectionKey<
  (
    range: SourceRange,
    typeText: string | undefined
  ) => Promise<ParsedValue | null>
> = Symbol('parse-value');
