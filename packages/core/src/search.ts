import type { FunctionGraph, GraphDocument, GraphNode } from './ir';

export interface SearchMatch {
  node: GraphNode;
  fn: FunctionGraph;
  /** Which part of the node matched, shown in result lists. */
  field: 'title' | 'subtitle' | 'pin' | 'value' | 'function' | 'comment';
  text: string;
}

/**
 * Finds nodes by title, subtitle, comment, pin name, inline value or function name
 * (case-insensitive substring). Results keep document order, with title
 * matches of a node preferred over the other fields.
 */
export function searchNodes(
  doc: GraphDocument,
  query: string,
  limit = 500
): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const hit = (text: string | undefined): text is string =>
    text !== undefined && text.toLowerCase().includes(needle);

  const results: SearchMatch[] = [];
  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      let match: SearchMatch | undefined;
      if (hit(node.title)) {
        match = { node, fn, field: 'title', text: node.title };
      } else if (hit(node.subtitle)) {
        match = { node, fn, field: 'subtitle', text: node.subtitle };
      } else if (node.kind === 'entry' && hit(fn.name)) {
        match = { node, fn, field: 'function', text: fn.name };
      } else if (hit(node.comment?.text)) {
        match = { node, fn, field: 'comment', text: node.comment.text };
      } else {
        for (const pin of node.pins) {
          if (hit(pin.literal?.value)) {
            match = { node, fn, field: 'value', text: pin.literal.value };
            break;
          }

          if (pin.kind === 'data' && hit(pin.name)) {
            match = { node, fn, field: 'pin', text: pin.name };
            break;
          }
        }
      }

      if (match) {
        results.push(match);
        if (results.length >= limit) {
          return results;
        }
      }
    }
  }

  return results;
}
