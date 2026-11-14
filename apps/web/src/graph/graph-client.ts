import type {
  FloatingResult,
  GraphDocument,
  GraphOp,
  GraphOverlay,
  ImportedDeclaration,
  LanguageVersion,
  ModuleReference,
  NodeTemplate,
  OpResult,
  OverlayResolution,
  ProjectFile,
  TypeSystemInfo,
} from '@vizscript/core';
import type { WorkerRequest, WorkerResponse } from './protocol';

type Pending = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Talks to the parsing worker so large files never block the UI thread.
 */
export class GraphClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  public constructor() {
    this.worker = new Worker(new URL('./graph.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse>) => {
        const pending = this.pending.get(event.data.id);
        this.pending.delete(event.data.id);
        pending?.resolve(event.data);
      }
    );
    this.worker.addEventListener('error', (event) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(event.message));
      }

      this.pending.clear();
    });
  }

  private send(
    request: DistributiveOmit<WorkerRequest, 'id'>
  ): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  public async parse(
    text: string,
    fileName: string,
    imports?: ImportedDeclaration[]
  ): Promise<GraphDocument> {
    const response = await this.send({
      type: 'parse',
      text,
      fileName,
      imports,
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    if (!('doc' in response)) {
      throw new Error('Unexpected worker response');
    }

    return response.doc;
  }

  /** Files referenced by the source (imports, resource paths). */
  public async references(
    text: string,
    fileName: string
  ): Promise<ModuleReference[]> {
    const response = await this.send({ type: 'references', text, fileName });
    if (!response.ok || !('references' in response)) {
      return [];
    }

    return response.references;
  }

  /** Types and modifiers of the file's language (for the Details panel). */
  public async typeSystem(fileName: string): Promise<TypeSystemInfo | null> {
    const response = await this.send({ type: 'typeSystem', fileName });
    return response.ok && 'typeSystem' in response ? response.typeSystem : null;
  }

  /** Names of the project files that state the language's version. */
  public async versionFiles(fileName: string): Promise<ReadonlyArray<string>> {
    const response = await this.send({ type: 'versionFiles', fileName });
    return response.ok && 'versionFiles' in response
      ? response.versionFiles
      : [];
  }

  /** The language version stated by `files` (nearest folder first). */
  public async version(
    fileName: string,
    files: ProjectFile[]
  ): Promise<LanguageVersion | null> {
    const response = await this.send({ type: 'version', fileName, files });
    return response.ok && 'version' in response ? response.version : null;
  }

  /**
   * Library modules the language knows (Python's standard library), with
   * the stub of `module` (declarations in the language itself).
   */
  public async library(
    fileName: string,
    module?: string
  ): Promise<{
    modules: ReadonlyArray<string>;
    stub: { text: string; fileName: string } | null;
  }> {
    const response = await this.send({ type: 'library', fileName, module });
    return response.ok && 'library' in response
      ? response.library
      : { modules: [], stub: null };
  }

  public async applyOp(
    text: string,
    fileName: string,
    op: GraphOp,
    imports?: ImportedDeclaration[]
  ): Promise<OpResult> {
    const response = await this.send({
      type: 'applyOp',
      text,
      fileName,
      op,
      imports,
    });
    if (!response.ok) {
      return { ok: false, error: response.error };
    }

    if (!('result' in response)) {
      throw new Error('Unexpected worker response');
    }

    return response.result;
  }

  /**
   * Writes graph-only edits as code once the graph is valid again
   * (`resolveOverlay` in core, with the file's backend).
   */
  public async resolveOverlay(
    text: string,
    fileName: string,
    overlay: GraphOverlay,
    imports?: ImportedDeclaration[]
  ): Promise<OverlayResolution> {
    const response = await this.send({
      type: 'resolveOverlay',
      text,
      fileName,
      // Plain data for the worker (the overlay may come from reactive state).
      overlay: JSON.parse(JSON.stringify(overlay)) as GraphOverlay,
      imports,
    });
    if (!response.ok) {
      return {
        status: 'pending',
        issues: [{ node: '', message: response.error }],
      };
    }

    if (!('resolution' in response)) {
      throw new Error('Unexpected worker response');
    }

    return response.resolution;
  }

  /**
   * Nodes for a template that has no place in the code yet: they float in
   * the graph until they are wired in (`floatingNodes` in core).
   */
  public async floatingNodes(
    text: string,
    fileName: string,
    template: NodeTemplate,
    fnId: string | undefined,
    group: string,
    imports?: ImportedDeclaration[]
  ): Promise<FloatingResult> {
    const response = await this.send({
      type: 'floatingNodes',
      text,
      fileName,
      template: JSON.parse(JSON.stringify(template)) as NodeTemplate,
      fnId,
      group,
      imports,
    });
    if (!response.ok) {
      return { ok: false, error: response.error };
    }

    if (!('floating' in response)) {
      throw new Error('Unexpected worker response');
    }

    return response.floating;
  }

  public dispose(): void {
    this.worker.terminate();
  }
}
