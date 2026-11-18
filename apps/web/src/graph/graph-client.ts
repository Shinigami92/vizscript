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
  ParseOptions,
  ProjectFile,
  TypeSystemInfo,
} from '@vizscript/core';
import type { WorkerCall, WorkerCalls } from './protocol';
import type { CallOptions } from './worker-connection';
import { WorkerConnection } from './worker-connection';

let shared: WorkerConnection | undefined;

/** The parsing worker of the page, started on first use. */
function connection(): WorkerConnection {
  shared ??= new WorkerConnection(
    () =>
      new Worker(new URL('./graph.worker.ts', import.meta.url), {
        type: 'module',
      })
  );
  return shared;
}

/** How a parse is scheduled: library parses wait, editor parses replace. */
export interface ParseSchedule {
  /** Library and npm declarations, the saved version: after the rest. */
  background?: boolean;
  /** A queued parse with the same key is replaced by this one. */
  key?: string;
}

/**
 * Talks to the parsing worker so large files never block the UI thread.
 * Every workspace has its own client; they share one worker, and a closed
 * workspace's client drops what it still waits for (`dispose`).
 */
export class GraphClient {
  private readonly connection: WorkerConnection;

  public constructor(worker?: WorkerConnection) {
    this.connection = worker ?? connection();
  }

  private send<K extends WorkerCall>(
    type: K,
    request: WorkerCalls[K]['request'],
    options: Omit<CallOptions, 'owner'> = {}
  ): Promise<WorkerCalls[K]['response']> {
    return this.connection.call(type, request, { ...options, owner: this });
  }

  public parse(
    text: string,
    fileName: string,
    imports?: ImportedDeclaration[],
    schedule: ParseSchedule = {}
  ): Promise<GraphDocument> {
    return this.send(
      'parse',
      { text, fileName, imports },
      {
        ...(schedule.background ? { priority: 'low' as const } : {}),
        ...(schedule.key === undefined ? {} : { key: schedule.key }),
      }
    );
  }

  /** Files referenced by the source (imports, resource paths). */
  public references(
    text: string,
    fileName: string
  ): Promise<ModuleReference[]> {
    return this.send('references', { text, fileName }).catch(() => []);
  }

  /** Types and modifiers of the file's language (for the Details panel). */
  public typeSystem(fileName: string): Promise<TypeSystemInfo | null> {
    return this.send('typeSystem', { fileName }).catch(() => null);
  }

  /**
   * A library declaration file read from elsewhere, ready for the parser
   * (Python: a typeshed stub for `version`).
   */
  public prepareLibrary(
    fileName: string,
    text: string,
    version?: string
  ): Promise<string> {
    return this.send(
      'prepareLibrary',
      { fileName, text, ...(version ? { version } : {}) },
      { priority: 'low' }
    );
  }

  /** Names of the project files that state the language's version. */
  public versionFiles(fileName: string): Promise<ReadonlyArray<string>> {
    return this.send('versionFiles', { fileName }).catch(() => []);
  }

  /** The language version stated by `files` (nearest folder first). */
  public version(
    fileName: string,
    files: ProjectFile[]
  ): Promise<LanguageVersion | null> {
    return this.send('version', { fileName, files }).catch(() => null);
  }

  /**
   * Library modules the language knows (Python's standard library), with
   * the stub of `module` (declarations in the language itself).
   */
  public library(
    fileName: string,
    module?: string
  ): Promise<WorkerCalls['library']['response']> {
    return this.send(
      'library',
      { fileName, module },
      { priority: 'low' }
    ).catch(() => ({ modules: [], stub: null }));
  }

  public applyOp(
    text: string,
    fileName: string,
    op: GraphOp,
    imports?: ImportedDeclaration[],
    checked?: ParseOptions['checked']
  ): Promise<OpResult> {
    return this.send('applyOp', {
      text,
      fileName,
      // Plain data for the worker (`inFloating` carries reactive state).
      op: JSON.parse(JSON.stringify(op)) as GraphOp,
      imports,
      checked,
    }).catch((error: Error): OpResult => ({ ok: false, error: error.message }));
  }

  /**
   * Writes graph-only edits as code once the graph is valid again
   * (`resolveOverlay` in core, with the file's backend).
   */
  public resolveOverlay(
    text: string,
    fileName: string,
    overlay: GraphOverlay,
    imports?: ImportedDeclaration[]
  ): Promise<OverlayResolution> {
    return this.send('resolveOverlay', {
      text,
      fileName,
      // Plain data for the worker (the overlay may come from reactive state).
      overlay: JSON.parse(JSON.stringify(overlay)) as GraphOverlay,
      imports,
    }).catch((error: Error): OverlayResolution => ({
      status: 'pending',
      issues: [{ node: '', message: error.message }],
    }));
  }

  /**
   * Nodes for a template that has no place in the code yet: they float in
   * the graph until they are wired in (`floatingNodes` in core).
   */
  public floatingNodes(
    text: string,
    fileName: string,
    template: NodeTemplate,
    fnId: string | undefined,
    group: string,
    imports?: ImportedDeclaration[]
  ): Promise<FloatingResult> {
    return this.send('floatingNodes', {
      text,
      fileName,
      template: JSON.parse(JSON.stringify(template)) as NodeTemplate,
      fnId,
      group,
      imports,
    }).catch((error: Error): FloatingResult => ({
      ok: false,
      error: error.message,
    }));
  }

  /** The workspace is closed: what it still waits for is dropped. */
  public dispose(): void {
    this.connection.cancel(this);
  }
}
