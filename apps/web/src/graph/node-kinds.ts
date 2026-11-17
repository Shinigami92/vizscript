import type { GraphNode, NodeCategory } from '@vizscript/core';

/** What a node is, in words (tooltip, Details header). */
export const NODE_KIND_LABELS: Record<string, string> = {
  entry: 'Event / function entry',
  return: 'Return',
  call: 'Function call',
  operator: 'Operator · pure',
  template: 'Text template · pure',
  literal: 'Literal · pure',
  makeObject: 'Make object · pure',
  makeArray: 'Make array · pure',
  getProperty: 'Get property · pure',
  getVar: 'Get variable · pure',
  setVar: 'Set variable',
  functionRef: 'Function reference',
  branch: 'Flow control: branch',
  switch: 'Flow control: switch',
  forEach: 'Flow control: for each',
  loop: 'Flow control: loop',
  break: 'Break',
  continue: 'Continue',
  try: 'Flow control: try / catch',
  throw: 'Throw',
  await: 'Latent: await',
  select: 'Select · pure',
  export: 'Module export',
  unknown: 'Unrecognized code',
};

/** Icon of a node in the Details header, by its category. */
export const NODE_CATEGORY_ICONS: Record<NodeCategory, string> = {
  event: 'i-mdi-lightning-bolt-outline',
  entry: 'i-mdi-function',
  function: 'i-mdi-function',
  pure: 'i-mdi-function-variant',
  flow: 'i-mdi-source-branch',
  variable: 'i-mdi-alpha-x-box-outline',
  return: 'i-mdi-keyboard-return',
  latent: 'i-mdi-clock-outline',
  unknown: 'i-mdi-help-circle-outline',
};

/**
 * The kind of a node for the Details header, with its own subtitle (`elif`,
 * `extends Node`): "Flow control", not "Flow control: branch" under the
 * title Branch.
 */
export function nodeSubtitle(node: GraphNode): string {
  const kind = (NODE_KIND_LABELS[node.kind] ?? node.kind).replace(/: .*/, '');
  return node.subtitle ? `${kind} · ${node.subtitle}` : kind;
}
