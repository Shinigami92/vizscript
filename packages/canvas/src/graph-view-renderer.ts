import { conversionLabel, pinColor } from '@vizscript/core';
import type { GraphEdge, PinGeometry, Point } from '@vizscript/core';
import { wireCurve } from './bezier';
import type { WireShape } from './bezier';
import {
  normalizeRect,
  rectsIntersect,
  visibleWorldRect,
  worldToScreen,
} from './camera';
import type { Rect } from './camera';
import {
  COMMENT_HEADER,
  FRAME_HEADER,
  KNOT_RADIUS,
  knotId,
} from './graph-view-constants';
import { GraphViewNodes } from './graph-view-nodes';
import type { FrameState, NodeState } from './graph-view-types';
import type { Theme } from './theme';

/** Draws a frame: grid, frames, comment boxes, wires, nodes, overlay. */
export abstract class GraphViewRenderer extends GraphViewNodes {
  /** Switches colors, e.g. between `DARK_THEME` and `LIGHT_THEME`. */
  public setTheme(theme: Theme): void {
    this.theme = theme;
    this.requestRender();
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    if (!this.hasFramed && this.nodes.size > 0 && this.width > 0) {
      this.hasFramed = true;
      this.initialView();
    }

    this.render();
  }

  // ------------------------------------------------------------- rendering

  protected override render(): void {
    this.frameTime = performance.now();
    const moving = this.stepMotion(this.frameTime);
    if (moving) {
      this.requestRender();
    }

    const { ctx, camera, theme } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawGrid();

    if (!this.doc) {
      return;
    }

    ctx.setTransform(
      this.dpr * camera.zoom,
      0,
      0,
      this.dpr * camera.zoom,
      -camera.x * camera.zoom * this.dpr,
      -camera.y * camera.zoom * this.dpr
    );

    const view = visibleWorldRect(camera, this.width, this.height);
    this.updateFrames();
    this.drawFrames(view);
    this.drawWires(view);

    const visible = this.index.query(view);
    const selected: NodeState[] = [];
    for (const id of visible) {
      const ns = this.nodes.get(id);
      if (!ns) {
        continue;
      }

      if (this.selection.has(id)) {
        selected.push(ns);
      } else {
        this.drawNodeAnimated(ns);
      }
    }

    for (const ns of selected) {
      this.drawNodeAnimated(ns);
    }

    this.drawOverlay();
  }

  private drawGrid(): void {
    const { ctx, camera, theme } = this;
    const minor = 16;
    const major = 128;

    const drawLines = (
      spacing: number,
      color: string,
      lineWidth: number
    ): void => {
      const step = spacing * camera.zoom;
      if (step < 6) {
        return;
      }

      ctx.beginPath();
      const startX = -((camera.x * camera.zoom) % step);
      const startY = -((camera.y * camera.zoom) % step);
      for (let x = startX; x < this.width; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, this.height);
      }

      for (let y = startY; y < this.height; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(this.width, Math.round(y) + 0.5);
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    };

    drawLines(minor, theme.gridMinor, 1);
    drawLines(major, theme.gridMajor, 1.5);
  }

  private drawFrames(view: Rect): void {
    const { ctx, theme } = this;
    // Function frames, then comment boxes from the outside in.
    const frames = this.frames.toSorted(
      (a, b) =>
        Number(a.kind === 'comment') - Number(b.kind === 'comment') ||
        b.nodeIds.length - a.nodeIds.length
    );
    for (const frame of frames) {
      const b = frame.bounds;
      if (!b || !rectsIntersect(b, view)) {
        continue;
      }

      if (frame.kind === 'comment') {
        this.drawCommentBox(frame, b);
        continue;
      }

      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.width, b.height, 12);
      ctx.fillStyle = theme.frameFill;
      ctx.fill();
      ctx.strokeStyle = theme.frameBorder;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (this.camera.zoom > 0.15) {
        ctx.fillStyle = theme.frameTitle;
        ctx.font = `600 18px ${theme.fontFamily}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(frame.name, b.x + 16, b.y + FRAME_HEADER / 2 + 4);
      }
    }
  }

  private drawCommentBox(frame: FrameState, b: Rect): void {
    const { ctx, theme } = this;
    const selected =
      frame.nodeIds.length > 0 &&
      frame.nodeIds.every((id) => this.selection.has(id));
    // UE-like comment colors: a tinted body and a stronger header.
    const color = frame.boxId ? this.boxColors.get(frame.boxId) : undefined;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.width, b.height, 6);
    ctx.fillStyle = color ? `${color}1f` : theme.commentFill;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = color ? `${color}66` : theme.commentHeader;
    ctx.fillRect(b.x, b.y, b.width, COMMENT_HEADER);
    ctx.restore();
    ctx.strokeStyle = selected
      ? theme.selection
      : color
        ? `${color}aa`
        : theme.commentBorder;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();

    if (this.camera.zoom > 0.15) {
      ctx.fillStyle = theme.commentTitle;
      ctx.font = `600 14px ${theme.fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const title = frame.name || 'Comment';
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.width - 8, COMMENT_HEADER);
      ctx.clip();
      ctx.globalAlpha = frame.name ? 1 : 0.5;
      ctx.fillText(title, b.x + 10, b.y + COMMENT_HEADER / 2 + 1);
      ctx.restore();
    }
  }

