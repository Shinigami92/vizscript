import type { Point } from '@vizscript/core';
import { easeOut } from './camera';
import {
  NODE_APPEAR_MS,
  NODE_MOTION_MS,
  NODE_PULSE_MS,
  samePoint,
} from './graph-view-constants';
import type { NodeState } from './graph-view-types';

/**
 * Lets a node that was already shown slide from where it is drawn to its
 * new position (`ns.x`, `ns.y`). A slide to the same target keeps going.
 */
export function continueMove(
  previous: NodeState | undefined,
  ns: NodeState,
  now: number
): void {
  if (!previous) {
    return;
  }

  const to = { x: ns.x, y: ns.y };
  if (previous.tween && samePoint(previous.tween.to, to)) {
    ns.tween = previous.tween;
  } else if (!samePoint(previous, to)) {
    ns.tween = { from: { x: previous.x, y: previous.y }, to, start: now };
  } else {
    return;
  }

  ns.x = previous.x;
  ns.y = previous.y;
}

/** Starts a slide of a node to `to`. */
export function slideTo(ns: NodeState, to: Point, now: number): void {
  ns.tween = { from: { x: ns.x, y: ns.y }, to, start: now };
}

/**
 * Fades in nodes an edit added. Only when some nodes stay, so opening
 * another file just shows it.
 */
export function fadeInAdded(
  nodes: ReadonlyMap<string, NodeState>,
  previous: ReadonlyMap<string, NodeState>,
  now: number
): void {
  if (previous.size === 0) {
    return;
  }

  const added = [...nodes.values()].filter((ns) => !previous.has(ns.node.id));
  if (added.length === nodes.size) {
    return;
  }

  for (const ns of added) {
    ns.appear = now;
  }
}

/** Puts sliding nodes at their targets; returns the ones that were. */
export function finishMoves(nodes: Iterable<NodeState>): NodeState[] {
  const finished: NodeState[] = [];
  for (const ns of nodes) {
    if (ns.tween) {
      ns.x = ns.tween.to.x;
      ns.y = ns.tween.to.y;
      ns.tween = undefined;
      finished.push(ns);
    }
  }

  return finished;
}

/** Ends slides, fade-ins and pulses at once (motion turned off). */
export function stopMotion(nodes: Iterable<NodeState>): NodeState[] {
  const all = [...nodes];
  for (const ns of all) {
    ns.appear = undefined;
    ns.pulse = undefined;
  }

  return finishMoves(all);
}

/** What `stepNodes` did. */
export interface NodeStep {
  /** A node moved. */
  moved: boolean;
  /** Nodes whose slide ended (they are where they go now). */
  settled: NodeState[];
  /** A slide, fade-in or pulse goes on. */
  running: boolean;
}

/** Advances slides, fade-ins and pulses to `now`. */
export function stepNodes(nodes: Iterable<NodeState>, now: number): NodeStep {
  const step: NodeStep = { moved: false, settled: [], running: false };
  for (const ns of nodes) {
    const move = ns.tween;
    if (move) {
      const t = (now - move.start) / NODE_MOTION_MS;
      const k = easeOut(t);
      ns.x = move.from.x + (move.to.x - move.from.x) * k;
      ns.y = move.from.y + (move.to.y - move.from.y) * k;
      step.moved = true;
      if (t >= 1) {
        ns.tween = undefined;
        step.settled.push(ns);
      } else {
        step.running = true;
      }
    }

    if (ns.appear !== undefined && now - ns.appear >= NODE_APPEAR_MS) {
      ns.appear = undefined;
    }

    if (ns.pulse !== undefined && now - ns.pulse >= NODE_PULSE_MS) {
      ns.pulse = undefined;
    }

    step.running ||= ns.appear !== undefined || ns.pulse !== undefined;
  }

  return step;
}
