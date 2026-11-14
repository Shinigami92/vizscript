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

  /**
   * Types at ranges of another text of the file (a copy with new code, for
   * graph-only nodes): a program with that text, reusing the others.
   */
  public vizTypesAtText(
    fileName: string,
    text: string,
    ranges: ReadonlyArray<SourceRange>
  ): Array<TypeInfo | undefined> {
    const service = (
      this as unknown as { _languageService: TS.LanguageService }
    )._languageService;
    const program = service.getProgram();
    const original = program?.getSourceFile(fileName);
    if (!program || !original) {
      return ranges.map(() => undefined);
    }

    const t = ts.typescript;
    // The default library as the program has it (Monaco names it).
    const defaultLib =
      program
        .getSourceFiles()
        .find((file) => program.isSourceFileDefaultLibrary(file))?.fileName ??
      t.getDefaultLibFileName(program.getCompilerOptions());
    const replaced = t.createSourceFile(
      fileName,
      text,
      original.languageVersion,
      true
    );
    const host: TS.CompilerHost = {
      getSourceFile: (name) =>
        name === fileName ? replaced : program.getSourceFile(name),
      getDefaultLibFileName: () => defaultLib,
      writeFile: () => undefined,
      getCurrentDirectory: () => program.getCurrentDirectory(),
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (name) =>
        name === fileName || program.getSourceFile(name) !== undefined,
      readFile: (name) =>
        name === fileName ? text : program.getSourceFile(name)?.text,
    };
    const next = t.createProgram({
      rootNames: program.getRootFileNames(),
      options: program.getCompilerOptions(),
      host,
      oldProgram: program,
    });
    return checkerTypesAt(t, next, fileName, ranges);
  }
}

// Replaces the handler Monaco's entry installed when it was imported.
// eslint-disable-next-line unicorn/prefer-add-event-listener -- must replace it
self.onmessage = (): void => {
  initialize((ctx, createData) => new VizTypeScriptWorker(ctx, createData));
};
