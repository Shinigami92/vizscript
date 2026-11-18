import {
  conversionLabel,
  GRID_MAJOR,
  GRID_SIZE,
  pinColor,
} from '@vizscript/core';
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
import type { FontMetrics } from './font-metrics';
import {
  COMMENT_HEADER,
  FRAME_HEADER,
  KNOT_RADIUS,
  knotId,
} from './graph-view-constants';
import type { FrameState, NodeState } from './graph-view-types';
import { NodeRenderer } from './node-renderer';
import type { RenderFrame } from './render-frame';
import type { Scene } from './scene';
import type { Theme } from './theme';
import type { Viewport } from './viewport';

/** Draws a frame: grid, frames, comment boxes, wires, nodes, overlay. */
export class Renderer {
  private state!: RenderFrame;
  private readonly nodes: NodeRenderer;

  public constructor(
    private readonly ctx: CanvasRenderingContext2D,
    metrics: FontMetrics,
    private readonly scene: Scene,
    private readonly viewport: Viewport,
    private theme: Theme
  ) {
    this.nodes = new NodeRenderer(ctx, metrics, scene, viewport, theme);
  }

  public setTheme(theme: Theme): void {
    this.theme = theme;
    this.nodes.setTheme(theme);
  }

  /** Draws the scene as `state` shows it. */
  public draw(state: RenderFrame): void {
    this.state = state;
    const { ctx, theme } = this;
    const { camera, width, height, dpr } = this.viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);
    this.drawGrid();

    if (!this.scene.doc) {
      return;
    }

    ctx.setTransform(
      dpr * camera.zoom,
      0,
      0,
      dpr * camera.zoom,
      -camera.x * camera.zoom * dpr,
      -camera.y * camera.zoom * dpr
    );

    const view = visibleWorldRect(camera, width, height);
    this.scene.updateFrames();
    this.drawFrames(view);
    this.drawWires(view);

    // Selected nodes are drawn last, on top.
    const selected: NodeState[] = [];
    for (const id of this.scene.index.query(view)) {
      const ns = this.scene.nodes.get(id);
      if (!ns) {
        continue;
      }

      if (state.selection.has(id)) {
        selected.push(ns);
      } else {
        this.nodes.draw(ns, state);
      }
    }

    for (const ns of selected) {
      this.nodes.draw(ns, state);
    }

    this.drawOverlay();
  }

  private drawGrid(): void {
    const { ctx, theme } = this;
    const { camera } = this.viewport;
    const minor = GRID_SIZE;
    const major = GRID_MAJOR;

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
      for (let x = startX; x < this.viewport.width; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, this.viewport.height);
      }

      for (let y = startY; y < this.viewport.height; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(this.viewport.width, Math.round(y) + 0.5);
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
    const frames = this.scene.frames.toSorted(
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

      if (this.viewport.camera.zoom > 0.15) {
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
      frame.nodeIds.every((id) => this.state.selection.has(id));
    // UE-like comment colors: a tinted body and a stronger header.
    const color = frame.boxId
      ? this.scene.boxColors.get(frame.boxId)
      : undefined;
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

    if (this.viewport.camera.zoom > 0.15) {
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
    if (edge.id === this.state.hoverEdge) {
      return true;
    }

    for (const id of [edge.from.node, edge.to.node]) {
      if (id === this.state.hoverNode || this.state.selection.has(id)) {
        return true;
      }
    }

    return false;
  }

  private drawWires(view: Rect): void {
    const highlighted: Array<{ edge: GraphEdge; wire: WireShape[] }> = [];
    for (const { edge } of this.scene.edges) {
      const wire = this.scene.edgeWire(edge);
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
    for (const [edgeId, points] of this.scene.reroutes) {
      const edge = this.scene.edgesById.get(edgeId);
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

        const selected = this.state.knotSelection.has(knotId(edgeId, index));
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

    const pin = this.scene.nodes
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
    for (const { curve: c } of shapes) {
      ctx.moveTo(c.p0.x, c.p0.y);
      ctx.bezierCurveTo(c.c0.x, c.c0.y, c.c1.x, c.c1.y, c.p1.x, c.p1.y);
    }

    ctx.strokeStyle = this.wireColor(edge);
    const base = edge.kind === 'exec' ? 3 : 2.2;
    ctx.lineWidth = highlighted ? base + 1.5 : base;
    ctx.globalAlpha =
      highlighted || (this.state.selection.size === 0 && !this.state.hoverNode)
        ? 1
        : 0.6;
    // A wire only the graph has (not in the code yet) is dashed.
    ctx.setLineDash(edge.graphOnly ? [8, 6] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawOverlay(): void {
    const { ctx, theme } = this;
    const drag = this.state.drag;
    if (drag?.type === 'marquee') {
      const rect = normalizeRect(drag.startWorld, drag.currentWorld);
      ctx.fillStyle = theme.marqueeFill;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = theme.marqueeBorder;
      ctx.lineWidth = 1 / this.viewport.camera.zoom;
      ctx.setLineDash([
        6 / this.viewport.camera.zoom,
        4 / this.viewport.camera.zoom,
      ]);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.setLineDash([]);
    }

    if (drag?.type === 'moveWires') {
      const end = drag.target
        ? this.scene.pinWorld(drag.target.ns, drag.target.pg)
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
          ? this.scene.pinWorld(drag.target.ns, drag.target.pg)
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
          `Replace existing ${drag.replaces} connections`,
          'ok'
        );
      } else if (drag.target) {
        // UE's plain ✓ for a pin that fits.
        this.drawWireMessage(drag.currentWorld, '', 'ok');
      } else if (drag.empty) {
        this.drawWireMessage(drag.currentWorld, 'Place a new node.', 'place');
      }
    } else if (this.state.pendingWire) {
      this.drawLooseWire(
        this.state.pendingWire.from,
        this.state.pendingWire.world,
        false
      );
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
    const at = worldToScreen(this.viewport.camera, world);
    ctx.save();
    ctx.setTransform(this.viewport.dpr, 0, 0, this.viewport.dpr, 0, 0);
    ctx.font = `12px ${theme.fontFamily}`;
    const icon = 14;
    const width = text ? ctx.measureText(text).width + icon + 22 : icon + 14;
    const x = Math.min(at.x + 16, this.viewport.width - width - 4);
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
      // UE's ⊘
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      ctx.moveTo(cx - 3.9, cy + 3.9);
      ctx.lineTo(cx + 3.9, cy - 3.9);
    }

    ctx.strokeStyle =
      kind === 'place'
        ? theme.bubbleText
        : kind === 'ok' || kind === 'convert'
          ? '#16a34a'
          : theme.errorBanner;
    ctx.lineWidth =
      kind === 'place' || kind === 'convert'
        ? 1.4
        : kind === 'error'
          ? 1.8
          : 2.2;
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
    const start = this.scene.pinWorld(from.ns, from.pg);
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
