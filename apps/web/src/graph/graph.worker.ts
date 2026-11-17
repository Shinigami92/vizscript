import { floatingNodes, resolveOverlay } from '@vizscript/core';
import type {
  WorkerCall,
  WorkerCalls,
  WorkerRequest,
  WorkerResponse,
} from './protocol';
/// <reference lib="webworker" />
import { registry } from './registry';

type Backend = NonNullable<ReturnType<typeof registry.forFile>>;

/** The answer of each call, from the file's language backend. */
const HANDLERS: {
  [K in WorkerCall]: (
    request: WorkerCalls[K]['request'],
    backend: Backend
  ) => WorkerCalls[K]['response'];
} = {
  parse: (r, backend) =>
    backend.parse(r.text, r.fileName, { imports: r.imports }),
  references: (r, backend) => backend.references?.(r.text, r.fileName) ?? [],
  typeSystem: (_r, backend) => backend.typeSystem ?? null,
  library: (r, backend) => ({
    modules: backend.libraries ?? [],
    stub: r.module ? (backend.library?.(r.module) ?? null) : null,
  }),
  prepareLibrary: (r, backend) =>
    backend.prepareLibrary?.(r.text, r.version) ?? r.text,
  versionFiles: (_r, backend) => backend.versionFiles ?? [],
  version: (r, backend) => backend.version?.(r.files) ?? null,
  applyOp: (r, backend) =>
    backend.applyOp(r.text, r.op, r.fileName, {
      imports: r.imports,
      checked: r.checked,
    }),
  resolveOverlay: (r, backend) => {
    const options = { imports: r.imports };
    return resolveOverlay(r.text, r.overlay, {
      parse: (text) => backend.parse(text, r.fileName, options),
      applyOp: (text, op) => backend.applyOp(text, op, r.fileName, options),
    });
  },
  floatingNodes: (r, backend) => {
    const options = { imports: r.imports };
    return floatingNodes(r.text, r.template, r.fnId, r.group, {
      parse: (text) => backend.parse(text, r.fileName, options),
      applyOp: (text, op) => backend.applyOp(text, op, r.fileName, options),
    });
  },
};

function handle(request: WorkerRequest): WorkerResponse {
  const backend = registry.forFile(request.fileName);
  if (!backend) {
    return { id: request.id, ok: false, error: 'Unsupported language' };
  }

  const handler = HANDLERS[request.type] as (
    request: WorkerRequest,
    backend: Backend
  ) => unknown;
  return { id: request.id, ok: true, value: handler(request, backend) };
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  let response: WorkerResponse;
  try {
    response = handle(event.data);
  } catch (error) {
    response = {
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  self.postMessage(response);
});
