import type { AlignMode } from '@vizscript/canvas';
import type { FlowTemplate, NodeTemplate } from '@vizscript/core';

export const ICON_IMPORT = 'i-mdi-file-import-outline text-sky-400';
/** Actions for a wire dropped on empty space (like Blueprints). */
export const ICON_CALL = 'i-mdi-function-variant text-sky-400';
export const ICON_VARIABLE = 'i-mdi-alpha-x-box-outline text-sky-400';
export const ICON_SET = 'i-mdi-arrow-left-bold-box-outline text-sky-400';
export const ICON_MEMBER = 'i-mdi-code-braces text-sky-400';

export const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Clipboard type that tells which language copied nodes are in. */
export const NODES_MIME = 'application/x-vizscript-nodes';

export const EXPRESSION_ICONS: Record<string, string> = {
  Math: 'i-mdi-calculator-variant-outline text-emerald-400',
  Comparison: 'i-mdi-scale-balance text-red-300',
  Logic: 'i-mdi-gate-and text-red-300',
  Text: 'i-mdi-format-text text-pink-400',
  Values: 'i-mdi-numeric text-zinc-400',
};

/** UE's alignment tools for two or more selected nodes. */
export const ALIGN_ENTRIES: ReadonlyArray<{
  label: string;
  icon: string;
  mode: AlignMode;
  keys?: string;
}> = [
  {
    label: 'Align top',
    icon: 'i-mdi-align-vertical-top',
    mode: 'top',
    keys: 'Shift+W',
  },
  {
    label: 'Align middle',
    icon: 'i-mdi-align-vertical-center',
    mode: 'middle',
    keys: 'Alt+Shift+W',
  },
  {
    label: 'Align bottom',
    icon: 'i-mdi-align-vertical-bottom',
    mode: 'bottom',
    keys: 'Shift+S',
  },
  {
    label: 'Align left',
    icon: 'i-mdi-align-horizontal-left',
    mode: 'left',
    keys: 'Shift+A',
  },
  {
    label: 'Align center',
    icon: 'i-mdi-align-horizontal-center',
    mode: 'center',
    keys: 'Alt+Shift+S',
  },
  {
    label: 'Align right',
    icon: 'i-mdi-align-horizontal-right',
    mode: 'right',
    keys: 'Shift+D',
  },
  {
    label: 'Distribute horizontally',
    icon: 'i-mdi-distribute-horizontal-center',
    mode: 'distributeHorizontally',
  },
  {
    label: 'Distribute vertically',
    icon: 'i-mdi-distribute-vertical-center',
    mode: 'distributeVertically',
  },
];

export const JUMPS: ReadonlySet<FlowTemplate> = new Set([
  'throw',
  'break',
  'continue',
]);

export const FLOW_ENTRIES: Record<
  FlowTemplate,
  { label: string; icon: string; keywords: string }
> = {
  forEach: {
    label: 'For Each loop',
    icon: 'i-mdi-repeat',
    keywords: 'for of in each array list iterate loop',
  },
  forRange: {
    label: 'For loop (counter)',
    icon: 'i-mdi-counter',
    keywords: 'for range index count loop',
  },
  while: {
    label: 'While loop',
    icon: 'i-mdi-sync',
    keywords: 'while loop condition repeat',
  },
  switch: {
    label: 'Switch / match',
    icon: 'i-mdi-call-split',
    keywords: 'switch match case select',
  },
  try: {
    label: 'Try / catch',
    icon: 'i-mdi-shield-outline',
    keywords: 'try catch except error exception',
  },
  throw: {
    label: 'Throw error',
    icon: 'i-mdi-alert-octagon-outline',
    keywords: 'throw raise error exception',
  },
  break: {
    label: 'Break',
    icon: 'i-mdi-debug-step-out',
    keywords: 'break exit loop stop',
  },
  continue: {
    label: 'Continue',
    icon: 'i-mdi-debug-step-over',
    keywords: 'continue next skip loop',
  },
};

/** Reserved words that are values (`Use true`), unlike `return`. */
export const VALUE_WORDS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'True',
  'False',
  'None',
  'self',
]);

/**
 * UE's node hotkeys: hold a key and click empty space for a node there,
 * at the end of the function under the pointer.
 */
export const HOTKEYS: Record<
  string,
  { template: NodeTemplate; flow?: FlowTemplate }
> = {
  b: { template: { type: 'branch' } },
  l: { template: { type: 'flow', flow: 'forEach' }, flow: 'forEach' },
  r: { template: { type: 'return' } },
};
