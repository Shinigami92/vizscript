import type { InputPinMeta, InsertPoint, StatementMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  Pin,
  SourceRange,
} from './ir';
import type { NodeTemplate, TextEdit } from './ops';
import type { StatementSyntax } from './text-ops';
import { lineIndent } from './text-utils';
import { lineAwareRange } from './text-utils';

/**
 * Replaces the expression of an input. Object properties keep their key:
 * `{ length }` → `{ length: value }`, and `{ length: length }` → `{ length }`.
 */
export function inputEdit(
  pin: Pin,
  range: SourceRange,
  value: string
): TextEdit {
  const { propertyKey: key, property, shorthand } = getMeta<InputPinMeta>(pin);
  if (key && shorthand && value !== key) {
    return { start: range.start, end: range.end, text: `${key}: ${value}` };
  }

  if (key && property && !shorthand && value === key) {
    return { start: property.start, end: property.end, text: key };
  }

  return { start: range.start, end: range.end, text: value };
}

export function asStatement(
  expression: string,
  syntax: StatementSyntax
): string {
  return (
    syntax.expressionStatement?.(expression) ??
    `${expression}${syntax.statementEnd ?? ''}`
  );
}

export function contains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function findPin(
  node: GraphNode | undefined,
  pinId: string
): Pin | undefined {
  return node?.pins.find((p) => p.id === pinId);
}

export function edgesOf(doc: GraphDocument, nodeId: string): GraphEdge[] {
  for (const fn of doc.functions) {
    if (fn.nodes.some((n) => n.id === nodeId)) {
      return fn.edges;
    }
  }

  return [];
}

export function functionOf(
  doc: GraphDocument,
  nodeId: string
): string | undefined {
  return doc.functions.find((fn) => fn.nodes.some((n) => n.id === nodeId))?.id;
}

export function insertText(
  point: InsertPoint,
  snippet: string,
  source?: string
): TextEdit {
  if (point.mode !== 'after') {
    return {
      start: point.at,
      end: point.at,
      text: `${snippet}\n${point.indent}`,
    };
  }

  // Into an empty block on one line (`() => {}`): the `}` gets its own line.
  const closes =
    source !== undefined && /^[ \t]*\}/.test(source.slice(point.at));
  const close = closes ? `\n${lineIndent(source, point.at)}` : '';
  return {
    start: point.at,
    end: point.at,
    text: `\n${point.indent}${snippet}${close}`,
  };
}

/** Leading whitespace of a line. */
function leadingSpace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

/**
 * Code moved to another place: its lines lose their common indentation,
 * keep their nesting in the file's indent unit, and all but the first get
 * `indent` (the first line goes where the insert point puts it).
 */
export function reindentCode(
  code: string,
  indent: string,
  unit: string
): string {
  const lines = code
    .replaceAll('\r\n', '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
    .split('\n');
  const filled = lines.filter((line) => line.trim() !== '');
  const common = Math.min(...filled.map((line) => leadingSpace(line).length));
  const sourceUnit = detectIndentUnit(lines.join('\n'));
  return lines
    .map((line, i) => {
      if (line.trim() === '') {
        return '';
      }

      const relative = leadingSpace(line).slice(
        Number.isFinite(common) ? common : 0
      );
      const levels = relative.split(sourceUnit).length - 1;
      const rest = relative.slice(levels * sourceUnit.length);
      return `${i === 0 ? '' : indent}${unit.repeat(levels)}${rest}${line.trimStart()}`;
    })
    .join('\n');
}

/** A template's code: pasted code as is, the others from the language. */
export function templateSnippet(
  syntax: StatementSyntax,
  template: NodeTemplate,
  indent: string,
  unit: string
): string | undefined {
  return template.type === 'code'
    ? reindentCode(template.code, indent, unit)
    : syntax.template(template, indent, unit);
}

/** Indentation step of a file: a tab, or the smallest space indent. */
export function detectIndentUnit(text: string): string {
  let smallest = Number.POSITIVE_INFINITY;
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) {
      return '\t';
    }

    const spaces = line.length - line.trimStart().length;
    if (spaces > 0 && line.trim() !== '') {
      smallest = Math.min(smallest, spaces);
    }
  }

  return Number.isFinite(smallest) ? ' '.repeat(smallest) : '  ';
}

/** Removal (or placeholder) edit for a whole statement. */
export function removeStatement(
  text: string,
  meta: Partial<StatementMeta> & { stmt: SourceRange },
  syntax: StatementSyntax
): TextEdit {
  if (meta.inline || meta.sole) {
    return {
      start: meta.stmt.start,
      end: meta.stmt.end,
      text: syntax.emptyBody,
    };
  }

  if (meta.tail) {
    return {
      start: meta.stmt.start,
      end: meta.stmt.end,
      text: syntax.placeholder,
    };
  }

  const [start, end] = lineAwareRange(text, meta.stmt.start, meta.stmt.end);
  return { start, end, text: '' };
}
