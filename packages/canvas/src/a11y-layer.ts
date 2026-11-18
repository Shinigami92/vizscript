import type { GraphNode, Pin, PinGeometry } from '@vizscript/core';
import {
  compactTitle,
  NODE_METRICS,
  pinKey,
  spreadName,
} from '@vizscript/core';
import type { Camera } from './camera';
import type { NodeState } from './graph-view-types';
import type { Scene } from './scene';

/**
 * The graph as invisible DOM over the canvas: one element per node, pin,
 * inline value and "Add pin ⊕", at the place the canvas draws it. Screen
 * readers and UI tests (Playwright's `getByRole`, `boundingBox`) read it;
 * the canvas still gets every pointer event (the layer takes none).
 *
 * Kept cheap for large graphs: a camera move rewrites one transform, and a
 * node is written again only when it moved or its content changed.
 */

/** The few DOM features the layer uses (tests count the writes). */
export interface A11yElement {
  style: { cssText: string };
  setAttribute: (name: string, value: string) => void;
  append: (...children: A11yElement[]) => void;
  replaceChildren: (...children: A11yElement[]) => void;
  remove: () => void;
}

export interface A11yDocument {
  createElement: (tag: 'div') => A11yElement;
}

/** A pin, an inline value or "Add pin ⊕" of a node, relative to it. */
export interface A11yPart {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `data-*` attributes that name it (`pin`, `literal`, `add-pin`). */
  data: Readonly<Record<string, string>>;
}

export interface A11yNodeInfo {
  label: string;
  /** World rectangle of the node. */
  x: number;
  y: number;
  width: number;
  height: number;
  parts: A11yPart[];
}

/** Side of the square a pin answers on (larger than its circle). */
const PIN_TARGET = (NODE_METRICS.pinRadius + 3) * 2;
/** Height of the "Add pin ⊕" button's row. */
const ADD_PIN_HEIGHT = 16;

function nodeLabel(scene: Scene, ns: NodeState): string {
  const node = ns.node;
  const title = compactTitle(node) || node.title || node.kind;
  const notes = [
    ns.full.graphOnly ? 'not in code' : '',
    scene.problems.get(node.id) ?? '',
  ].filter(Boolean);
  return [title, ...notes].join(', ');
}

function pinName(pin: Pin): string {
  const name = spreadName(pin);
  if (name) {
    return name;
  }

  if (pin.kind === 'exec') {
    return pin.direction === 'in' ? 'exec' : 'then';
  }

  return pin.direction === 'in' ? 'value' : 'result';
}

function pinLabel(node: GraphNode, pin: Pin, wired: boolean): string {
  const type = pin.kind === 'exec' ? 'exec' : String(pin.type);
  const side = pin.direction === 'in' ? 'input' : 'output';
  return `${pinName(pin)}, ${type}, ${side}${wired ? ', wired' : ''}`;
}

/** What a node is, for the layer (world units; parts relative to it). */
export function describeNode(scene: Scene, ns: NodeState): A11yNodeInfo {
  const parts: A11yPart[] = [];
  for (const pg of ns.geom.pins.values()) {
    parts.push(...pinParts(scene, ns, pg));
  }

  const add = ns.geom.addPin;
  if (add) {
    parts.push({
      label: 'Add pin',
      x: add.x,
      y: add.y - ADD_PIN_HEIGHT / 2,
      width: add.width,
      height: ADD_PIN_HEIGHT,
      data: { 'add-pin': 'true' },
    });
  }

  return {
    label: nodeLabel(scene, ns),
    x: ns.x,
    y: ns.y,
    width: ns.geom.width,
    height: ns.geom.height,
    parts,
  };
}

function pinParts(scene: Scene, ns: NodeState, pg: PinGeometry): A11yPart[] {
  const pin = pg.pin;
  const wired = scene.connectedPins.has(
    pinKey({ node: ns.node.id, pin: pin.id })
  );
  const parts: A11yPart[] = [
    {
      label: pinLabel(ns.node, pin, wired),
      x: pg.x - PIN_TARGET / 2,
      y: pg.y - PIN_TARGET / 2,
      width: PIN_TARGET,
      height: PIN_TARGET,
      data: { pin: pin.id },
    },
  ];
  const literal = scene.literalRect(ns, pg);
  if (literal && pin.literal) {
    parts.push({
      label: `Value of ${pinName(pin)}: ${pin.literal.value}`,
      x: literal.x - ns.x,
      y: literal.y - ns.y,
      width: literal.width,
      height: literal.height,
      data: { literal: pin.id },
    });
  }

  return parts;
}

