import type { VizSlotConnectionModel } from '@/shared/models/connections/VizSlotConnectionModel';
import { isRecordObject } from '@/shared/utilities/common';
import type { Positionable } from '@/shared/viz-components/Positionable';
import { isPositionable } from '@/shared/viz-components/Positionable';
import type { Ref } from 'vue';
import { computed, ref } from 'vue';
import type { VizNode } from '../nodes/VizNode';
import type { AbstractVizConnection } from './AbstractVizConnection';

export interface VizSlotConnection extends AbstractVizConnection<'slot'> {}

export function convertSlotConnection(
  model: VizSlotConnectionModel,
  nodes: Array<Ref<VizNode>>,
): Ref<VizSlotConnection> {
  const startNode = nodes.find(
    (node) => node.value.model?.id === model.startNodeId,
  );
  if (!startNode) {
    throw Error("[convertSlotConnection] startNode wasn't found");
  }
  const endNode = nodes.find(
    (node) => node.value.model?.id === model.endNodeId,
  );
  if (!endNode) {
    throw Error("[convertSlotConnection] endNode wasn't found");
  }
  return ref({
    model,
    ...model,
    start: computed(() =>
      calculateOutputSlotPosition(startNode.value, model.startSlot),
    ),
    startNode: startNode.value,
    end: computed(() =>
      calculateInputSlotPosition(endNode.value, model.endSlot),
    ),
    endNode: endNode.value,
  });
}

export function isSlotConnection(
  modelValue: unknown,
): modelValue is VizSlotConnection {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (!isPositionable(modelValue.start)) {
    return false;
  }
  if (!isPositionable(modelValue.end)) {
    return false;
  }
  return true;
}

export function calculateOutputSlotPosition(
  vizNode: VizNode,
  slot: number = 1,
): Positionable {
  switch (vizNode.type) {
    case 'function':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const slotIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .outputs .viz-output-slot .icon',
        );
        if (!slotIcon) {
          throw Error(
            `[calculateOutputSlotPosition] Output Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const slotIconRect = slotIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (slotIconRect.left - nodeRect.left) +
            slotIconRect.width / 2,
          y:
            vizNode.y +
            (slotIconRect.top - nodeRect.top) +
            slotIconRect.height / 2 -
            2, // -2 for offset
        };
      }
      return { x: vizNode.x + 163, y: vizNode.y + 134 };
    case 'set':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const slotIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .viz-output-slot .icon',
        );
        if (!slotIcon) {
          throw Error(
            `[calculateOutputSlotPosition] Output Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const slotIconRect = slotIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (slotIconRect.left - nodeRect.left) +
            slotIconRect.width / 2,
          y:
            vizNode.y +
            (slotIconRect.top - nodeRect.top) +
            slotIconRect.height / 2 -
            2, // -2 for offset
        };
      }
      return { x: vizNode.x + 103, y: vizNode.y + 14 };
    case 'build-in-get':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const slotIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .viz-output-slot .icon',
        );
        if (!slotIcon) {
          throw Error(
            `[calculateOutputSlotPosition] Output Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const slotIconRect = slotIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (slotIconRect.left - nodeRect.left) +
            slotIconRect.width / 2,
          y:
            vizNode.y +
            (slotIconRect.top - nodeRect.top) +
            slotIconRect.height / 2 -
            2, // -2 for offset
        };
      }
      return { x: vizNode.x + 103, y: vizNode.y + 14 };
    case 'variable-get':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const slotIcon =
          vizNodeDiv.querySelector<HTMLSpanElement>('.body .icon');
        if (!slotIcon) {
          throw Error(
            `[calculateOutputSlotPosition] Output Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const slotIconRect = slotIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (slotIconRect.left - nodeRect.left) +
            slotIconRect.width / 2,
          y:
            vizNode.y +
            (slotIconRect.top - nodeRect.top) +
            slotIconRect.height / 2 -
            2, // -2 for offset
        };
      }
      return { x: vizNode.x + 103, y: vizNode.y + 14 };
    default:
      throw Error(
        `[calculateOutputSlotPosition] Unsupported node type ${vizNode.type}`,
      );
  }
}

export function calculateInputSlotPosition(
  vizNode: VizNode,
  slot: number = 1,
): Positionable {
  switch (vizNode.type) {
    case 'caller-function':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const slotIcon = vizNodeDiv.querySelectorAll<HTMLSpanElement>(
          '.body .inputs .viz-input-slot .icon',
        )[slot - 1];
        if (!slotIcon) {
          throw Error(
            `[calculateInputSlotPosition] Input Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const slotIconRect = slotIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (slotIconRect.left - nodeRect.left) +
            slotIconRect.width / 2,
          y:
            vizNode.y +
            (slotIconRect.top - nodeRect.top) +
            slotIconRect.height / 2 -
            2, // -2 for offset
        };
      }
      return { x: vizNode.x + 17, y: vizNode.y + 168 };
    case 'function':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const slotIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .inputs .viz-input-slot .icon',
        );
        if (!slotIcon) {
          throw Error(
            `[calculateInputSlotPosition] Input Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const slotIconRect = slotIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (slotIconRect.left - nodeRect.left) +
            slotIconRect.width / 2,
          y:
            vizNode.y +
            (slotIconRect.top - nodeRect.top) +
            slotIconRect.height / 2 -
            2, // -2 for offset
        };
      }
      return { x: vizNode.x + 17, y: vizNode.y + 134 };
    case 'set':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const slotIcon = vizNodeDiv.querySelectorAll<HTMLSpanElement>(
          '.body .inputs .viz-input-slot .icon',
        )[slot - 1];
        if (!slotIcon) {
          throw Error(
            `[calculateInputSlotPosition] Input Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const slotIconRect = slotIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (slotIconRect.left - nodeRect.left) +
            slotIconRect.width / 2,
          y:
            vizNode.y +
            (slotIconRect.top - nodeRect.top) +
            slotIconRect.height / 2 -
            2, // -2 for offset
        };
      }
      return { x: vizNode.x + 17, y: vizNode.y + 168 };
    default:
      throw Error(
        `[calculateInputSlotPosition] Unsupported node type ${vizNode.type}`,
      );
  }
}
