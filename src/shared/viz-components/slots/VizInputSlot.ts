import type { VizNode } from '../nodes/VizNode';

export interface VizInputSlot {
  name: string;
  connected: boolean;
  connectedToNode?: { node: VizNode | undefined; slot: number } | null;
}
