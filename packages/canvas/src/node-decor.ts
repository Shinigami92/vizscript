import type { HeaderIcon, TextStyle } from '@vizscript/core';
import { compactTitle, NODE_METRICS, pinColor } from '@vizscript/core';
import type { Rect } from './camera';
import type { NodeState } from './graph-view-types';
import type { Theme } from './theme';

/**
 * Parts of a node that need only the canvas, the theme and the zoom: UE's
 * glows, rims, the SET title, header icons, the latent clock and checkboxes.
 */
export interface NodePainter {
  ctx: CanvasRenderingContext2D;
  theme: Theme;
  font: (style: TextStyle) => string;
  /** Screen pixels per world unit (zoom × device pixel ratio). */
  scale: number;
}

/**
 * The glow of a Get pill: its type's color around the middle right,
 * fading out to the edges, and a gloss over the top half (UE).
 */
export function drawPillGlow(
  paint: NodePainter,
  ns: NodeState,
  radius: number
): void {
  const { ctx, theme } = paint;
  const { node, geom } = ns;
  const out = node.pins.find((p) => p.direction === 'out' && p.kind === 'data');
  if (!out) {
    return;
  }

  const color = pinColor(out.type, theme.scheme);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(ns.x, ns.y, geom.width, geom.height, radius);
  ctx.clip();
  ctx.save();
  // An ellipse: as wide as the pill, a little taller than it.
  ctx.translate(ns.x + geom.width * 0.64, ns.y + geom.height * 0.55);
  ctx.scale(1, Math.min(1, (geom.height * 1.5) / geom.width));
  const reach = geom.width * 0.62;
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
  glow.addColorStop(0, `${color}${theme.pillTint}`);
  glow.addColorStop(0.5, `${color}${theme.pillTintMid}`);
  glow.addColorStop(1, `${color}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
  ctx.restore();
  const shine = ctx.createLinearGradient(ns.x, ns.y, ns.x, ns.y + geom.height);
  shine.addColorStop(0, theme.pillShine);
  shine.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = shine;
  ctx.fillRect(ns.x, ns.y, geom.width, geom.height);
  ctx.restore();
}

/**
 * UE's light rim inside the outline: along the top of every node, fading
 * downward, and as a glare on the top left of Get pills.
 */
export function drawRim(
  paint: NodePainter,
  ns: NodeState,
  radius: number,
  pill: boolean
): void {
  const { ctx, theme } = paint;
  const { geom } = ns;
  const inset = 1.25;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(
    ns.x + inset,
    ns.y + inset,
    geom.width - inset * 2,
    geom.height - inset * 2,
    Math.max(0, radius - inset)
  );
  // The faint rim along the top, fading downward.
  const rim = ctx.createLinearGradient(
    ns.x,
    ns.y,
    ns.x,
    ns.y + Math.min(geom.height, 14)
  );
  rim.addColorStop(0, theme.rimLight);
  rim.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1;
  ctx.stroke();
  if (pill) {
    // A short glare around the top-left corner, fading smoothly into the
    // top edge and down the left side.
    const corner = Math.max(radius, 6);
    const cx = ns.x + corner * 0.9;
    const cy = ns.y + corner * 0.4;
    const glare = ctx.createRadialGradient(cx, cy, 0, cx, cy, corner * 1.6);
    glare.addColorStop(0, theme.pillGlare);
    glare.addColorStop(0.3, theme.pillGlare);
    glare.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.strokeStyle = glare;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  ctx.restore();
}

/** Y of the exec row of a SET node (its first row). */
function execRowY(ns: NodeState): number {
  for (const pg of ns.geom.pins.values()) {
    if (pg.pin.kind === 'exec') {
      return ns.y + pg.y;
    }
  }

  return ns.y + NODE_METRICS.rowHeight / 2;
}

/** `SET` centered in the exec row, how it declares (`const`) beside it. */
export function drawSetTitle(
  paint: NodePainter,
  ns: NodeState,
  sub: string
): void {
  const { ctx, theme } = paint;
  const y = execRowY(ns);
  ctx.save();
  ctx.font = paint.font('compact');
  const title = compactTitle(ns.node);
  const titleWidth = ctx.measureText(title).width;
  ctx.font = paint.font('subtitle');
  const subWidth = sub ? ctx.measureText(sub).width + 6 : 0;
  const left = ns.x + (ns.geom.width - titleWidth - subWidth) / 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = paint.font('compact');
  ctx.fillStyle = theme.nodeText;
  if (theme.scheme === 'dark') {
    const scale = paint.scale;
    ctx.shadowColor = theme.titleShadow;
    ctx.shadowBlur = 2 * scale;
    ctx.shadowOffsetY = 1 * scale;
  }

  ctx.fillText(title, left, y);
  if (sub) {
    ctx.shadowColor = 'transparent';
    ctx.font = paint.font('subtitle');
    ctx.fillStyle = theme.compactSubtext;
    ctx.fillText(sub, left + titleWidth + 6, y + 1);
  }

  ctx.restore();
}

/**
 * UE's SET node: a haze of the value's type color along the top, and a
 * gloss over the exec row.
 */
export function drawSetGlow(
  paint: NodePainter,
  ns: NodeState,
  radius: number
): void {
  const { ctx, theme } = paint;
  const { node, geom } = ns;
  const value = node.pins.find(
    (p) => p.direction === 'in' && p.kind === 'data'
  );
  if (!value) {
    return;
  }

  const color = pinColor(value.type, theme.scheme);
  const rowY = execRowY(ns);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(ns.x, ns.y, geom.width, geom.height, radius);
  ctx.clip();
  ctx.save();
  const reach = geom.width * 0.6;
  ctx.translate(ns.x + geom.width / 2, rowY - 2);
  ctx.scale(1, Math.min(1, (NODE_METRICS.rowHeight * 1.3) / reach));
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
  glow.addColorStop(0, `${color}${theme.pillTint}`);
  glow.addColorStop(0.5, `${color}${theme.pillTintMid}`);
  glow.addColorStop(1, `${color}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
  ctx.restore();
  const shine = ctx.createLinearGradient(ns.x, ns.y, ns.x, rowY + 8);
  shine.addColorStop(0, theme.pillShine);
  shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = shine;
  ctx.fillRect(ns.x, ns.y, geom.width, rowY + 8 - ns.y);
  ctx.restore();
}

/**
 * Header icons like UE's: ƒ for functions, a diamond for events, a fork
 * for branches, a circular arrow for loops (12 px, centered on `x`, `y`).
 */
export function drawHeaderIcon(
  paint: NodePainter,
  icon: HeaderIcon,
  x: number,
  y: number,
  color: string
): void {
  const { ctx } = paint;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (icon) {
    case 'function':
    case 'unknown': {
      ctx.font = `italic 600 15px Georgia, "Times New Roman", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon === 'function' ? 'ƒ' : '?', x, y + 1);
      break;
    }

    case 'event': {
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'branch': {
      ctx.beginPath();
      ctx.moveTo(x - 6, y);
      ctx.lineTo(x - 1, y);
      ctx.moveTo(x - 1, y);
      ctx.lineTo(x + 5, y - 5);
      ctx.moveTo(x - 1, y);
      ctx.lineTo(x + 5, y + 5);
      ctx.stroke();
      break;
    }

    case 'loop': {
      ctx.beginPath();
      ctx.arc(x, y, 5, Math.PI * 0.15, Math.PI * 1.75);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 5.5, y - 5);
      ctx.lineTo(x + 5, y - 1);
      ctx.lineTo(x + 1.5, y - 2.5);
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}

/** UE's clock on latent nodes (`await`). */
export function drawClock(
  paint: NodePainter,
  x: number,
  y: number,
  color: string
): void {
  const { ctx } = paint;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 3.5);
  ctx.moveTo(x, y);
  ctx.lineTo(x + 2.5, y + 1.5);
  ctx.stroke();
  ctx.restore();
}

/** UE's checkbox for boolean values. */
export function drawCheckbox(
  paint: NodePainter,
  rect: Rect,
  checked: boolean
): void {
  const { ctx, theme } = paint;
  const size = NODE_METRICS.checkboxSize;
  const x = rect.x;
  const y = rect.y + (rect.height - size) / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 3);
  ctx.fillStyle = theme.literalBackground;
  ctx.fill();
  ctx.strokeStyle = theme.pinLabel;
  ctx.lineWidth = 1;
  ctx.stroke();
  if (checked) {
    ctx.beginPath();
    ctx.moveTo(x + 3, y + size / 2);
    ctx.lineTo(x + size / 2 - 1, y + size - 4);
    ctx.lineTo(x + size - 3, y + 3.5);
    ctx.strokeStyle = theme.literalText;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}
