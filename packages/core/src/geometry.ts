import type { GraphNode, Pin } from './ir';

export type TextStyle = 'title' | 'subtitle' | 'label' | 'literal' | 'compact';

/** Measures the rendered width of `text` in pixels for a given style. */
export type MeasureText = (text: string, style: TextStyle) => number;

const APPROX_CHAR_WIDTH: Record<TextStyle, number> = {
  title: 7.5,
  subtitle: 6,
  label: 6.6,
  literal: 6.6,
  compact: 8.5,
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

  return Math.min(
    measure(pin.literal.value || ' ', 'literal') +
      NODE_METRICS.literalPadding * 2,
    NODE_METRICS.literalMaxWidth
  );
}

function pinColumnWidth(
  pin: Pin,
  measure: MeasureText,
  hideLabels: boolean
): number {
  const label = hideLabels || !pin.name ? 0 : measure(pin.name, 'label');
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
  const rows = Math.max(left.length, right.length, node.compact ? 1 : 0);
  const compact = node.compact === true;

  const headerHeight = compact
    ? 0
    : NODE_METRICS.headerHeight +
      (node.subtitle ? NODE_METRICS.subtitleHeight : 0);

  const leftWidth = Math.max(
    0,
    ...left.map((p) => pinColumnWidth(p, measure, compact))
  );
  const rightWidth = Math.max(
    0,
    ...right.map((p) => pinColumnWidth(p, measure, compact))
  );

  let width: number;
  let height: number;
  if (compact) {
    const titleWidth = measure(node.title, 'compact');
    width =
      leftWidth +
      rightWidth +
      titleWidth +
      NODE_METRICS.paddingX * 2 +
      (leftWidth && rightWidth ? 0 : 4);
    height =
      rows * NODE_METRICS.rowHeight + NODE_METRICS.compactPaddingY * 2 - 4;
  } else {
    const titleWidth = Math.max(
      measure(node.title, 'title'),
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
