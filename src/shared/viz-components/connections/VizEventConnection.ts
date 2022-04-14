import type { VizEventConnectionModel } from '@/shared/models/connections/VizEventConnectionModel';
import { isRecordObject } from '@/shared/utilities/common';
import type { Positionable } from '@/shared/viz-components/Positionable';
import { isPositionable } from '@/shared/viz-components/Positionable';
import type { Ref } from 'vue';
import { computed, ref } from 'vue';
import type { VizNode } from '../nodes/VizNode';
import type { AbstractVizConnection } from './AbstractVizConnection';

export interface VizEventConnection extends AbstractVizConnection<'event'> {}

export function convertEventConnection(
  model: VizEventConnectionModel,
  nodes: Array<Ref<VizNode>>,
): Ref<VizEventConnection> {
  const startNode = nodes.find(
    (node) => node.value.model?.id === model.startNodeId,
  );
  if (!startNode) {
    throw Error("[convertEventConnection] startNode wasn't found");
  }
  const endNode = nodes.find(
    (node) => node.value.model?.id === model.endNodeId,
  );
  if (!endNode) {
    throw Error("[convertEventConnection] endNode wasn't found");
  }
  return ref({
    model,
    ...model,
    start: computed(() => calculateOutputEventEmitterPosition(startNode.value)),
    end: computed(() => calculateInputEventReceiverPosition(endNode.value)),
  });
}

export function isEventConnection(
  modelValue: unknown,
): modelValue is VizEventConnection {
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

export function calculateInputEventReceiverPosition(
  vizNode: VizNode,
): Positionable {
  switch (vizNode.type) {
    case 'caller-function':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const eventReceiverIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .inputs .icon',
        );
        if (!eventReceiverIcon) {
          throw Error(
            `[calculateInputEventReceiverPosition] Emitter Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const emitterIconRect = eventReceiverIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (emitterIconRect.left - nodeRect.left) +
            emitterIconRect.width / 2,
          y:
            vizNode.y +
            (emitterIconRect.top - nodeRect.top) +
            emitterIconRect.height / 2,
        };
      }
      return { x: vizNode.x + 14, y: vizNode.y + 82 };
    case 'function':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const eventReceiverIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .inputs .icon',
        );
        if (!eventReceiverIcon) {
          throw Error(
            `[calculateInputEventReceiverPosition] Emitter Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const emitterIconRect = eventReceiverIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (emitterIconRect.left - nodeRect.left) +
            emitterIconRect.width / 2,
          y:
            vizNode.y +
            (emitterIconRect.top - nodeRect.top) +
            emitterIconRect.height / 2,
        };
      }
      return { x: vizNode.x + 14, y: vizNode.y + 82 };
    case 'set':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const eventReceiverIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .inputs .icon',
        );
        if (!eventReceiverIcon) {
          throw Error(
            `[calculateInputEventReceiverPosition] Emitter Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const emitterIconRect = eventReceiverIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (emitterIconRect.left - nodeRect.left) +
            emitterIconRect.width / 2,
          y:
            vizNode.y +
            (emitterIconRect.top - nodeRect.top) +
            emitterIconRect.height / 2,
        };
      }
      return { x: vizNode.x + 14, y: vizNode.y + 82 };
    default:
      throw Error(
        `[calculateInputEventReceiverPosition] Unsupported node type ${vizNode.type}`,
      );
  }
}

export function calculateOutputEventEmitterPosition(
  vizNode: VizNode,
): Positionable {
  switch (vizNode.type) {
    case 'event-start':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const eventEmitterIcon =
          vizNodeDiv.querySelector<HTMLSpanElement>('.body .icon');
        if (!eventEmitterIcon) {
          throw Error(
            `[calculateOutputEventEmitterPosition] Emitter Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const emitterIconRect = eventEmitterIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (emitterIconRect.left - nodeRect.left) +
            emitterIconRect.width / 2,
          y:
            vizNode.y +
            (emitterIconRect.top - nodeRect.top) +
            emitterIconRect.height / 2,
        };
      }
      return { x: vizNode.x + 174, y: vizNode.y + 82 };
    case 'function':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const eventEmitterIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .outputs .icon',
        );
        if (!eventEmitterIcon) {
          throw Error(
            `[calculateOutputEventEmitterPosition] Emitter Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const emitterIconRect = eventEmitterIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (emitterIconRect.left - nodeRect.left) +
            emitterIconRect.width / 2,
          y:
            vizNode.y +
            (emitterIconRect.top - nodeRect.top) +
            emitterIconRect.height / 2,
        };
      }
      return { x: vizNode.x + 160, y: vizNode.y + 82 };
    case 'set':
      if (vizNode.vizNodeDivRef) {
        const vizNodeDiv = vizNode.vizNodeDivRef;
        const eventEmitterIcon = vizNodeDiv.querySelector<HTMLSpanElement>(
          '.body .outputs .icon',
        );
        if (!eventEmitterIcon) {
          throw Error(
            `[calculateOutputEventEmitterPosition] Emitter Icon wasn't found ${JSON.stringify(
              vizNode,
            )}`,
          );
        }
        const nodeRect = vizNodeDiv.getBoundingClientRect();
        const emitterIconRect = eventEmitterIcon.getBoundingClientRect();
        return {
          x:
            vizNode.x +
            (emitterIconRect.left - nodeRect.left) +
            emitterIconRect.width / 2,
          y:
            vizNode.y +
            (emitterIconRect.top - nodeRect.top) +
            emitterIconRect.height / 2,
        };
      }
      return { x: vizNode.x + 160, y: vizNode.y + 82 };
    default:
      throw Error(
        `[calculateOutputEventEmitterPosition] Unsupported node type ${vizNode.type}`,
      );
  }
}
