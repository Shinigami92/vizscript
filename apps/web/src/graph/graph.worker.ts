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
        doc: backend.parse(request.text, request.fileName),
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

    case 'applyOp': {
      return {
        id: request.id,
        ok: true,
        result: backend.applyOp(request.text, request.op, request.fileName),
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
