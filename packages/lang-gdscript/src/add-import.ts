import type {
  DeclarationSyntax,
  GraphDocument,
  ImportRequest,
  OpResult,
} from '@vizscript/core';
import { insertImport } from '@vizscript/core';

/**
 * `const Name = preload("res://path.gd")`: a script of the project, below
 * the other preloads (or `extends`). Godot's `res://` is the folder of
 * `project.godot` (`request.root`).
 */
export function addGDScriptImport(
  text: string,
  doc: GraphDocument,
  request: ImportRequest,
  syntax: DeclarationSyntax
): OpResult {
  const root = request.root ?? '';
  const path =
    root && request.path.startsWith(`${root}/`)
      ? request.path.slice(root.length + 1)
      : request.path;
  const line = `const ${request.name} = preload("res://${path}")`;
  return { ok: true, edits: [insertImport(text, doc, syntax, line)] };
}
