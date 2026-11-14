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

export type WorkerRequest =
  | {
      id: number;
      type: 'parse';
      text: string;
      fileName: string;
      /** Declarations of imported names (call pins, types). */
      imports?: ImportedDeclaration[];
    }
  | { id: number; type: 'references'; text: string; fileName: string }
  | { id: number; type: 'typeSystem'; fileName: string }
  | { id: number; type: 'library'; fileName: string; module?: string }
  | { id: number; type: 'versionFiles'; fileName: string }
  | {
      id: number;
      type: 'version';
      fileName: string;
      /** The language's version files, nearest folder first. */
      files: ProjectFile[];
    }
  | {
      id: number;
      type: 'applyOp';
      text: string;
      fileName: string;
      op: GraphOp;
      imports?: ImportedDeclaration[];
    }
  | {
      id: number;
      type: 'resolveOverlay';
      text: string;
      fileName: string;
      overlay: GraphOverlay;
      imports?: ImportedDeclaration[];
    }
  | {
      id: number;
      type: 'floatingNodes';
      text: string;
      fileName: string;
      template: NodeTemplate;
      /** Function the nodes belong to until they are wired in. */
      fnId?: string;
      /** Id of the group (`overlay:<group>/…` node ids). */
      group: string;
      imports?: ImportedDeclaration[];
    };

export type WorkerResponse =
  | { id: number; ok: true; doc: GraphDocument }
  | { id: number; ok: true; result: OpResult }
  | { id: number; ok: true; resolution: OverlayResolution }
  | { id: number; ok: true; floating: FloatingResult }
  | { id: number; ok: true; references: ModuleReference[] }
  | { id: number; ok: true; typeSystem: TypeSystemInfo | null }
  | { id: number; ok: true; versionFiles: ReadonlyArray<string> }
  | { id: number; ok: true; version: LanguageVersion | null }
  | {
      id: number;
      ok: true;
      /** Known library modules, and the stub of `module` if asked for. */
      library: {
        modules: ReadonlyArray<string>;
        stub: { text: string; fileName: string } | null;
      };
    }
  | { id: number; ok: false; error: string };
