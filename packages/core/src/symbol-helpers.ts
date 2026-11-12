import type { GraphDocument } from './ir';
import type { ScriptSymbol } from './symbols';

export function lineEndOf(text: string, offset: number): number {
  const end = text.indexOf('\n', offset);
  return end === -1 ? text.length : end;
}

export function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === '';
}

export function findSymbol(
  doc: GraphDocument,
  id: string
): ScriptSymbol | undefined {
  return doc.symbols?.find((s) => s.id === id);
}
