/// <reference lib="webworker" />
/**
 * Monaco's TypeScript worker with one more method: the types the checker
 * sees at ranges of a file (`vizTypesAt`), for the graph's pins. Monaco's
 * worker proxy forwards any method name, so `getTypeScriptWorker()` can
 * call it.
 */
import type { SourceRange, TypeInfo } from '@vizscript/core';
import {
  initialize,
  ts,
  TypeScriptWorker,
} from 'monaco-editor/language/typescript/ts.worker';
import type * as TS from 'typescript';
import { checkerTypesAt } from './checker-types';

class VizTypeScriptWorker extends TypeScriptWorker {
  public vizTypesAt(
    fileName: string,
    ranges: ReadonlyArray<SourceRange>
  ): Array<TypeInfo | undefined> {
    const service = (
      this as unknown as { _languageService: TS.LanguageService }
    )._languageService;
    const program = service.getProgram();
    return program
      ? checkerTypesAt(ts.typescript, program, fileName, ranges)
      : ranges.map(() => undefined);
  }
}

// Replaces the handler Monaco's entry installed when it was imported.
// eslint-disable-next-line unicorn/prefer-add-event-listener -- must replace it
self.onmessage = (): void => {
  initialize((ctx, createData) => new VizTypeScriptWorker(ctx, createData));
};
