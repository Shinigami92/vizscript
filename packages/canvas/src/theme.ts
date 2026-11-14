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
  /** Body of UE's math nodes: lighter at the top, darker at the bottom. */
  mathTop: string;
  mathBottom: string;
  /** Drop shadow under nodes. */
  nodeShadow: string;
  /** Light top edge of headers (UE's gloss). */
  headerShine: string;
  /** Line between header and body. */
  headerDivider: string;
  /** Shadow behind header titles. */
  titleShadow: string;
  /** Body of Get pills (UE: near black, lit by the type's glow). */
  pillBody: string;
  /** Alpha (hex) of the type's glow in Get pills, at its center. */
  pillTint: string;
  /** Alpha (hex) of the glow halfway out. */
  pillTintMid: string;
  /** Gloss over the top half of Get pills. */
  pillShine: string;
  /** UE's light top rim of nodes, fading downward. */
  rimLight: string;
  /** The brighter glare on the top left of a Get pill's rim. */
  pillGlare: string;
  /** Alpha (hex) at the right end of the header gradient. */
  headerFade: string;
  exec: string;
  pinLabel: string;
  literalBackground: string;
  literalBorder: string;
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
  /** Banner and outline of nodes the code doesn't match yet. */
  syncBanner: string;
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
  // Slightly see-through like UE's nodes: the grid shows behind them.
  nodeBody: 'rgba(24, 24, 27, 0.84)',
  nodeBorder: '#050506',
  nodeTitle: '#f2f2f2',
  nodeText: '#f2f2f2',
  nodeSubtext: '#a8a8b0',
  compactVariable: 'rgba(38, 38, 43, 0.86)',
  compactPure: 'rgba(31, 42, 26, 0.86)',
  compactSubtext: '#a1a1aa',
  operatorGlyph: 'rgba(255, 255, 255, 0.26)',
  mathTop: 'rgba(56, 56, 60, 0.9)',
  mathBottom: 'rgba(28, 28, 31, 0.9)',
  nodeShadow: 'rgba(0, 0, 0, 0.55)',
  headerShine: 'rgba(255, 255, 255, 0.16)',
  headerDivider: 'rgba(0, 0, 0, 0.45)',
  titleShadow: 'rgba(0, 0, 0, 0.7)',
  pillBody: 'rgba(16, 16, 18, 0.86)',
  pillTint: '5c',
  pillTintMid: '1c',
  pillShine: 'rgba(255, 255, 255, 0.08)',
  rimLight: 'rgba(255, 255, 255, 0.24)',
  pillGlare: 'rgba(255, 255, 255, 0.55)',
  headerFade: '33',
  exec: execColor('dark'),
  pinLabel: '#d4d4d8',
  // UE's value boxes are see-through: only the border shows.
  literalBackground: 'rgba(0, 0, 0, 0)',
  literalBorder: 'rgba(212, 212, 216, 0.7)',
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
  syncBanner: '#d97706',
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
  nodeBody: 'rgba(255, 255, 255, 0.88)',
  nodeBorder: 'rgba(24, 24, 27, 0.28)',
  nodeTitle: '#ffffff',
  nodeText: '#18181b',
  nodeSubtext: 'rgba(255, 255, 255, 0.72)',
  compactVariable: 'rgba(228, 228, 231, 0.9)',
  compactPure: 'rgba(226, 237, 217, 0.9)',
  compactSubtext: '#71717a',
  operatorGlyph: 'rgba(24, 24, 27, 0.28)',
  mathTop: 'rgba(252, 252, 253, 0.92)',
  mathBottom: 'rgba(222, 222, 226, 0.92)',
  nodeShadow: 'rgba(24, 24, 27, 0.18)',
  headerShine: 'rgba(255, 255, 255, 0.22)',
  headerDivider: 'rgba(0, 0, 0, 0.18)',
  titleShadow: 'rgba(0, 0, 0, 0.35)',
  pillBody: 'rgba(236, 236, 239, 0.9)',
  pillTint: '66',
  pillTintMid: '24',
  pillShine: 'rgba(255, 255, 255, 0.7)',
  rimLight: 'rgba(255, 255, 255, 0.85)',
  pillGlare: 'rgba(255, 255, 255, 1)',
  headerFade: 'aa',
  exec: execColor('light'),
  pinLabel: '#27272a',
  literalBackground: 'rgba(255, 255, 255, 0)',
  literalBorder: 'rgba(24, 24, 27, 0.35)',
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
  syncBanner: '#d97706',
  bannerText: '#ffffff',
  marqueeFill: 'rgba(232, 147, 12, 0.08)',
  marqueeBorder: 'rgba(232, 147, 12, 0.85)',
  categories: CATEGORY_COLORS,
  fontFamily: FONT_FAMILY,
  monoFontFamily: MONO_FONT_FAMILY,
};
