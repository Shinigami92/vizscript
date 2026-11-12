import type {
  GraphDocument,
  OpResult,
  ScriptSetting,
  TextEdit,
} from '@vizscript/core';
import { lineStart } from '@vizscript/core';
import type { Script, Stmt } from './ast';
import { parseGDScript } from './parser';

/** The header statements of a script: `@tool`, `class_name`, `extends`. */
function header(script: Script): {
  tool?: Stmt;
  className?: Extract<Stmt, { type: 'ClassName' }>;
  extendsStmt?: Extract<Stmt, { type: 'Extends' }>;
} {
  let tool: Stmt | undefined;
  let className: Extract<Stmt, { type: 'ClassName' }> | undefined;
  let extendsStmt: Extract<Stmt, { type: 'Extends' }> | undefined;
  for (const stmt of script.body) {
    if (stmt.type === 'Annotation' && stmt.annotation.name === 'tool') {
      tool ??= stmt;
    } else if (stmt.type === 'ClassName') {
      className ??= stmt;
    } else if (stmt.type === 'Extends') {
      extendsStmt ??= stmt;
    }
  }

  return {
    ...(tool ? { tool } : {}),
    ...(className ? { className } : {}),
    ...(extendsStmt ? { extendsStmt } : {}),
  };
}

/** The script's settings, like UE's Class Settings. */
export function gdscriptSettings(script: Script): ScriptSetting[] {
  const { tool, className, extendsStmt } = header(script);
  return [
    {
      id: 'tool',
      label: 'Tool (@tool)',
      kind: 'flag',
      value: tool ? 'true' : 'false',
    },
    {
      id: 'class_name',
      label: 'Class name',
      kind: 'text',
      value: className?.name ?? '',
      placeholder: 'Global name',
    },
    {
      id: 'extends',
      label: 'Extends',
      kind: 'text',
      value: extendsStmt?.target ?? '',
      placeholder: 'RefCounted',
    },
  ];
}

/** The line of a statement, with its line break. */
function lineOf(text: string, stmt: Stmt): TextEdit {
  const start = lineStart(text, stmt.start);
  const newline = text.indexOf('\n', stmt.end);
  const end = newline === -1 ? text.length : newline + 1;
  return { start, end, text: '' };
}

/** Right after the line of `stmt`, else at the top of the file. */
function after(text: string, stmt: Stmt | undefined): number {
  if (!stmt) {
    return 0;
  }

  const newline = text.indexOf('\n', stmt.end);
  return newline === -1 ? text.length : newline + 1;
}

/** A header statement written anew. */
function line(stmt: Stmt, written: string): TextEdit {
  return { start: stmt.start, end: stmt.end, text: written };
}

function ok(edits: TextEdit[]): OpResult {
  return { ok: true, edits };
}

/** Writes `@tool`, `class_name` and `extends` in Godot's order. */
export function setGDScriptSetting(
  text: string,
  _doc: GraphDocument,
  setting: string,
  value: string
): OpResult {
  const { tool, className, extendsStmt } = header(parseGDScript(text).script);
  const trimmed = value.trim();

  switch (setting) {
    case 'tool': {
      if (value === 'true') {
        return ok(tool ? [] : [{ start: 0, end: 0, text: '@tool\n' }]);
      }

      return ok(tool ? [lineOf(text, tool)] : []);
    }

    case 'class_name': {
      if (trimmed && !/^[A-Za-z_]\w*$/.test(trimmed)) {
        return { ok: false, error: `"${trimmed}" is not a valid class name.` };
      }

      if (!trimmed) {
        return ok(className ? [lineOf(text, className)] : []);
      }

      if (className) {
        return ok([line(className, `class_name ${trimmed}`)]);
      }

      const at = after(text, tool);
      return ok([{ start: at, end: at, text: `class_name ${trimmed}\n` }]);
    }

    case 'extends': {
      if (!trimmed) {
        return ok(extendsStmt ? [lineOf(text, extendsStmt)] : []);
      }

      if (extendsStmt) {
        return ok([line(extendsStmt, `extends ${trimmed}`)]);
      }

      const at = after(text, className ?? tool);
      return ok([{ start: at, end: at, text: `extends ${trimmed}\n` }]);
    }

    default: {
      return { ok: false, error: `Unknown setting ${setting}.` };
    }
  }
}
