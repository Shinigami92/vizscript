import type { SourceRange, TypeInfo, TypeProvider } from '@vizscript/core';
import * as monaco from 'monaco-editor';
import { modelUri } from './models';

interface VizWorker {
  vizTypesAt(
    fileName: string,
    ranges: ReadonlyArray<SourceRange>
  ): Promise<Array<TypeInfo | undefined>>;
}

/**
 * Types from TypeScript's checker in Monaco's worker (`ts-worker.ts`), for
 * the file open in an editor. It answers only while the editor holds the
 * same text, so the ranges fit.
 */
export const typescriptTypes: TypeProvider = {
  async typesAt(text, fileName, ranges) {
    const uri = modelUri(fileName);
    const model = monaco.editor.getModel(uri);
    if (!model || model.getValue() !== text) {
      return ranges.map(() => undefined);
    }

    const ts = monaco.typescript;
    const getWorker =
      model.getLanguageId() === 'javascript'
        ? await ts.getJavaScriptWorker()
        : await ts.getTypeScriptWorker();
    const worker = (await getWorker(uri)) as unknown as VizWorker;
    return worker.vizTypesAt(uri.toString(), ranges);
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
