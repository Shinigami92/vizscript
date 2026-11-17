import type { ColorScheme, DataType } from '@vizscript/core';
import {
  isArrayType,
  isMapType,
  isSetType,
  mapValueType,
  pinColor,
} from '@vizscript/core';

/** Which Blueprint container symbol a pin type gets, if any. */
export type ContainerShape = 'array' | 'map' | 'set';

export function containerShape(type: DataType): ContainerShape | undefined {
  if (isArrayType(type)) {
    return 'array';
  }

  if (isMapType(type)) {
    return 'map';
  }

  return isSetType(type) ? 'set' : undefined;
}

/** How a container symbol is painted: filled (a wired pin) or outlined. */
interface Paint {
  filled: boolean;
  lineWidth?: number;
}

function paint(
  ctx: CanvasRenderingContext2D,
  color: string,
  { filled, lineWidth = 1 }: Paint
): void {
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/** UE's array symbol: a 3×3 grid of squares in the element color. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  how: Paint
): void {
  const gap = size * 0.12;
  const cell = (size - gap * 2) / 3;
  const left = x - size / 2;
  const top = y - size / 2;
  ctx.beginPath();
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      ctx.rect(left + col * (cell + gap), top + row * (cell + gap), cell, cell);
    }
  }

  paint(ctx, color, how);
}

/**
 * UE's map symbol: a column of three small squares in the key color and
 * three wide rows in the value color beside it.
 */
function drawMapList(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  keyColor: string,
  valueColor: string,
  how: Paint
): void {
  const gap = size * 0.12;
  const cell = (size - gap * 2) / 3;
  const left = x - size / 2;
  const top = y - size / 2;
  ctx.beginPath();
  for (let row = 0; row < 3; row++) {
    ctx.rect(left, top + row * (cell + gap), cell, cell);
  }

  paint(ctx, keyColor, how);
  ctx.beginPath();
  for (let row = 0; row < 3; row++) {
    ctx.rect(
      left + cell + gap,
      top + row * (cell + gap),
      size - cell - gap,
      cell
    );
  }

  paint(ctx, valueColor, how);
}

/** UE's set symbol: curly braces `{ }` in the element color. */
function drawBraces(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  lineWidth: number
): void {
  const h = size / 2;
  const w = size * 0.3;
  const inner = size * 0.12;
  ctx.beginPath();
  for (const dir of [-1, 1]) {
    // From the tip (outside, middle) along the brace to its ends (inside).
    const tip = x + dir * (size / 2);
    const stem = tip - dir * w * 0.55;
    const end = x + dir * inner;
    ctx.moveTo(end, y - h);
    ctx.quadraticCurveTo(stem, y - h, stem, y - h * 0.45);
    ctx.lineTo(stem, y - h * 0.25);
    ctx.quadraticCurveTo(stem, y, tip, y);
    ctx.quadraticCurveTo(stem, y, stem, y + h * 0.25);
    ctx.lineTo(stem, y + h * 0.45);
    ctx.quadraticCurveTo(stem, y + h, end, y + h);
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/**
 * The symbol of a container pin (`type` must have a `containerShape`) of
 * `size` around (`x`, `y`): filled when the pin is wired, like UE's.
 */
export function drawContainerPin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  type: DataType,
  scheme: ColorScheme,
  connected: boolean
): void {
  const color = pinColor(type, scheme);
  switch (containerShape(type)) {
    case 'array': {
      drawGrid(ctx, x, y, size, color, { filled: connected });
      break;
    }

    case 'map': {
      drawMapList(
        ctx,
        x,
        y,
        size,
        color,
        // An untyped map is one color, like an untyped array.
        type === 'map' ? color : pinColor(mapValueType(type), scheme),
        { filled: connected }
      );
      break;
    }

    case 'set': {
      drawBraces(ctx, x, y, size + 2, color, connected ? 2 : 1.4);
      break;
    }

    default: {
      break;
    }
  }
}

/**
 * UE's big faded container symbol behind the word of a container node
 * (GET), in the element's colors. Untyped containers draw nothing.
 */
export function drawContainerSymbol(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  type: DataType,
  scheme: ColorScheme
): void {
  if (type === 'array' || type === 'map' || type === 'set') {
    return;
  }

  const shape = containerShape(type);
  if (!shape) {
    return;
  }

  ctx.save();
  ctx.globalAlpha = scheme === 'dark' ? 0.32 : 0.26;
  if (shape === 'set') {
    drawBraces(ctx, x, y, size, pinColor(type, scheme), size * 0.14);
  } else {
    drawContainerPin(ctx, x, y, size, type, scheme, true);
  }

  ctx.restore();
}
