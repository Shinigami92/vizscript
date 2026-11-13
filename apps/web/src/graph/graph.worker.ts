import { resolveOverlay } from '@vizscript/core';
import type { WorkerRequest, WorkerResponse } from './protocol';
/// <reference lib="webworker" />
import { registry } from './registry';

function handle(request: WorkerRequest): WorkerResponse {
  const backend = registry.forFile(request.fileName);
  if (!backend) {
    return { id: request.id, ok: false, error: 'Unsupported language' };
  }

  switch (request.type) {
    case 'parse': {
      return {
        id: request.id,
        ok: true,
        doc: backend.parse(request.text, request.fileName, {
          imports: request.imports,
        }),
      };
    }

    case 'references': {
      return {
        id: request.id,
        ok: true,
        references: backend.references?.(request.text, request.fileName) ?? [],
      };
    }

    case 'typeSystem': {
      return {
        id: request.id,
        ok: true,
        typeSystem: backend.typeSystem ?? null,
      };
    }

    case 'library': {
      return {
        id: request.id,
        ok: true,
        library: {
          modules: backend.libraries ?? [],
          stub: request.module
            ? (backend.library?.(request.module) ?? null)
            : null,
        },
      };
    }

    case 'applyOp': {
      return {
        id: request.id,
        ok: true,
        result: backend.applyOp(request.text, request.op, request.fileName, {
          imports: request.imports,
        }),
      };
    }

    case 'resolveOverlay': {
      const options = { imports: request.imports };
      return {
        id: request.id,
        ok: true,
        resolution: resolveOverlay(request.text, request.overlay, {
          parse: (text) => backend.parse(text, request.fileName, options),
          applyOp: (text, op) =>
            backend.applyOp(text, op, request.fileName, options),
        }),
      };
    }
  }
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
