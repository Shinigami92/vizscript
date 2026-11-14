import type { GraphDocument } from '@vizscript/core';
import { resolveTypes } from '@vizscript/core';
import type { Ref, ShallowRef } from 'vue';
import { onBeforeUnmount } from 'vue';
import { languageOf } from '../../graph/languages';
import {
  onCheckerFilesChange,
  typescriptTypes,
} from '../../monaco/ts-type-provider';

interface CheckerTypeDeps {
  path: () => string;
  /** The document as parsed (before graph-only edits). */
  parsedDoc: ShallowRef<GraphDocument | null>;
  /** The text `parsedDoc` was parsed from. */
  docText: Ref<string>;
  /** Number of the latest parse: answers for older ones are dropped. */
  parseSeq: () => number;
  /** Shows the document with the checker's types. */
  apply: (typed: GraphDocument) => void;
}

/**
 * Exact pin types from TypeScript's checker: after each parse the graph is
 * drawn at once with the parser's types, then again with the checker's
 * (`resolveTypes`), and once more when the checker got new files.
 */
export function useCheckerTypes(deps: CheckerTypeDeps): {
  refineTypes: (seq: number, source: string, parsed: GraphDocument) => void;
} {
  async function refine(
    seq: number,
    source: string,
    parsed: GraphDocument
  ): Promise<void> {
    if (languageOf(deps.path()) !== 'typescript') {
      return;
    }

    const typed = await resolveTypes(
      parsed,
      source,
      deps.path(),
      typescriptTypes
    );
    if (
      typed !== parsed &&
      seq === deps.parseSeq() &&
      deps.parsedDoc.value === parsed
    ) {
      deps.apply(typed);
    }
  }

  const subscription = onCheckerFilesChange(() => {
    const parsed = deps.parsedDoc.value;
    if (parsed) {
      void refine(deps.parseSeq(), deps.docText.value, parsed);
    }
  });
  onBeforeUnmount(() => subscription.dispose());

  return {
    refineTypes: (seq, source, parsed) => void refine(seq, source, parsed),
  };
}
