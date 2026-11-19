import type { ComputedRef } from 'vue';
import { computed, reactive } from 'vue';

/** Work the user waits for is shown once it takes longer than this. */
export const SLOW_TASK_MS = 2000;

interface Task {
  id: number;
  label: string;
  slow: boolean;
}

const tasks = reactive<Task[]>([]);
let nextId = 1;

/**
 * Tracks work that runs in the background (reading the file list, the
 * imports, library types): the status bar names it once it takes longer
 * than {@link SLOW_TASK_MS}. Returns `work`.
 */
export function trackTask<T>(label: string, work: Promise<T>): Promise<T> {
  const id = nextId++;
  tasks.push({ id, label, slow: false });
  const timer = setTimeout(() => {
    const task = tasks.find((t) => t.id === id);
    if (task) {
      task.slow = true;
    }
  }, SLOW_TASK_MS);
  void (async (): Promise<void> => {
    try {
      await work;
    } catch {
      // The caller handles it; the task is over either way.
    } finally {
      clearTimeout(timer);
      const index = tasks.findIndex((t) => t.id === id);
      if (index !== -1) {
        tasks.splice(index, 1);
      }
    }
  })();
  return work;
}

/** Labels of the tasks that take long, oldest first, each once. */
export function useSlowTasks(): ComputedRef<string[]> {
  return computed(() => [
    ...new Set(tasks.filter((t) => t.slow).map((t) => t.label)),
  ]);
}
