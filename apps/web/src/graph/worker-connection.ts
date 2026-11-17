import type {
  WorkerCall,
  WorkerCalls,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

/** What the connection needs of a `Worker` (tests pass a fake). */
export interface WorkerLike {
  postMessage: (message: WorkerRequest) => void;
  terminate: () => void;
  addEventListener: (
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent<WorkerResponse> | ErrorEvent) => void
  ) => void;
}

/** A queued request was replaced by a newer one, or its client is gone. */
export class CancelledError extends Error {
  public constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError;
}

export interface CallOptions {
  /** `low` waits for every `high` one (library and npm declarations). */
  priority?: 'high' | 'low';
  /**
   * A queued request of the same owner with the same key is replaced (only
   * the newest parse of an editor's text matters).
   */
  key?: string;
  /** Who asked, so a closed workspace drops what it still waits for. */
  owner?: object;
}

interface Job {
  id: number;
  request: WorkerRequest;
  priority: 'high' | 'low';
  key?: string;
  owner?: object;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * One parsing worker shared by every workspace. Requests are queued here and
 * sent one at a time, so newer ones can replace queued ones and library
 * parses wait for the ones the user is waiting for. A worker that fails or
 * hangs is replaced by a new one; after `maxRestarts` failures in a row (it
 * can't even start, e.g. after a redeploy) every request fails with a hint
 * to reload.
 */
export class WorkerConnection {
  private worker: WorkerLike | null = null;
  private readonly queue: Job[] = [];
  private current: Job | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  /** Workers that failed before answering anything, in a row. */
  private failures = 0;
  private answered = false;

  public constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly options: { timeoutMs?: number; maxRestarts?: number } = {}
  ) {}

  public call<K extends WorkerCall>(
    type: K,
    request: WorkerCalls[K]['request'],
    options: CallOptions = {}
  ): Promise<WorkerCalls[K]['response']> {
    return new Promise((resolve, reject) => {
      if (options.key !== undefined) {
        // Only the newest request of a key is worth running.
        for (const job of this.queue.filter(
          (j) => j.key === options.key && j.owner === options.owner
        )) {
          this.drop(job, new CancelledError('Replaced by a newer request'));
        }
      }

      const id = this.nextId++;
      this.queue.push({
        id,
        request: { ...request, type, id } as WorkerRequest,
        priority: options.priority ?? 'high',
        ...(options.key === undefined ? {} : { key: options.key }),
        ...(options.owner ? { owner: options.owner } : {}),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /** Drops the queued requests of `owner` (a closed workspace). */
  public cancel(owner: object): void {
    for (const job of this.queue.filter((j) => j.owner === owner)) {
      this.drop(job, new CancelledError('The workspace was closed'));
    }
  }

  private drop(job: Job, error: Error): void {
    const at = this.queue.indexOf(job);
    if (at !== -1) {
      this.queue.splice(at, 1);
    }

    job.reject(error);
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) {
      return;
    }

    if (this.failures > (this.options.maxRestarts ?? 3)) {
      for (const job of this.queue.splice(0)) {
        job.reject(
          new Error('The parser could not start. Reload the page to retry.')
        );
      }

      return;
    }

    const at = this.queue.findIndex((j) => j.priority === 'high');
    const [job] = this.queue.splice(at === -1 ? 0 : at, 1);
    if (!job) {
      return;
    }

    this.current = job;
    const worker = this.ensureWorker();
    this.timer = setTimeout(
      () => this.fail('The parser took too long and was restarted.'),
      this.options.timeoutMs ?? 60_000
    );
    worker.postMessage(job.request);
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) {
      return this.worker;
    }

    const worker = this.createWorker();
    this.answered = false;
    worker.addEventListener('message', (event) => {
      if (worker !== this.worker) {
        return;
      }

      this.answered = true;
      this.failures = 0;
      this.settle((event as MessageEvent<WorkerResponse>).data);
    });
    const onError = (
      event: MessageEvent<WorkerResponse> | ErrorEvent
    ): void => {
      if (worker === this.worker) {
        this.fail(
          'message' in event &&
            typeof event.message === 'string' &&
            event.message
            ? `The parser failed: ${event.message}`
            : 'The parser failed.'
        );
      }
    };
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onError);
    this.worker = worker;
    return worker;
  }

  private settle(response: WorkerResponse): void {
    const job = this.current;
    if (!job || job.id !== response.id) {
      return;
    }

    clearTimeout(this.timer);
    this.current = null;
    if (response.ok) {
      job.resolve(response.value);
    } else {
      job.reject(new Error(response.error));
    }

    this.pump();
  }

  /** The worker broke or hangs: its request fails, a new worker follows. */
  private fail(message: string): void {
    clearTimeout(this.timer);
    if (!this.answered) {
      this.failures++;
    }

    this.worker?.terminate();
    this.worker = null;
    const job = this.current;
    this.current = null;
    job?.reject(new Error(message));
    this.pump();
  }
}
