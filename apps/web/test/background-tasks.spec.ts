import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOW_TASK_MS,
  trackTask,
  useBusy,
  useSlowTasks,
} from '../src/composables/use-background-tasks';

/** Work that ends when `finish` is called. */
function pending(): { work: Promise<void>; finish: () => void } {
  const ends: Array<() => void> = [];
  const work = new Promise<void>((resolve) => {
    ends.push(resolve);
  });
  return { work, finish: () => ends.forEach((end) => end()) };
}

describe('background tasks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names work only once it takes long, until it is done', async () => {
    const slow = useSlowTasks();
    const { work, finish } = pending();
    void trackTask('Loading library types', work);
    void trackTask('Reading imports', Promise.resolve());
    await vi.advanceTimersByTimeAsync(SLOW_TASK_MS - 1);
    expect(slow.value).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(slow.value).toEqual(['Loading library types']);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.value).toEqual([]);
  });

  it('ends failed work too, and hands back its result', async () => {
    const slow = useSlowTasks();
    const failing = trackTask('Opening a.ts', Promise.reject(new Error('x')));
    await expect(failing).rejects.toThrow('x');
    await vi.advanceTimersByTimeAsync(SLOW_TASK_MS);
    expect(slow.value).toEqual([]);
    await expect(trackTask('Opening b.ts', Promise.resolve(1))).resolves.toBe(
      1
    );
  });
});

describe('useBusy', () => {
  it('is busy while any of its work runs, without a delay', async () => {
    const { busy, run } = useBusy();
    const first = pending();
    const second = pending();
    void run(first.work);
    void run(second.work).catch(() => undefined);
    expect(busy.value).toBe(true);
    first.finish();
    await first.work;
    await Promise.resolve();
    expect(busy.value).toBe(true);
    second.finish();
    await second.work;
    await Promise.resolve();
    expect(busy.value).toBe(false);
  });
});
