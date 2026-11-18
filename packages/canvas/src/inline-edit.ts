import type { LiteralKind, PinGeometry } from '@vizscript/core';
import { BUBBLE_GAP } from './bubble';
import { worldToScreen } from './camera';
import type { Camera, Rect } from './camera';
import { COMMENT_HEADER } from './graph-view-constants';
import type { CommentTarget, NodeState } from './graph-view-types';
import type { Scene } from './scene';

/**
 * Where the editor of a node comment (its bubble, or room for a new one)
 * or a comment box title goes, in world units, and its text.
 */
export function commentEdit(
  scene: Scene,
  target: CommentTarget
): { world: Rect; value: string } | null {
  if (target.kind === 'node') {
    const ns = scene.nodes.get(target.nodeId);
    if (!ns) {
      return null;
    }

    const bubble = scene.bubbleRect(ns) ?? {
      x: ns.x,
      y: ns.y - BUBBLE_GAP - 60,
      width: ns.geom.width,
      height: 60,
    };
    const width = Math.max(bubble.width, 220);
    const height = Math.max(bubble.height, 60);
    return {
      value: ns.node.comment?.text ?? '',
      world: {
        x: bubble.x,
        y: Math.min(bubble.y, ns.y - BUBBLE_GAP - height),
        width,
        height,
      },
    };
  }

  scene.updateFrames();
  const frame = scene.frames.find((f) => f.boxId === target.boxId);
  if (!frame?.bounds) {
    return null;
  }

  return {
    value: frame.name,
    world: {
      x: frame.bounds.x,
      y: frame.bounds.y,
      width: Math.max(frame.bounds.width, 160),
      height: COMMENT_HEADER,
    },
  };
}

/** Where the editor of an unwired input's value goes, and its value. */
export function literalEdit(
  scene: Scene,
  ns: NodeState,
  pg: PinGeometry
): { world: Rect; value: string; kind: LiteralKind } | null {
  const world = scene.literalRect(ns, pg);
  const literal = pg.pin.literal;
  return world && literal
    ? { world, value: literal.value, kind: literal.kind }
    : null;
}

/** A world rectangle in client (viewport) coordinates. */
export function clientRect(
  camera: Camera,
  canvas: { left: number; top: number },
  world: Rect
): Rect {
  const topLeft = worldToScreen(camera, { x: world.x, y: world.y });
  return {
    x: canvas.left + topLeft.x,
    y: canvas.top + topLeft.y,
    width: world.width * camera.zoom,
    height: world.height * camera.zoom,
  };
}
