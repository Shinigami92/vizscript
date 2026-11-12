import type {
  GraphDocument,
  GraphOp,
  ModuleReference,
  OpResult,
} from '@vizscript/core';

export type WorkerRequest =
  | { id: number; type: 'parse'; text: string; fileName: string }
  | { id: number; type: 'references'; text: string; fileName: string }
  | {
      id: number;
      type: 'applyOp';
      text: string;
      fileName: string;
      op: GraphOp;
    };

export type WorkerResponse =
  | { id: number; ok: true; doc: GraphDocument }
  | { id: number; ok: true; result: OpResult }
  | { id: number; ok: true; references: ModuleReference[] }
  | { id: number; ok: false; error: string };
