/**
 * Monaco's TypeScript worker entry ships no types: the parts `ts-worker.ts`
 * extends.
 */
declare module 'monaco-editor/language/typescript/ts.worker' {
  import type * as TS from 'typescript';

  export class TypeScriptWorker {
    public constructor(ctx: unknown, createData: unknown);
  }

  /** Starts the worker with the object whose methods it serves. */
  export function initialize(
    create: (ctx: unknown, createData: unknown) => unknown
  ): void;

  /** Monaco's build of TypeScript (5.9): the whole API as `typescript`. */
  export const ts: { typescript: typeof TS };
}
