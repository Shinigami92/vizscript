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

/** Every call of the parsing worker: what it is sent and what it answers. */
export interface WorkerCalls {
  parse: {
    request: {
      text: string;
      fileName: string;
      /** Declarations of imported names (call pins, types). */
      imports?: ImportedDeclaration[];
    };
    response: GraphDocument;
  };
  references: {
    request: { text: string; fileName: string };
    response: ModuleReference[];
  };
  typeSystem: {
    request: { fileName: string };
    response: TypeSystemInfo | null;
  };
  library: {
    request: { fileName: string; module?: string };
    /** Known library modules, and the stub of `module` if asked for. */
    response: {
      modules: ReadonlyArray<string>;
      stub: { text: string; fileName: string } | null;
    };
  };
  prepareLibrary: {
    request: { fileName: string; text: string; version?: string };
    /** The declaration file ready for the parser. */
    response: string;
  };
  versionFiles: {
    request: { fileName: string };
    response: ReadonlyArray<string>;
  };
  version: {
    request: {
      fileName: string;
      /** The language's version files, nearest folder first. */
      files: ProjectFile[];
    };
    response: LanguageVersion | null;
  };
  applyOp: {
    request: {
      text: string;
      fileName: string;
      op: GraphOp;
      imports?: ImportedDeclaration[];
      checked?: ParseOptions['checked'];
    };
    response: OpResult;
  };
  resolveOverlay: {
    request: {
      text: string;
      fileName: string;
      overlay: GraphOverlay;
      imports?: ImportedDeclaration[];
    };
    response: OverlayResolution;
  };
  floatingNodes: {
    request: {
      text: string;
      fileName: string;
      template: NodeTemplate;
      /** Function the nodes belong to until they are wired in. */
      fnId?: string;
      /** Id of the group (`overlay:<group>/…` node ids). */
      group: string;
      imports?: ImportedDeclaration[];
    };
    response: FloatingResult;
  };
}

export type WorkerCall = keyof WorkerCalls;

export type WorkerRequest = {
  [K in WorkerCall]: { id: number; type: K } & WorkerCalls[K]['request'];
}[WorkerCall];

/** The answer to request `id`: its value, or why it failed. */
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
