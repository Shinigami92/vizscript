import type { GraphDocument, GraphNode } from './ir';

function describeNode(node: GraphNode): string {
  const pins = node.pins
    .map((p) => {
      const arrow = p.direction === 'in' ? '<' : '>';
      const kind = p.kind === 'exec' ? '▶' : p.type;
      const literal = p.literal ? `=${p.literal.raw}` : '';
      return `${arrow}${p.id}:${kind}${literal}`;
    })
    .join(' ');
  return `${node.kind} "${node.title}"${node.subtitle ? ` (${node.subtitle})` : ''} [${pins}]`;
}

/** Compact, human readable representation of a graph (snapshots, debugging). */
export function summarizeGraph(doc: GraphDocument): string {
  const lines: string[] = [];
  for (const fn of doc.functions) {
    lines.push(`function ${fn.name}`);
    const label = new Map<string, string>();
    for (const [index, node] of fn.nodes.entries()) {
      label.set(node.id, `#${index}`);
      lines.push(`  #${index} ${describeNode(node)}`);
    }

    for (const edge of fn.edges) {
      lines.push(
        `  ${edge.kind === 'exec' ? '==>' : '-->'} ${label.get(edge.from.node)}.${edge.from.pin} -> ${label.get(edge.to.node)}.${edge.to.pin}`
      );
    }
  }

  for (const d of doc.diagnostics) {
    lines.push(`diagnostic ${d.severity}: ${d.message}`);
  }

  return lines.join('\n');
}

/**
 * Compact representation of a document's symbols, one per line, e.g.
 * `function greeter(person: string): string [export] → greeter` (snapshots).
 */
export function summarizeSymbols(doc: GraphDocument): string {
  const graphs = new Map(doc.functions.map((f) => [f.id, f.name]));
  return (doc.symbols ?? [])
    .map((s) => {
      const params = s.params
        ? `(${s.params
            .map(
              (p) =>
                `${p.rest ? '...' : ''}${p.name}${p.type ? `: ${p.type.text}` : ''}${p.defaultRange ? ' = …' : ''}`
            )
            .join(', ')})`
        : '';
      const type = s.type
        ? `: ${s.type.text}`
        : s.returns
          ? `: ${s.returns.text}`
          : '';
      const inferred =
        !s.type && !s.params && s.dataType !== 'any' ? ` ~${s.dataType}` : '';
      const value = s.defaultRange ? ' = …' : '';
      const modifiers =
        s.modifiers.length > 0 ? ` [${s.modifiers.join(' ')}]` : '';
      const graph = s.fnId ? ` → ${graphs.get(s.fnId) ?? '?'}` : '';
      const scope = s.scope ? `${s.scope}::` : '';
      return `${s.kind} ${scope}${s.name}${params}${type}${inferred}${value}${modifiers}${graph}`;
    })
    .join('\n');
}
