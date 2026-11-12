import type { OpResult, TextEdit } from './ops';

export function failed(error: string): OpResult {
  return { ok: false, error };
}

export function succeeded(edits: TextEdit[]): OpResult {
  return { ok: true, edits };
}
