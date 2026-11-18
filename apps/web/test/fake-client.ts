import type { GraphOp } from '@vizscript/core';
import { floatingNodes, resolveOverlay } from '@vizscript/core';
import { applyTypeScriptOp, parseTypeScript } from '@vizscript/lang-typescript';
import type { GraphClient } from '../src/graph/graph-client';

/**
 * The worker's answers, computed right away (TypeScript): what the
 * composables ask the graph client for.
 */
export function fakeClient(): GraphClient {
  const backend = {
    parse: (text: string) => parseTypeScript(text, 't.ts'),
    applyOp: (text: string, op: GraphOp) => applyTypeScriptOp(text, op, 't.ts'),
  };
  const client: Pick<
    GraphClient,
    'parse' | 'applyOp' | 'floatingNodes' | 'resolveOverlay'
  > = {
    parse: (text) => Promise.resolve(backend.parse(text)),
    applyOp: (text, _file, op) => Promise.resolve(backend.applyOp(text, op)),
    resolveOverlay: (text, _file, overlay) =>
      Promise.resolve(resolveOverlay(text, overlay, backend)),
    floatingNodes: (text, _file, template, fnId, group) =>
      Promise.resolve(floatingNodes(text, template, fnId, group, backend)),
  };
  return client as GraphClient;
}

/** Lets pending promises (the composables' async work) finish. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}
