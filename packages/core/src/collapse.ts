import type { StatementMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type {
  FunctionGraph,
  GraphDocument,
  GraphNode,
  SourceRange,
} from './ir';
import type { OpResult, TextEdit } from './ops';
import type { DeclarationSyntax, ExtractParam } from './symbol-ops';
import { addToClass, checkName, classOf } from './symbol-ops';
import type { ScriptSymbol } from './symbols';
import { qualifiedName } from './symbols';
import { lineIndent } from './text-utils';

function failed(error: string): OpResult {
  return { ok: false, error };
}

function within(inner: SourceRange, outer: SourceRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Only blank space, `;` and comments between two statements. */
function onlyFiller(text: string): boolean {
  return (
    text
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/(?:\/\/|#)[^\n]*/g, '')
      .replaceAll(/[\s;]/g, '') === ''
  );
}

/** The statements of the selection: one run of statements in one block. */
function selectedStatements(
  text: string,
  fn: FunctionGraph,
  ids: ReadonlySet<string>
): SourceRange | string {
  const ranges: SourceRange[] = [];
  for (const node of fn.nodes) {
    if (!ids.has(node.id)) {
      continue;
    }

    const meta = getMeta<StatementMeta>(node);
    if (meta.locked) {
      return 'Part of the selection belongs to a larger statement.';
    }

    if (node.purity === 'impure' && node.kind !== 'entry' && meta.stmt) {
      ranges.push(meta.stmt);
    }
  }

  // Statements inside selected blocks (an `if` body) come along.
  const outer = ranges
    .filter((r) => !ranges.some((o) => o !== r && within(r, o)))
    .toSorted((a, b) => a.start - b.start);
  const first = outer[0];
  const last = outer.at(-1);
  if (!first || !last) {
    return 'Select statements (nodes with exec pins) to collapse.';
  }

  for (const [i, range] of outer.entries()) {
    const next = outer[i + 1];
    if (next && !onlyFiller(text.slice(range.end, next.start))) {
      return 'Select statements that follow each other in one block.';
    }
  }

  return { start: first.start, end: last.end };
}

/** `x++`, `--x`: an update that reads and sets `x`. */
const UPDATE = /^(?:\+\+|--)?([A-Za-z_$][\w$]*)(?:\+\+|--)?$/;

function variableName(node: GraphNode): string | undefined {
  const name =
    node.kind === 'setVar' && node.title.startsWith('Set ')
      ? node.title.slice(4)
      : node.kind === 'setVar' && /^(?:\+\+|--)|(?:\+\+|--)$/.test(node.title)
        ? UPDATE.exec(node.title)?.[1]
        : node.kind === 'getVar'
          ? node.title
          : undefined;
  return name && IDENTIFIER.test(name) ? name : undefined;
}

/** `x += 1`, `x++`: the variable is read as well as set. */
function readsItself(node: GraphNode): boolean {
  if (node.kind !== 'setVar') {
    return false;
  }

  const op = node.subtitle ?? '';
  return (
    (op.endsWith('=') && op !== '=' && op.length > 1) ||
    /^(?:\+\+|--)|(?:\+\+|--)$/.test(node.title)
  );
}

interface Analysis {
  params: ExtractParam[];
  output?: { name: string; declare?: string };
  isAsync: boolean;
}

function analyze(
  text: string,
  fn: FunctionGraph,
  region: SourceRange,
  owner: ScriptSymbol,
  symbols: ReadonlyArray<ScriptSymbol>
): Analysis | string {
  const inside = fn.nodes.filter((n) => within(n.range, region));
  const insideIds = new Set(inside.map((n) => n.id));
  const after = fn.nodes.filter((n) => n.range.start >= region.end);
  const afterIds = new Set(after.map((n) => n.id));

  // Jumps out of the selection would change their meaning.
  const loops = inside.filter(
    (n) => n.kind === 'forEach' || n.kind === 'loop' || n.kind === 'switch'
  );
  for (const node of inside) {
    if (node.kind === 'return') {
      return 'The selection contains a return; collapse it without the return.';
    }

    if (
      (node.kind === 'break' || node.kind === 'continue') &&
      !loops.some((l) => l !== node && within(node.range, l.range))
    ) {
      return `The selection contains a ${node.kind} of a loop outside it.`;
    }
  }

  // Variables of the enclosing function, with their declarations.
  const scope = qualifiedName(owner);
  const declared = new Map<string, { range?: SourceRange; type?: string }>();
  for (const param of owner.params ?? []) {
    declared.set(param.name, { type: param.type?.text });
  }

  for (const local of symbols) {
    if (local.kind === 'local' && local.scope === scope) {
      declared.set(local.name, { range: local.range, type: local.type?.text });
    }
  }

  const declaredInside = (name: string): boolean => {
    const range = declared.get(name)?.range;
    return range !== undefined && within(range, region);
  };

  // Inputs: values wired in from outside, and outer variables read inside.
  const used = new Map<string, number>();
  const use = (name: string, at: number): void => {
    if (!declaredInside(name) && !used.has(name)) {
      used.set(name, at);
    }
  };

  for (const edge of fn.edges) {
    if (
      edge.kind !== 'data' ||
      !insideIds.has(edge.to.node) ||
      insideIds.has(edge.from.node)
    ) {
      continue;
    }

    const target = inside.find((n) => n.id === edge.to.node);
    const pin = target?.pins.find((p) => p.id === edge.to.pin);
    const name = pin?.range
      ? text.slice(pin.range.start, pin.range.end)
      : undefined;
    if (name && IDENTIFIER.test(name)) {
      use(name, pin?.range?.start ?? 0);
    }
  }

  for (const node of inside) {
    const name =
      node.kind === 'getVar' || readsItself(node)
        ? variableName(node)
        : undefined;
    if (name && declared.has(name)) {
      use(name, node.range.start);
    }
  }

  // Output: a variable set inside and read after the selection.
  const outputs = new Map<string, { declare?: string }>();
  for (const node of inside) {
    const name = node.kind === 'setVar' ? variableName(node) : undefined;
    if (!name || !declared.has(name)) {
      continue;
    }

    const readAfter =
      after.some((n) => n.kind === 'getVar' && variableName(n) === name) ||
      fn.edges.some(
        (e) =>
          e.kind === 'data' &&
          e.from.node === node.id &&
          afterIds.has(e.to.node)
      );
    if (readAfter && !outputs.has(name)) {
      const local = symbols.find(
        (s) => s.kind === 'local' && s.scope === scope && s.name === name
      );
      const keyword = local?.modifiers.find((m) =>
        ['const', 'let', 'var'].includes(m)
      );
      outputs.set(
        name,
        declaredInside(name) ? { declare: keyword ?? 'var' } : {}
      );
    }
  }

  if (outputs.size > 1) {
    return `The selection sets ${[...outputs.keys()].join(', ')}, which are used after it; one result per function for now.`;
  }

  const [output] = [...outputs].map(([name, value]) => ({ name, ...value }));
  const params = [...used]
    .toSorted((a, b) => a[1] - b[1])
    .map(([name]) => {
      const type = declared.get(name)?.type;
      return type ? { name, type } : { name };
    });
  return {
    params,
    ...(output ? { output } : {}),
    isAsync: inside.some((n) => n.kind === 'await'),
  };
}

/** Leading whitespace of a line. */
function leadingSpace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

/** Lines moved one level deeper: their common indentation becomes `unit`. */
function indentBody(code: string, unit: string): string {
  const lines = code.split('\n');
  const filled = lines.filter((l) => l.trim() !== '');
  const common = Math.min(...filled.map((l) => leadingSpace(l).length));
  return lines
    .map((line) => (line.trim() === '' ? '' : `${unit}${line.slice(common)}`))
    .join('\n');
}

/**
 * UE's "Collapse to Function": the selected statements become a new
 * function, called where they were. Variables they read from the enclosing
 * function become inputs; a variable they set that is used afterwards
 * becomes the result.
 */
export function collapseToFunction(
  text: string,
  doc: GraphDocument,
  nodeIds: ReadonlyArray<string>,
  name: string,
  unit: string,
  syntax: DeclarationSyntax | undefined
): OpResult {
  const extract = syntax?.extract;
  if (!syntax || !extract) {
    return failed('This language cannot collapse nodes yet.');
  }

  const ids = new Set(nodeIds);
  const fn = doc.functions.find((f) => f.nodes.some((n) => ids.has(n.id)));
  if (
    !fn ||
    doc.functions.some((f) => f !== fn && f.nodes.some((n) => ids.has(n.id)))
  ) {
    return failed('Select nodes of one function.');
  }

  const symbols = doc.symbols ?? [];
  const owner = symbols.find(
    (s) => s.fnId === fn.id && (s.kind === 'function' || s.kind === 'method')
  );
  if (!owner) {
    return failed('Nodes can be collapsed inside named functions and methods.');
  }

  const region = selectedStatements(text, fn, ids);
  if (typeof region === 'string') {
    return failed(region);
  }

  const analysis = analyze(text, fn, region, owner, symbols);
  if (typeof analysis === 'string') {
    return failed(analysis);
  }

  const method = owner.kind === 'method';
  const cls = method ? classOf(doc, owner.scope) : undefined;
  const scope = cls ? qualifiedName(cls) : '';
  const nameError = checkName(doc, syntax, scope, name);
  if (nameError) {
    return failed(nameError);
  }

  // The body: the statements one level in, plus the result.
  const indent = lineIndent(text, region.start);
  const code = indent + text.slice(region.start, region.end);
  const body = [
    indentBody(code, unit),
    ...(analysis.output
      ? [`${unit}${extract.returnValue(analysis.output.name)}`]
      : []),
  ].join('\n');
  const isStatic = owner.modifiers.includes('static');
  const block = extract.fn(name, analysis.params, body, {
    method: cls !== undefined,
    isStatic,
    isAsync: analysis.isAsync,
  });

  const callee = cls ? extract.method(name, cls.name, isStatic) : name;
  const call = extract.call(
    callee,
    analysis.params.map((p) => p.name),
    {
      isAsync: analysis.isAsync,
      ...(analysis.output ? { output: analysis.output } : {}),
    }
  );
  const replace: TextEdit = {
    start: region.start,
    end: region.end,
    text: call,
  };

  if (cls) {
    return {
      ok: true,
      edits: [
        replace,
        addToClass(
          text,
          doc,
          cls,
          block,
          unit,
          syntax,
          Math.min(syntax.blankLines, 1)
        ),
      ],
    };
  }

  // After the top-level declaration that holds the function.
  const top =
    symbols.find(
      (s) =>
        s.scope === '' &&
        (s.kind === 'function' || s.kind === 'class') &&
        within(owner.range, s.declarationRange ?? s.range)
    ) ?? owner;
  const end = (top.declarationRange ?? top.range).end;
  return {
    ok: true,
    edits: [
      replace,
      {
        start: end,
        end,
        text: `${'\n'.repeat(syntax.blankLines + 1)}${block}`,
      },
    ],
  };
}