function box(r: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  return `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;`;
}

/** What a node element was written from, to skip unchanged nodes. */
interface Shown {
  el: A11yElement;
  ns: NodeState;
  node: GraphNode;
  geom: NodeState['geom'];
  x: number;
  y: number;
  selected: boolean;
  /** Its labels and parts, as text. */
  content: string;
}

const ROOT_STYLE =
  'position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:0;contain:strict;';

export class A11yLayer {
  private readonly root: A11yElement;
  private readonly world: A11yElement;
  private readonly shown = new Map<string, Shown>();
  private camera = '';
  /** The scene's edges when last written: a new document replaced them. */
  private edges: unknown = null;
  private problems: unknown = null;

  public constructor(
    private readonly doc: A11yDocument,
    parent: A11yElement
  ) {
    this.root = doc.createElement('div');
    this.root.setAttribute('data-ui', 'graph-a11y');
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Nodes of the graph');
    this.root.style.cssText = ROOT_STYLE;
    this.world = doc.createElement('div');
    this.world.style.cssText =
      'position:absolute;left:0;top:0;transform-origin:0 0;';
    this.root.append(this.world);
    parent.append(this.root);
  }

  /** Writes what changed since the last call. */
  public sync(
    scene: Scene,
    camera: Camera,
    selection: ReadonlySet<string>
  ): void {
    const transform = `translate(${-camera.x * camera.zoom}px,${-camera.y * camera.zoom}px) scale(${camera.zoom})`;
    if (transform !== this.camera) {
      this.camera = transform;
      this.world.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:${transform};`;
    }

    // A new document (or new problems) can change any node's content.
    const reload =
      scene.edges !== this.edges || scene.problems !== this.problems;
    this.edges = scene.edges;
    this.problems = scene.problems;
    for (const [id, ns] of scene.nodes) {
      this.syncNode(scene, id, ns, selection.has(id), reload);
    }

    for (const [id, shown] of this.shown) {
      if (!scene.nodes.has(id)) {
        shown.el.remove();
        this.shown.delete(id);
      }
    }
  }

  private syncNode(
    scene: Scene,
    id: string,
    ns: NodeState,
    selected: boolean,
    reload: boolean
  ): void {
    const prev = this.shown.get(id);
    const same =
      prev !== undefined &&
      prev.ns === ns &&
      prev.node === ns.node &&
      prev.geom === ns.geom &&
      prev.selected === selected;
    if (same && !reload && prev.x === ns.x && prev.y === ns.y) {
      return;
    }

    const info = describeNode(scene, ns);
    const content = `${info.label}\n${JSON.stringify(info.parts)}`;
    const el = prev?.el ?? this.doc.createElement('div');
    if (!prev) {
      el.setAttribute('role', 'group');
      el.setAttribute('data-node-id', id);
      this.world.append(el);
    }

    if (!prev || prev.x !== ns.x || prev.y !== ns.y || prev.geom !== ns.geom) {
      el.style.cssText = box(info);
    }

    if (!prev || prev.selected !== selected) {
      el.setAttribute('data-selected', String(selected));
    }

    if (!prev || prev.content !== content) {
      el.setAttribute('aria-label', info.label);
      el.replaceChildren(...info.parts.map((part) => this.partElement(part)));
    }

    this.shown.set(id, {
      el,
      ns,
      node: ns.node,
      geom: ns.geom,
      x: ns.x,
      y: ns.y,
      selected,
      content,
    });
  }

  private partElement(part: A11yPart): A11yElement {
    const el = this.doc.createElement('div');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', part.label);
    for (const [key, value] of Object.entries(part.data)) {
      el.setAttribute(`data-${key}`, value);
    }

    el.style.cssText = box(part);
    return el;
  }

  public destroy(): void {
    this.root.remove();
    this.shown.clear();
  }
}
