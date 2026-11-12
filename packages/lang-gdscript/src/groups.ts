import type {
  GraphDocument,
  OpResult,
  ScriptSymbol,
  TextEdit,
} from '@vizscript/core';
import { lineStart } from '@vizscript/core';
import type { Annotation, Expr, Stmt, VarDecl } from './ast';
import { parseGDScript } from './parser';

function title(arg: Expr | undefined): string {
  return arg?.type === 'Literal' && arg.kind === 'string' ? arg.value : '';
}

function exported(decl: VarDecl): boolean {
  return decl.annotations.some(
    (a) => a.name.startsWith('export') && !GROUP_ANNOTATIONS.has(a.name)
  );
}

interface Grouped {
  decl: VarDecl;
  group: string;
}

interface Marker {
  /** The `@export_group(…)` annotation (alone or before a variable). */
  span: { start: number; end: number };
  /** `Group` or `Group/Subgroup`. */
  path: string;
}

const GROUP_ANNOTATIONS = new Set([
  'export_category',
  'export_group',
  'export_subgroup',
]);

/**
 * Walks the script like Godot's inspector: `@export_group("Movement")`
 * puts the exported variables after it into that group until the next
 * group (or `@export_category`); `@export_subgroup` nests.
 */
function walk(body: ReadonlyArray<Stmt>): {
  vars: Grouped[];
  markers: Marker[];
} {
  let group = '';
  let subgroup = '';
  const vars: Grouped[] = [];
  const markers: Marker[] = [];
  const read = (annotation: Annotation): void => {
    const { name, args } = annotation;
    if (name === 'export_category') {
      group = '';
      subgroup = '';
    } else if (name === 'export_group') {
      group = title(args[0]);
      subgroup = '';
      markers.push({ span: annotation, path: group });
    } else if (name === 'export_subgroup') {
      subgroup = title(args[0]);
      markers.push({
        span: annotation,
        path: group ? `${group}/${subgroup}` : subgroup,
      });
    }
  };

  for (const stmt of body) {
    // The parser puts `@export_group(…)` lines on the next variable.
    if (stmt.type === 'Annotation') {
      read(stmt.annotation);
      continue;
    }

    if (stmt.type !== 'Var') {
      continue;
    }

    for (const annotation of stmt.annotations) {
      if (GROUP_ANNOTATIONS.has(annotation.name)) {
        read(annotation);
      }
    }

    if (exported(stmt)) {
      const path =
        group && subgroup ? `${group}/${subgroup}` : group || subgroup;
      vars.push({ decl: stmt, group: path });
    }
  }

  return { vars, markers };
}

/** Sets `group` of the script's exported variables. */
export function assignGroups(
  body: ReadonlyArray<Stmt>,
  symbols: ReadonlyArray<ScriptSymbol>
): void {
  for (const { decl, group } of walk(body).vars) {
    const symbol = symbols.find(
      (s) => s.kind === 'variable' && s.scope === '' && s.name === decl.name
    );
    if (symbol && group) {
      symbol.group = group;
    }
  }
}

/**
 * The lines of a declaration, with `##` doc comments right above it but
 * without group annotations before it (they stay where they are).
 */
function block(text: string, decl: VarDecl): { start: number; end: number } {
  const groups = decl.annotations.filter((a) => GROUP_ANNOTATIONS.has(a.name));
  const lastGroup = groups.at(-1);
  let start = lastGroup
    ? lineEndAfter(text, lastGroup.end)
    : lineStart(text, decl.start);
  while (start > 0) {
    const above = lineStart(text, start - 1);
    if (!text.slice(above, start).trimStart().startsWith('##')) {
      break;
    }

    start = above;
  }

  const newline = text.indexOf('\n', decl.end);
  return { start, end: newline === -1 ? text.length : newline + 1 };
}

function lineEndAfter(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  return newline === -1 ? text.length : newline + 1;
}

/**
 * Moves an exported variable into a group, like UE's Category: its lines go
 * after the last variable of the group (or its `@export_group` line); a new
 * group starts after the last exported variable; no group puts it before
 * the first group.
 */
export function setGDScriptSymbolGroup(
  text: string,
  _doc: GraphDocument,
  symbol: ScriptSymbol,
  group: string
): OpResult {
  const target = group
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
  const { vars, markers } = walk(parseGDScript(text).script.body);
  const own = vars.find((v) => v.decl.name === symbol.name);
  if (!own) {
    return {
      ok: false,
      error: 'Only exported variables of the script have a category.',
    };
  }

  if (own.group === target) {
    return { ok: true, edits: [] };
  }

  const moved = block(text, own.decl);
  const lines = text.slice(moved.start, moved.end);
  const remove: TextEdit = { start: moved.start, end: moved.end, text: '' };
  const insert = (at: number, before = ''): OpResult =>
    at > moved.start && at < moved.end
      ? { ok: true, edits: [] }
      : {
          ok: true,
          edits: [remove, { start: at, end: at, text: `${before}${lines}` }],
        };

  if (!target) {
    const first = markers[0];
    return first
      ? insert(lineStart(text, first.span.start))
      : { ok: true, edits: [] };
  }

  const members = vars.filter((v) => v.group === target && v !== own);
  const last = members.at(-1);
  if (last) {
    return insert(block(text, last.decl).end);
  }

  const marker = markers.find((m) => m.path === target);
  if (marker) {
    return insert(lineEndAfter(text, marker.span.end));
  }

  // A new group (or a new subgroup of an existing group).
  const [groupName = '', subgroup] = target.split('/');
  const parent = markers.find((m) => m.path === groupName);
  const parentMembers = vars.filter(
    (v) => v.group.split('/')[0] === groupName && v !== own
  );
  if (subgroup && parent) {
    const end = parentMembers.at(-1)
      ? block(text, parentMembers.at(-1)?.decl ?? own.decl).end
      : lineEndAfter(text, parent.span.end);
    return insert(end, `@export_subgroup("${subgroup}")\n`);
  }

  const lastExported = vars.filter((v) => v !== own).at(-1);
  const end = lastExported ? block(text, lastExported.decl).end : moved.end;
  const header = `@export_group("${groupName}")\n${subgroup ? `@export_subgroup("${subgroup}")\n` : ''}`;
  return lastExported
    ? insert(end, header)
    : {
        ok: true,
        edits: [{ start: moved.start, end: moved.start, text: header }],
      };
}
