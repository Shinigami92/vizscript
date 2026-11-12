import type { InputPinMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type { GraphNode, Pin } from './ir';

export type TextStyle =
  | 'title'
  | 'subtitle'
  | 'label'
  | 'literal'
  | 'compact'
  | 'glyph';

/** Measures the rendered width of `text` in pixels for a given style. */
export type MeasureText = (text: string, style: TextStyle) => number;

const APPROX_CHAR_WIDTH: Record<TextStyle, number> = {
  title: 7.5,
  subtitle: 6,
  label: 6.6,
  literal: 6.6,
  compact: 8.5,
  glyph: 15,
};

/** Rough estimate used when no canvas is available (tests, workers). */
export const approximateMeasureText: MeasureText = (text, style) =>
  text.length * APPROX_CHAR_WIDTH[style];

export const NODE_METRICS = {
  headerHeight: 28,
  subtitleHeight: 14,
  rowHeight: 24,
  paddingX: 12,
  pinRadius: 5,
  pinLabelGap: 8,
  columnGap: 24,
  literalPadding: 10,
  literalMaxWidth: 160,
  minWidth: 80,
  compactPaddingY: 6,
  cornerRadius: 8,
  /** Distance of pin markers from the node edge. */
  pinInset: 10,
  literalHeight: 18,
  /** Boolean values are a checkbox, like UE's. */
  checkboxSize: 14,
} as const;

export interface PinGeometry {
  pin: Pin;
  /** Position relative to the node's top-left corner. */
  x: number;
  y: number;
  side: 'left' | 'right';
  row: number;
}

export interface NodeGeometry {
  width: number;
  height: number;
  headerHeight: number;
  /** Width of the input pin column (pins, labels, literals). */
  leftColumn: number;
  /** Width of the output pin column. */
  rightColumn: number;
  pins: Map<string, PinGeometry>;
}

/**
 * Drawn without a header: getters and operators (`node.compact`) and
 * setters, like UE's compact SET node.
 */
export function isCompact(node: GraphNode): boolean {
  return node.compact === true || node.kind === 'setVar';
}

function isSetter(node: GraphNode): boolean {
  return node.kind === 'setVar' && node.title.startsWith('Set ');
}

/**
 * An operator drawn as a large faded symbol (`*`, `==`, `&&`), like UE's
 * compact math nodes; words (`as f64`, `not`) stay plain titles.
 */
export function isOperatorGlyph(node: GraphNode): boolean {
  return (
    node.kind === 'operator' &&
    isCompact(node) &&
    /^[^\w\s]{1,3}$/.test(node.title)
  );
}

/**
 * UE's advanced pins: an argument the call leaves out, so its parameter's
 * default applies (`print(x, end='\\n')` without `end`). The canvas folds
 * them behind ▼.
 */
export function isAdvancedPin(pin: Pin): boolean {
  return (
    pin.direction === 'in' &&
    pin.kind === 'data' &&
    pin.range === undefined &&
    getMeta<InputPinMeta>(pin).optional === true &&
    (pin.literal?.value ?? '') !== ''
  );
}

/** Math signs of binary operators (`*` is a small superscript in most fonts). */
const GLYPHS: Record<string, string> = { '*': '×', '/': '÷' };

/** Text in the middle of a compact node (`SET` for setters). */
export function compactTitle(node: GraphNode): string {
  if (isSetter(node)) {
    return 'SET';
  }

  const binary =
    node.pins.filter((p) => p.direction === 'in' && p.kind === 'data')
      .length === 2;
  return (isOperatorGlyph(node) && binary && GLYPHS[node.title]) || node.title;
}

/**
 * The label drawn next to a pin. Compact nodes show none, except the
 * value input of a setter: the variable's name, like UE's SET node.
 */
export function pinLabel(node: GraphNode, pin: Pin): string {
  if (!isCompact(node)) {
    return pin.name;
  }

  return isSetter(node) && pin.direction === 'in' && pin.kind === 'data'
    ? node.title.slice('Set '.length)
    : '';
}

/** Icon before a node's title, like UE's function and event icons. */
export type HeaderIcon = 'function' | 'event' | 'branch' | 'loop' | 'unknown';

export function headerIcon(node: GraphNode): HeaderIcon | undefined {
  if (isCompact(node)) {
    return undefined;
  }

  switch (node.category) {
    case 'event': {
      return 'event';
    }

    case 'entry':
    case 'function':
    case 'pure':
    case 'return': {
      return 'function';
    }

    case 'flow': {
      if (node.kind === 'forEach' || node.kind === 'loop') {
        return 'loop';
      }

      return node.kind === 'branch' || node.kind === 'switch'
        ? 'branch'
        : undefined;
    }

    case 'unknown': {
      return 'unknown';
    }

    default: {
      return undefined;
    }
  }
}

/** Latent nodes (`await`) show a clock at the right of the header. */
export function isLatent(node: GraphNode): boolean {
  return node.category === 'latent' && !isCompact(node);
}

/** Space of a header icon (icon and gap). */
export const ICON_SPACE = 18;

function sortPins(pins: ReadonlyArray<Pin>): Pin[] {
  // Exec pins first, then data pins, each keeping their declared order.
  return [
    ...pins.filter((p) => p.kind === 'exec'),
    ...pins.filter((p) => p.kind === 'data'),
  ];
}

export function literalWidth(pin: Pin, measure: MeasureText): number {
  if (!pin.literal) {
    return 0;
  }

  if (pin.literal.kind === 'boolean') {
    return NODE_METRICS.checkboxSize;
  }

  return Math.min(
    measure(pin.literal.value || ' ', 'literal') +
      NODE_METRICS.literalPadding * 2,
    NODE_METRICS.literalMaxWidth
  );
}

function pinColumnWidth(
  node: GraphNode,
  pin: Pin,
  measure: MeasureText
): number {
  const text = pinLabel(node, pin);
  const label = text ? measure(text, 'label') : 0;
  const literal = literalWidth(pin, measure);
  return (
    NODE_METRICS.pinRadius * 2 +
    NODE_METRICS.pinLabelGap +
    label +
    (literal ? (label ? 6 : 0) + literal : 0)
  );
}

export function computeNodeGeometry(
  node: GraphNode,
  measure: MeasureText = approximateMeasureText
): NodeGeometry {
  const left = sortPins(node.pins.filter((p) => p.direction === 'in'));
  const right = sortPins(node.pins.filter((p) => p.direction === 'out'));
  const compact = isCompact(node);
  const rows = Math.max(left.length, right.length, compact ? 1 : 0);

  const headerHeight = compact
    ? 0
    : NODE_METRICS.headerHeight +
      (node.subtitle ? NODE_METRICS.subtitleHeight : 0);

  const leftWidth = Math.max(
    0,
    ...left.map((p) => pinColumnWidth(node, p, measure))
  );
  const rightWidth = Math.max(
    0,
    ...right.map((p) => pinColumnWidth(node, p, measure))
  );

  let width: number;
  let height: number;
  if (compact) {
    const titleWidth = Math.max(
      measure(compactTitle(node), isOperatorGlyph(node) ? 'glyph' : 'compact'),
      node.subtitle ? measure(node.subtitle, 'subtitle') : 0
    );
    width =
      leftWidth +
      rightWidth +
      titleWidth +
      NODE_METRICS.paddingX * 2 +
      (leftWidth && rightWidth ? 0 : 4);
    height =
      rows * NODE_METRICS.rowHeight + NODE_METRICS.compactPaddingY * 2 - 4;
  } else {
    const icons =
      (headerIcon(node) ? ICON_SPACE : 0) + (isLatent(node) ? ICON_SPACE : 0);
    const titleWidth = Math.max(
      measure(node.title, 'title') + icons,
      node.subtitle ? measure(node.subtitle, 'subtitle') : 0
    );
    width = Math.max(
      titleWidth + NODE_METRICS.paddingX * 2 + 8,
      leftWidth +
        rightWidth +
        NODE_METRICS.paddingX * 2 +
        (leftWidth && rightWidth ? NODE_METRICS.columnGap : 0)
    );
    height = headerHeight + rows * NODE_METRICS.rowHeight + 8;
  }

  width = Math.ceil(Math.max(width, compact ? 40 : NODE_METRICS.minWidth));
  height = Math.ceil(height);

  const pins = new Map<string, PinGeometry>();
  const rowTop = compact ? NODE_METRICS.compactPaddingY - 2 : headerHeight + 4;
  const rowY = (row: number): number =>
    compact && rows === 1
      ? height / 2
      : rowTop + row * NODE_METRICS.rowHeight + NODE_METRICS.rowHeight / 2;

  for (const [row, pin] of left.entries()) {
    pins.set(pin.id, {
      pin,
      x: NODE_METRICS.pinInset,
      y: rowY(row),
      side: 'left',
      row,
    });
  }

  for (const [row, pin] of right.entries()) {
    pins.set(pin.id, {
      pin,
      x: width - NODE_METRICS.pinInset,
      y: rowY(row),
      side: 'right',
      row,
    });
  }

  return {
    width,
    height,
    headerHeight,
    leftColumn: leftWidth,
    rightColumn: rightWidth,
    pins,
  };
}
