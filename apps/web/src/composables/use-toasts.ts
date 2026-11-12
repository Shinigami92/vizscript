import { reactive } from 'vue';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

const toasts = reactive<Toast[]>([]);
let nextId = 1;

export function useToasts(): {
  toasts: Toast[];
  show: (message: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
} {
  function dismiss(id: number): void {
    const index = toasts.findIndex((t) => t.id === id);
    if (index !== -1) {
      toasts.splice(index, 1);
    }
  }

  function show(message: string, kind: Toast['kind'] = 'info'): void {
    const id = nextId++;
    toasts.push({ id, message, kind });
    setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
  }

  return { toasts, show, dismiss };
}
