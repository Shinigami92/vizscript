import type {
  GraphDocument,
  GraphOp,
  ImportedDeclaration,
  ModuleReference,
  OpResult,
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
  | {
      id: number;
      type: 'applyOp';
      text: string;
      fileName: string;
      op: GraphOp;
      imports?: ImportedDeclaration[];
    };

export type WorkerResponse =
  | { id: number; ok: true; doc: GraphDocument }
  | { id: number; ok: true; result: OpResult }
  | { id: number; ok: true; references: ModuleReference[] }
  | { id: number; ok: true; typeSystem: TypeSystemInfo | null }
  | { id: number; ok: false; error: string };
