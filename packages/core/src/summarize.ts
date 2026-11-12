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
