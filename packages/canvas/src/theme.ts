import type { ColorScheme, NodeCategory } from '@vizscript/core';
import { CATEGORY_COLORS, execColor } from '@vizscript/core';

export interface Theme {
  /** Selects the pin colors (`pinColor`) that fit the background. */
  scheme: ColorScheme;
  background: string;
  gridMinor: string;
  gridMajor: string;
  nodeBody: string;
  nodeBorder: string;
  /** Title on the colored header. */
  nodeTitle: string;
  /** Title of compact nodes (on the body color). */
  nodeText: string;
  /** Subtitle on the header (e.g. `function`). */
  nodeSubtext: string;
  compactVariable: string;
  compactPure: string;
  /** Small text on compact nodes (`const` under `SET`). */
  compactSubtext: string;
  /** Large faded symbol of operator nodes (`*`, `==`). */
  operatorGlyph: string;
  /** Drop shadow under nodes. */
  nodeShadow: string;
  /** Alpha (hex) at the right end of the header gradient. */
  headerFade: string;
  exec: string;
  pinLabel: string;
  literalBackground: string;
  literalText: string;
  literalString: string;
  selection: string;
  hover: string;
  codeHighlight: string;
  frameFill: string;
  frameBorder: string;
  frameTitle: string;
  commentFill: string;
  commentHeader: string;
  commentBorder: string;
  commentTitle: string;
  bubbleFill: string;
  bubbleText: string;
  errorBanner: string;
  warningBanner: string;
  infoBanner: string;
  bannerText: string;
  marqueeFill: string;
  marqueeBorder: string;
  categories: Record<NodeCategory, string>;
  fontFamily: string;
  monoFontFamily: string;
}

const FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO_FONT_FAMILY =
  'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';

export const DARK_THEME: Theme = {
  scheme: 'dark',
  background: '#161618',
  gridMinor: '#1f1f22',
  gridMajor: '#0c0c0d',
  nodeBody: 'rgba(24, 24, 27, 0.94)',
  nodeBorder: '#050506',
  nodeTitle: '#f2f2f2',
  nodeText: '#f2f2f2',
  nodeSubtext: '#a8a8b0',
  compactVariable: '#26262b',
  compactPure: '#1f2a1a',
  compactSubtext: '#a1a1aa',
  operatorGlyph: 'rgba(244, 244, 245, 0.55)',
  nodeShadow: 'rgba(0, 0, 0, 0.55)',
  headerFade: '55',
  exec: execColor('dark'),
  pinLabel: '#d4d4d8',
  literalBackground: '#2b2b30',
  literalText: '#e8e8ea',
  literalString: '#f0a5e3',
  selection: '#f5a623',
  hover: 'rgba(255, 255, 255, 0.55)',
  codeHighlight: '#38bdf8',
  frameFill: 'rgba(255, 255, 255, 0.025)',
  frameBorder: 'rgba(255, 255, 255, 0.08)',
  frameTitle: 'rgba(255, 255, 255, 0.45)',
  commentFill: 'rgba(148, 163, 184, 0.07)',
  commentHeader: 'rgba(148, 163, 184, 0.2)',
  commentBorder: 'rgba(148, 163, 184, 0.35)',
  commentTitle: '#e4e4e7',
  bubbleFill: 'rgba(228, 228, 231, 0.92)',
  bubbleText: '#18181b',
  errorBanner: '#c0262d',
  warningBanner: '#b7791f',
  infoBanner: '#2b6cb0',
  bannerText: '#ffffff',
  marqueeFill: 'rgba(245, 166, 35, 0.08)',
  marqueeBorder: 'rgba(245, 166, 35, 0.8)',
  categories: CATEGORY_COLORS,
  fontFamily: FONT_FAMILY,
  monoFontFamily: MONO_FONT_FAMILY,
};

/** Light canvas; node headers keep their Blueprint colors. */
export const LIGHT_THEME: Theme = {
  scheme: 'light',
  background: '#f4f4f5',
  gridMinor: '#e7e7ea',
  gridMajor: '#dadade',
  nodeBody: 'rgba(255, 255, 255, 0.96)',
  nodeBorder: 'rgba(24, 24, 27, 0.28)',
  nodeTitle: '#ffffff',
  nodeText: '#18181b',
  nodeSubtext: 'rgba(255, 255, 255, 0.72)',
  compactVariable: '#e4e4e7',
  compactPure: '#e2edd9',
  compactSubtext: '#71717a',
  operatorGlyph: 'rgba(24, 24, 27, 0.45)',
  nodeShadow: 'rgba(24, 24, 27, 0.18)',
  headerFade: 'aa',
  exec: execColor('light'),
  pinLabel: '#27272a',
  literalBackground: '#e4e4e7',
  literalText: '#18181b',
  literalString: '#b0108f',
  selection: '#e8930c',
  hover: 'rgba(24, 24, 27, 0.5)',
  codeHighlight: '#0284c7',
  frameFill: 'rgba(24, 24, 27, 0.025)',
  frameBorder: 'rgba(24, 24, 27, 0.12)',
  frameTitle: 'rgba(24, 24, 27, 0.5)',
  commentFill: 'rgba(100, 116, 139, 0.08)',
  commentHeader: 'rgba(100, 116, 139, 0.22)',
  commentBorder: 'rgba(100, 116, 139, 0.45)',
  commentTitle: '#27272a',
  bubbleFill: 'rgba(254, 243, 199, 0.96)',
  bubbleText: '#18181b',
  errorBanner: '#c0262d',
  warningBanner: '#b7791f',
  infoBanner: '#2b6cb0',
  bannerText: '#ffffff',
  marqueeFill: 'rgba(232, 147, 12, 0.08)',
  marqueeBorder: 'rgba(232, 147, 12, 0.85)',
  categories: CATEGORY_COLORS,
  fontFamily: FONT_FAMILY,
  monoFontFamily: MONO_FONT_FAMILY,
};
