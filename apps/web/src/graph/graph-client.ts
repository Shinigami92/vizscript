import type {
  GraphDocument,
  GraphOp,
  ImportedDeclaration,
  ModuleReference,
  OpResult,
  TypeSystemInfo,
} from '@vizscript/core';
import type { WorkerRequest, WorkerResponse } from './protocol';

type Pending = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Talks to the parsing worker so large files never block the UI thread.
 */
export class GraphClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  public constructor() {
    this.worker = new Worker(new URL('./graph.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse>) => {
        const pending = this.pending.get(event.data.id);
        this.pending.delete(event.data.id);
        pending?.resolve(event.data);
      }
    );
    this.worker.addEventListener('error', (event) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(event.message));
      }

      this.pending.clear();
    });
  }

  private send(
    request: DistributiveOmit<WorkerRequest, 'id'>
  ): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  public async parse(
    text: string,
    fileName: string,
    imports?: ImportedDeclaration[]
  ): Promise<GraphDocument> {
    const response = await this.send({
      type: 'parse',
      text,
      fileName,
      imports,
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    if (!('doc' in response)) {
      throw new Error('Unexpected worker response');
    }

    return response.doc;
  }

  /** Files referenced by the source (imports, resource paths). */
  public async references(
    text: string,
    fileName: string
  ): Promise<ModuleReference[]> {
    const response = await this.send({ type: 'references', text, fileName });
    if (!response.ok || !('references' in response)) {
      return [];
    }

    return response.references;
  }

  /** Types and modifiers of the file's language (for the Details panel). */
  public async typeSystem(fileName: string): Promise<TypeSystemInfo | null> {
    const response = await this.send({ type: 'typeSystem', fileName });
    return response.ok && 'typeSystem' in response ? response.typeSystem : null;
  }

  public async applyOp(
    text: string,
    fileName: string,
    op: GraphOp,
    imports?: ImportedDeclaration[]
  ): Promise<OpResult> {
    const response = await this.send({
      type: 'applyOp',
      text,
      fileName,
      op,
      imports,
    });
    if (!response.ok) {
      return { ok: false, error: response.error };
    }

    if (!('result' in response)) {
      throw new Error('Unexpected worker response');
    }

    return response.result;
  }

  public dispose(): void {
    this.worker.terminate();
  }
}