  private isEdgeHighlighted(edge: GraphEdge): boolean {
    if (edge.id === this.hoverEdge) {
      return true;
    }

    for (const id of [edge.from.node, edge.to.node]) {
      if (id === this.hoverNode || this.selection.has(id)) {
        return true;
      }
    }

    return false;
  }

  private drawWires(view: Rect): void {
    const highlighted: Array<{ edge: GraphEdge; wire: WireShape[] }> = [];
    for (const { edge } of this.edges) {
      const wire = this.edgeWire(edge);
      if (!wire || !wire.some((shape) => rectsIntersect(shape.bounds, view))) {
        continue;
      }

      if (this.isEdgeHighlighted(edge)) {
        highlighted.push({ edge, wire });
      } else {
        this.drawWire(edge, wire, false);
      }
    }

    for (const { edge, wire } of highlighted) {
      this.drawWire(edge, wire, true);
    }

    this.drawKnots(view);
  }

  private drawKnots(view: Rect): void {
    const { ctx, theme } = this;
    for (const [edgeId, points] of this.reroutes) {
      const edge = this.edgesById.get(edgeId);
      if (!edge) {
        continue;
      }

      const color = this.wireColor(edge);
      for (const [index, p] of points.entries()) {
        if (
          p.x < view.x - KNOT_RADIUS ||
          p.y < view.y - KNOT_RADIUS ||
          p.x > view.x + view.width + KNOT_RADIUS ||
          p.y > view.y + view.height + KNOT_RADIUS
        ) {
          continue;
        }

        const selected = this.knotSelection.has(knotId(edgeId, index));
        ctx.beginPath();
        ctx.arc(p.x, p.y, KNOT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = theme.nodeBody;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, KNOT_RADIUS - 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (selected) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, KNOT_RADIUS + 3, 0, Math.PI * 2);
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
  }

  private wireColor(edge: GraphEdge): string {
    if (edge.kind === 'exec') {
      return this.theme.exec;
    }

    const pin = this.nodes
      .get(edge.from.node)
      ?.geom.pins.get(edge.from.pin)?.pin;
    return pinColor(pin?.type ?? 'any', this.theme.scheme);
  }

  private drawWire(
    edge: GraphEdge,
    shapes: ReadonlyArray<WireShape>,
    highlighted: boolean
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    for (const wire of shapes) {
      if (wire.type === 'curve') {
        const c = wire.curve;
        ctx.moveTo(c.p0.x, c.p0.y);
        ctx.bezierCurveTo(c.c0.x, c.c0.y, c.c1.x, c.c1.y, c.p1.x, c.p1.y);
        continue;
      }

      const [first, ...rest] = wire.points;
      if (first) {
        ctx.moveTo(first.x, first.y);
      }

      for (const [i, point] of rest.entries()) {
        const next = rest[i + 1];
        if (next) {
          ctx.arcTo(point.x, point.y, next.x, next.y, 14);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }
    }

    ctx.strokeStyle = this.wireColor(edge);
    const base = edge.kind === 'exec' ? 3 : 2.2;
    ctx.lineWidth = highlighted ? base + 1.5 : base;
    ctx.globalAlpha =
      highlighted || (this.selection.size === 0 && !this.hoverNode) ? 1 : 0.6;
    // A wire only the graph has (not in the code yet) is dashed.
    ctx.setLineDash(edge.graphOnly ? [8, 6] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawOverlay(): void {
    const { ctx, theme } = this;
    const drag = this.drag;
    if (drag?.type === 'marquee') {
      const rect = normalizeRect(drag.startWorld, drag.currentWorld);
      ctx.fillStyle = theme.marqueeFill;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = theme.marqueeBorder;
      ctx.lineWidth = 1 / this.camera.zoom;
      ctx.setLineDash([6 / this.camera.zoom, 4 / this.camera.zoom]);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.setLineDash([]);
    }

    if (drag?.type === 'moveWires') {
      const end = drag.target
        ? this.pinWorld(drag.target.ns, drag.target.pg)
        : drag.currentWorld;
      for (const other of drag.ends) {
        this.drawLooseWire(other, end, drag.target !== null);
      }

      const count = drag.ends.length;
      if (drag.problem) {
        this.drawWireMessage(drag.currentWorld, drag.problem, 'error');
      } else if (drag.target) {
        this.drawWireMessage(
          drag.currentWorld,
          `Moves ${count} wire${count === 1 ? '' : 's'} here`,
          'ok'
        );
      }
    }

    if (drag?.type === 'wire') {
      this.drawLooseWire(
        drag.from,
        drag.target
          ? this.pinWorld(drag.target.ns, drag.target.pg)
          : drag.currentWorld,
        drag.target !== null
      );
      if (drag.problem) {
        this.drawWireMessage(drag.currentWorld, drag.problem, 'error');
      } else if (drag.convert) {
        this.drawWireMessage(
          drag.currentWorld,
          conversionLabel(drag.convert),
          'convert'
        );
      } else if (drag.replaces) {
        this.drawWireMessage(
          drag.currentWorld,
          'Replaces the current wire',
          'ok'
        );
      } else if (!drag.target && drag.empty) {
        this.drawWireMessage(drag.currentWorld, 'Place a new node.', 'place');
      }
    } else if (this.pendingWire) {
      this.drawLooseWire(this.pendingWire.from, this.pendingWire.world, false);
    }
  }

  /**
   * The message next to the cursor while a wire is dragged, like UE's: why
   * the pin under it doesn't fit, that the wire replaces another one, or
   * that dropping it places a new node. Drawn in screen space so it stays
   * readable at any zoom.
   */
  private drawWireMessage(
    world: Point,
    text: string,
    kind: 'ok' | 'error' | 'place' | 'convert'
  ): void {
    const { ctx, theme } = this;
    const at = worldToScreen(this.camera, world);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `12px ${theme.fontFamily}`;
    const icon = 14;
    const width = ctx.measureText(text).width + icon + 22;
    const x = Math.min(at.x + 16, this.width - width - 4);
    const y = at.y + 18;
    ctx.beginPath();
    ctx.roundRect(x, y, width, 24, 4);
    ctx.fillStyle = theme.bubbleFill;
    ctx.fill();
    // ✓, ✕ or a new node
    const cx = x + 8 + icon / 2;
    const cy = y + 12;
    ctx.beginPath();
    if (kind === 'place') {
      ctx.roundRect(cx - 6, cy - 5, 12, 10, 2);
      ctx.moveTo(cx - 6, cy - 1.5);
      ctx.lineTo(cx + 6, cy - 1.5);
    } else if (kind === 'convert') {
      // Two pins with an arrow between them, like UE's conversion icon.
      ctx.arc(cx - 4.5, cy, 2.2, 0, Math.PI * 2);
      ctx.moveTo(cx + 6.7, cy);
      ctx.arc(cx + 4.5, cy, 2.2, 0, Math.PI * 2);
      ctx.moveTo(cx - 1.5, cy);
      ctx.lineTo(cx + 1.8, cy);
      ctx.moveTo(cx + 0.3, cy - 1.5);
      ctx.lineTo(cx + 1.8, cy);
      ctx.lineTo(cx + 0.3, cy + 1.5);
    } else if (kind === 'ok') {
      ctx.moveTo(cx - 5, cy);
      ctx.lineTo(cx - 1.5, cy + 4);
      ctx.lineTo(cx + 5, cy - 4);
    } else {
      ctx.moveTo(cx - 4, cy - 4);
      ctx.lineTo(cx + 4, cy + 4);
      ctx.moveTo(cx + 4, cy - 4);
      ctx.lineTo(cx - 4, cy + 4);
    }

    ctx.strokeStyle =
      kind === 'place'
        ? theme.bubbleText
        : kind === 'ok' || kind === 'convert'
          ? '#16a34a'
          : theme.errorBanner;
    ctx.lineWidth = kind === 'place' || kind === 'convert' ? 1.4 : 2.2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.fillStyle = theme.bubbleText;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + icon + 14, cy + 0.5);
    ctx.restore();
  }

  private drawLooseWire(
    from: { ns: NodeState; pg: PinGeometry },
    end: Point,
    attached: boolean
  ): void {
    const { ctx, theme } = this;
    const start = this.pinWorld(from.ns, from.pg);
    const pin = from.pg.pin;
    const wire =
      pin.direction === 'out' ? wireCurve(start, end) : wireCurve(end, start);
    ctx.beginPath();
    ctx.moveTo(wire.p0.x, wire.p0.y);
    ctx.bezierCurveTo(
      wire.c0.x,
      wire.c0.y,
      wire.c1.x,
      wire.c1.y,
      wire.p1.x,
      wire.p1.y
    );
    ctx.strokeStyle =
      pin.kind === 'exec' ? theme.exec : pinColor(pin.type, theme.scheme);
    ctx.lineWidth = pin.kind === 'exec' ? 3 : 2.2;
    ctx.setLineDash(attached ? [] : [8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
