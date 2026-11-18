import type { Conversion, Point } from '@vizscript/core';
import { Emitter } from './emitter';
import { FontMetrics } from './font-metrics';
import { wireTolerance } from './graph-view-constants';
import type {
  GraphViewEvents,
  GraphViewOptions,
  Hit,
} from './graph-view-types';
import { newInteraction } from './interaction';
import { Renderer } from './renderer';
import { Scene } from './scene';
import { DARK_THEME } from './theme';
import type { Theme } from './theme';
import { Viewport } from './viewport';

/** State of a `GraphView` and the geometry all its parts share. */
export abstract class GraphViewBase {
  protected readonly ctx: CanvasRenderingContext2D;
  protected readonly emitter = new Emitter<GraphViewEvents>();
  protected readonly metrics: FontMetrics;
  protected readonly scene: Scene;
  protected readonly viewport = new Viewport();
  protected readonly ui = newInteraction();
  protected readonly renderer: Renderer;

  protected theme: Theme;
  protected editable: boolean;

  protected motion: boolean;
  protected conversions: () => ReadonlyArray<Conversion> | undefined;

  private frameRequest: number | null = null;
  /** Set by `destroy`: no more frames. */
  protected destroyed = false;
  protected hasFramed = false;

  public constructor(
    protected readonly canvas: HTMLCanvasElement,
    options: GraphViewOptions = {}
  ) {
    const ctx = canvas.getContext('2d');
    const measureCtx = document.createElement('canvas').getContext('2d');
    if (!ctx || !measureCtx) {
      throw new Error('Canvas 2D is not supported');
    }

    this.ctx = ctx;
    this.theme = options.theme ?? DARK_THEME;
    this.metrics = new FontMetrics(measureCtx, this.theme);
    this.scene = new Scene(this.metrics.measure);
    this.renderer = new Renderer(
      ctx,
      this.metrics,
      this.scene,
      this.viewport,
      this.theme
    );
    this.editable = options.editable ?? true;
    this.motion = options.motion ?? false;
    this.conversions = options.conversions ?? ((): undefined => undefined);
  }

  public on<K extends keyof GraphViewEvents>(
    event: K,
    handler: (payload: GraphViewEvents[K]) => void
  ): () => void {
    return this.emitter.on(event, handler);
  }

  /** Draws a frame; `requestRender` schedules one. */
  protected abstract render(): void;

  public requestRender(): void {
    if (this.frameRequest !== null || this.destroyed) {
      return;
    }

    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = null;
      this.render();
    });
  }

  /** Cancels the next frame; tweens can't request new ones. */
  protected stopRendering(): void {
    this.destroyed = true;
    if (this.frameRequest !== null) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
  }

  /** What is under a world point (`Scene.hitTest`). */
  protected hitTest(world: Point): Hit | null {
    return this.scene.hitTest(world, {
      zoom: this.viewport.camera.zoom,
      editable: this.editable,
      selection: this.ui.selection,
    });
  }

  protected wireTolerance(): number {
    return wireTolerance(this.viewport.camera.zoom);
  }

  protected setSelectionInternal(selection: Set<string>): void {
    const changed =
      selection.size !== this.ui.selection.size ||
      [...selection].some((id) => !this.ui.selection.has(id));
    this.ui.selection = selection;
    if (changed) {
      this.emitter.emit('selectionChange', { nodeIds: [...selection] });
    }

    this.requestRender();
  }

  protected setHover(nodeId: string | null, pin: string | null): void {
    if (nodeId === this.ui.hoverNode && pin === this.ui.hoverPin) {
      return;
    }

    this.ui.hoverNode = nodeId;
    this.ui.hoverPin = pin;
    this.emitter.emit('hoverChange', { nodeId, pin });
    this.requestRender();
  }

  /** Under the cursor: the node whose "Add pin +" button it is on. */
  protected setHoverAddPin(nodeId: string | null): void {
    if (nodeId !== this.ui.hoverAddPin) {
      this.ui.hoverAddPin = nodeId;
      this.requestRender();
    }
  }

  protected setHoverEdge(edgeId: string | null): void {
    if (edgeId === this.ui.hoverEdge) {
      return;
    }

    this.ui.hoverEdge = edgeId;
    this.emitter.emit('wireHoverChange', {
      edge: edgeId ? (this.scene.edgesById.get(edgeId) ?? null) : null,
    });
    this.requestRender();
  }
}
