import { VizBuildInGetNodeModel } from '@/shared/models/nodes/VizBuildInGetNodeModel';
import { isRecordObject } from '@/shared/utilities/common';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { ref, Ref } from 'vue';
import { VizOutputSlot } from '../slots/VizOutputSlot';
import { AbstractVizNode } from './AbstractVizNode';

export interface VizBuildInGetNode extends AbstractVizNode<'build-in-get'> {
  name: string;
  outputSlot: VizOutputSlot;
}

export function convertBuildInGetNode(model: VizBuildInGetNodeModel): Ref<VizBuildInGetNode> {
  return ref<VizBuildInGetNode>({ model, ...model, outputSlot: { name: model.name, connected: false } });
}

export function isBuildInGetNode(modelValue: unknown): modelValue is VizBuildInGetNode {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (typeof modelValue.name !== 'string') {
    return false;
  }
  if (!isPositionable(modelValue)) {
    return false;
  }
  return true;
}
