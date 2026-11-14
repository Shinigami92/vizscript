import type { GraphDocument, ParseOptions, TypeMap } from '@vizscript/core';
import { applyTypes, checkTypes } from '@vizscript/core';
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

function withoutMembers(types: TypeMap): TypeMap {
  return new Map(
    [...types].map(([key, { members: _members, ...info }]) => [key, info])
  );
}

/**
 * Exact pin types from TypeScript's checker: after each parse the graph is
 * drawn at once with the parser's types, then again with the checker's
 * (`resolveTypes`), and once more when the checker got new files.
 */
export function useCheckerTypes(deps: CheckerTypeDeps): {
  refineTypes: (seq: number, source: string, parsed: GraphDocument) => void;
  checkedFor: (text: string) => ParseOptions['checked'];
} {
  /** The latest answers, without members (graph edits don't need them). */
  let checked: ParseOptions['checked'];

  async function refine(
    seq: number,
    source: string,
    parsed: GraphDocument
  ): Promise<void> {
    if (languageOf(deps.path()) !== 'typescript') {
      return;
    }

    const types = await checkTypes(
      parsed,
      source,
      deps.path(),
      typescriptTypes
    );
    if (!types || seq !== deps.parseSeq() || deps.parsedDoc.value !== parsed) {
      return;
    }

    // Calls get a pin per parameter; skipped ones are written `undefined`.
    checked = { text: source, types: withoutMembers(types) };
    const typed = applyTypes(parsed, types, {
      text: source,
      options: { placeholder: 'undefined' },
    });
    if (typed !== parsed) {
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
    // Sent with graph edits of that text, so the worker's parse has the
    // argument pins the graph shows.
    checkedFor: (text) => (checked?.text === text ? checked : undefined),
  };
}
