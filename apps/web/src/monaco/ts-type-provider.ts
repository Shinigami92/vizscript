import type { SourceRange, TypeInfo, TypeProvider } from '@vizscript/core';
import * as monaco from 'monaco-editor';
import { modelUri } from './models';

interface VizWorker {
  vizTypesAt(
    fileName: string,
    ranges: ReadonlyArray<SourceRange>
  ): Promise<Array<TypeInfo | undefined>>;
  vizTypesAtText(
    fileName: string,
    text: string,
    ranges: ReadonlyArray<SourceRange>
  ): Promise<Array<TypeInfo | undefined>>;
}

/**
 * Types from TypeScript's checker for another text of a file open in an
 * editor (a copy with graph-only nodes written into it).
 */
export const typescriptTypesInText: TypeProvider = {
  async typesAt(text, fileName, ranges) {
    const uri = modelUri(fileName);
    const worker = await workerFor(uri);
    return worker
      ? worker.vizTypesAtText(uri.toString(), text, ranges)
      : ranges.map(() => undefined);
  },
};

async function workerFor(uri: monaco.Uri): Promise<VizWorker | undefined> {
  const model = monaco.editor.getModel(uri);
  if (!model) {
    return undefined;
  }

  const ts = monaco.typescript;
  const getWorker =
    model.getLanguageId() === 'javascript'
      ? await ts.getJavaScriptWorker()
      : await ts.getTypeScriptWorker();
  return (await getWorker(uri)) as unknown as VizWorker;
}

/**
 * Types from TypeScript's checker in Monaco's worker (`ts-worker.ts`), for
 * the file open in an editor. It answers only while the editor holds the
 * same text, so the ranges fit.
 */
export const typescriptTypes: TypeProvider = {
  async typesAt(text, fileName, ranges) {
    const uri = modelUri(fileName);
    const worker =
      monaco.editor.getModel(uri)?.getValue() === text
        ? await workerFor(uri)
        : undefined;
    return worker
      ? worker.vizTypesAt(uri.toString(), ranges)
      : ranges.map(() => undefined);
  },
};

/**
 * Calls `listener` when the files the checker sees change (imported files
 * and npm declarations arrived), after the worker had time to get them.
 */
export function onCheckerFilesChange(listener: () => void): monaco.IDisposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ts = monaco.typescript;
  const changed = (): void => {
    clearTimeout(timer);
    timer = setTimeout(listener, 150);
  };
  const subscriptions = [
    ts.typescriptDefaults.onDidExtraLibsChange(changed),
    ts.javascriptDefaults.onDidExtraLibsChange(changed),
  ];
  return {
    dispose: () => {
      clearTimeout(timer);
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
