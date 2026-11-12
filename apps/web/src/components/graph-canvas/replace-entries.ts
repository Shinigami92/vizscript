import type { GraphOp } from '@vizscript/core';
import { isTypeCompatible, referenceName } from '@vizscript/core';
import type { ActionEntry } from '../ActionMenu.vue';
import { callSignature, scopeVariables, withImport } from './graph-helpers';
import { ICON_CALL, ICON_IMPORT, ICON_SET, ICON_VARIABLE } from './menu-data';
import type { CanvasContext } from './types';

export interface ReplaceEntries {
  /** "Replace with…": other variables for a Get / Set, functions for a call. */
  replaceEntries: (nodeId: string) => ActionEntry[];
  replaceTitle: (nodeId: string) => string;
  replaceSuggest: (nodeId: string, query: string) => ActionEntry[];
}

/** The action menu of "Replace variable…" / "Replace function…". */
export function createReplaceEntries(ctx: CanvasContext): ReplaceEntries {
  const { props, emitOp } = ctx;

  function replaceEntries(nodeId: string): ActionEntry[] {
    const entry = ctx.index.value.nodes.get(nodeId);
    const current = entry ? referenceName(entry.node) : undefined;
    if (!entry || !current) {
      return [];
    }

    const replace = (name: string): GraphOp => ({
      type: 'replaceReference',
      node: nodeId,
      name,
    });
    if (entry.node.kind === 'call') {
      return [
        ...ctx.callables.value
          .filter((callee) => callee !== current)
          .map((callee): ActionEntry => ({
            label: callee,
            category: 'Functions',
            icon: ICON_CALL,
            detail: callSignature(props.doc, props.text, callee).detail,
            keywords: callee,
            action: () => emitOp(replace(callee)),
          })),
        ...ctx.externalNames.value
          .filter((e) => e.kind === 'function' && e.callee !== current)
          .map((external): ActionEntry => ({
            label: external.callee,
            category: 'Functions',
            icon: ICON_IMPORT,
            detail: external.detail,
            hint: external.where,
            keywords: `${external.callee} ${external.path} import`,
            action: () =>
              emitOp(withImport(external, replace(external.callee))),
          })),
      ];
    }

    const isSet = entry.node.kind === 'setVar';
    const pin = entry.node.pins.find(
      (p) => p.kind === 'data' && p.direction === (isSet ? 'in' : 'out')
    );
    return scopeVariables(props.doc, entry.fn.id)
      .filter((v) => v.expression !== current && !(isSet && v.constant))
      .map((variable): ActionEntry => ({
        label: variable.expression,
        category: 'Variables',
        icon: isSet ? ICON_SET : ICON_VARIABLE,
        hint: variable.type,
        keywords: variable.expression,
        ...(pin
          ? {
              fits: isSet
                ? isTypeCompatible(pin.type, variable.dataType)
                : isTypeCompatible(variable.dataType, pin.type),
            }
          : {}),
        action: () => emitOp(replace(variable.expression)),
      }));
  }

  function replaceTitle(nodeId: string): string {
    const node = ctx.index.value.nodes.get(nodeId)?.node;
    return `Replace ${node ? (referenceName(node) ?? node.title) : ''} with`;
  }

  function replaceSuggest(nodeId: string, query: string): ActionEntry[] {
    const name = query.trim();
    return /^[A-Za-z_$#][\w$]*(?:\.[A-Za-z_$#][\w$]*)*$/.test(name)
      ? [
          {
            label: `Replace with ${name}`,
            category: 'Typed',
            icon: 'i-mdi-swap-horizontal',
            action: () =>
              emitOp({ type: 'replaceReference', node: nodeId, name }),
          },
        ]
      : [];
  }

  return { replaceEntries, replaceTitle, replaceSuggest };
}
