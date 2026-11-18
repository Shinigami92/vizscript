import { Controller } from './controller';
import { GraphViewDocument } from './graph-view-document';
import type { GraphViewOptions } from './graph-view-types';

/**
 * Framework-agnostic Canvas2D renderer and interaction controller for
 * Blueprint-style graphs.
 */
export class GraphView extends GraphViewDocument {
  private readonly resizeObserver: ResizeObserver;
  private readonly controller: Controller;
  private stopWatchingPixelRatio: (() => void) | undefined;

  public constructor(
    canvas: HTMLCanvasElement,
    options: GraphViewOptions = {}
  ) {
    super(canvas, options);
    this.controller = new Controller({
      canvas,
      scene: this.scene,
      viewport: this.viewport,
      ui: this.ui,
      editable: () => this.editable,
      conversions: () => this.conversions(),
      emit: (event, payload) => this.emitter.emit(event, payload),
      requestRender: () => this.requestRender(),
      hitTest: (world) => this.hitTest(world),
      setSelection: (selection) => this.setSelectionInternal(selection),
      setHover: (nodeId, pin) => this.setHover(nodeId, pin),
      setHoverEdge: (edgeId) => this.setHoverEdge(edgeId),
      setHoverAddPin: (nodeId) => this.setHoverAddPin(nodeId),
      setCamera: (camera) => this.setCameraInternal(camera),
      finishNodeMoves: () => this.finishNodeMoves(),
      toggleAdvanced: (ns) => this.toggleAdvanced(ns),
      getReroutes: (edgeId) => this.getReroutes(edgeId),
      addReroute: (edgeId, world) => this.addReroute(edgeId, world),
      removeReroute: (edgeId, index) => this.removeReroute(edgeId, index),
      deleteSelectedKnots: () => this.deleteSelectedKnots(),
      editComment: (target) => this.editComment(target),
      startLiteralEdit: (ns, pg) => this.startLiteralEdit(ns, pg),
      selectAll: () => this.selectAll(),
      alignSelection: (mode) => this.alignSelection(mode),
      frameSelection: () => this.frameSelection(),
      frameAll: () => this.frameAll(),
    });
    this.controller.attach();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.watchPixelRatio();
    this.resize();
  }

  public destroy(): void {
    this.stopRendering();
    this.stopWatchingPixelRatio?.();
    this.resizeObserver.disconnect();
    this.controller.detach();

    this.emitter.clear();
  }

  /**
   * Redraws sharp when the pixel ratio changes (the window moved to another
   * screen, browser zoom): the canvas keeps its CSS size, so the resize
   * observer doesn't fire.
   */
  private watchPixelRatio(): void {
    const query = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`
    );
    const onChange = (): void => {
      this.resize();
      this.watchPixelRatio();
    };
    query.addEventListener('change', onChange, { once: true });
    this.stopWatchingPixelRatio = () =>
      query.removeEventListener('change', onChange);
  }
}
