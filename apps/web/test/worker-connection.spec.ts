import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from '../src/graph/protocol';
import type { WorkerLike } from '../src/graph/worker-connection';
import { isCancelled, WorkerConnection } from '../src/graph/worker-connection';

type Listener = (event: MessageEvent<WorkerResponse> | ErrorEvent) => void;

/** A worker the test answers by hand. */
class FakeWorker implements WorkerLike {
  public readonly posted: WorkerRequest[] = [];
  public terminated = false;
  private readonly listeners = new Map<string, Listener[]>();

  public postMessage(message: WorkerRequest): void {
    this.posted.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Answers the last request it got. */
  public answer(value: unknown): void {
    const id = this.posted.at(-1)?.id ?? 0;
    for (const listener of this.listeners.get('message') ?? []) {
      listener({
        data: { id, ok: true, value },
      } as MessageEvent<WorkerResponse>);
    }
  }

  public crash(message = 'boom'): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener({ message } as ErrorEvent);
    }
  }
}

function setup(options: { timeoutMs?: number; maxRestarts?: number } = {}): {
  connection: WorkerConnection;
  workers: FakeWorker[];
  /** The worker that is running now. */
  worker: () => FakeWorker;
} {
  const workers: FakeWorker[] = [];
  const connection = new WorkerConnection(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, options);
  return {
    connection,
    workers,
    worker: () => workers.at(-1) as FakeWorker,
  };
}

/** Lets resolved promises run their callbacks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

const parse = (text: string) => ({ text, fileName: 'a.ts' });

describe('worker connection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends one request at a time, the user’s before library ones', async () => {
    const { connection, worker } = setup();
    const results: string[] = [];
    void connection
      .call('parse', parse('first'))
      .then(() => results.push('first'));
    void connection
      .call('parse', parse('library'), { priority: 'low' })
      .then(() => results.push('library'));
    void connection
      .call('parse', parse('typed'))
      .then(() => results.push('typed'));

    expect(worker().posted.map((r) => (r as { text: string }).text)).toEqual([
      'first',
    ]);
    worker().answer(null);
    await settle();
    worker().answer(null);
    await settle();
    worker().answer(null);
    await settle();
    expect(results).toEqual(['first', 'typed', 'library']);
  });

  it('replaces a queued request of the same owner and key', async () => {
    const { connection, worker } = setup();
    const a = {};
    const b = {};
    void connection.call('parse', parse('busy'));
    const old = connection.call('parse', parse('old'), {
      key: 'editor',
      owner: a,
    });
    const other = connection.call('parse', parse('other'), {
      key: 'editor',
      owner: b,
    });
    const next = connection.call('parse', parse('new'), {
      key: 'editor',
      owner: a,
    });

    await expect(old).rejects.toSatisfy(isCancelled);
    for (let i = 0; i < 3; i++) {
      worker().answer((worker().posted.at(-1) as { text: string }).text);
      await settle();
    }

    await expect(next).resolves.toBe('new');
    await expect(other).resolves.toBe('other');
  });

  it('drops what a closed workspace still waits for', async () => {
    const { connection, worker } = setup();
    const owner = {};
    const running = connection.call('parse', parse('running'), { owner });
    const queued = connection.call('parse', parse('queued'), { owner });
    connection.cancel(owner);
    await expect(queued).rejects.toSatisfy(isCancelled);
    worker().answer('done');
    await expect(running).resolves.toBe('done');
  });

  it('starts a new worker after a crash and goes on with the queue', async () => {
    const { connection, workers, worker } = setup();
    const crashed = connection.call('parse', parse('a'));
    const waiting = connection.call('parse', parse('b'));
    worker().crash('chunk failed');
    await expect(crashed).rejects.toThrow('The parser failed: chunk failed');
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    worker().answer('b done');
    await expect(waiting).resolves.toBe('b done');
  });

  it('restarts a worker that hangs', async () => {
    const { connection, workers, worker } = setup({ timeoutMs: 1000 });
    const hung = connection.call('parse', parse('slow'));
    const next = connection.call('parse', parse('next'));
    vi.advanceTimersByTime(1001);
    await expect(hung).rejects.toThrow('took too long');
    expect(workers).toHaveLength(2);
    worker().answer('ok');
    await expect(next).resolves.toBe('ok');
  });

  it('gives up when new workers keep failing before they answer', async () => {
    const { connection, workers, worker } = setup({ maxRestarts: 2 });
    const calls = [1, 2, 3, 4, 5].map((i) =>
      connection.call('parse', parse(String(i))).catch((e: Error) => e.message)
    );
    for (let i = 0; i < 3; i++) {
      worker().crash();
      await settle();
    }

    const messages = await Promise.all(calls);
    expect(workers).toHaveLength(3);
    expect(messages.at(-1)).toContain('Reload the page');
  });
});
