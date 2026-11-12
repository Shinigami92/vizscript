import type { InputPinMeta } from './edit-meta';
import type {
  FunctionGraph,
  GraphDocument,
  GraphNode,
  LiteralKind,
  Pin,
} from './ir';
import type { ScriptSymbol, SymbolParam } from './symbols';

export interface CallPinOptions {
  /** Argument written for a skipped parameter (`undefined`, `null`). */
  placeholder: string;
  /**
   * Missing arguments are written as `name=value` (Python), so defaults of
   * skipped parameters stay; otherwise positionally with placeholders.
   */
  keywordArguments?: boolean;
}

const ARG_PIN = /^arg\d+$/;

/** Offset of the `)` that closes a call node's arguments. */
export function callClose(text: string, node: GraphNode): number | undefined {
  const close = text.lastIndexOf(')', node.range.end - 1);
  return close >= node.range.start ? close : undefined;
}

function literalKind(param: SymbolParam): LiteralKind {
  switch (param.dataType) {
    case 'string': {
      return 'string';
    }

    case 'number': {
      return 'number';
    }

    case 'bool': {
      return 'boolean';
    }

    default: {
      return 'undefined';
    }
  }
}

/** The function a call node calls, when the file declares it. */
function calledSymbol(
  text: string,
  doc: GraphDocument,
  fn: FunctionGraph,
  node: GraphNode
): ScriptSymbol | undefined {
  const symbols = doc.symbols ?? [];
  const owner = symbols.find(
    (s) => s.fnId === fn.id && (s.kind === 'function' || s.kind === 'method')
  );
  const target = node.pins.find((p) => p.id === 'target' && p.range);
  const targetText = target?.range
    ? text.slice(target.range.start, target.range.end)
    : undefined;
  const title = node.title.replace(/\?\.\(\)$/, '');
  const self =
    targetText === 'this' ||
    targetText === 'self' ||
    /^(?:this|self)\./.test(title);
  const name = title.split('.').at(-1) ?? title;

  if (self) {
    // A method of the class the calling method belongs to.
    const cls = owner?.kind === 'method' ? owner.scope : '';
    return symbols.find(
      (s) =>
        s.name === name &&
        s.scope === cls &&
        (s.kind === 'method' || s.kind === 'function')
    );
  }

  if (title.includes('.') || target) {
    return undefined;
  }

  return symbols.find(
    (s) => s.name === name && s.scope === '' && s.kind === 'function'
  );
}

/**
 * Completes the input pins of calls to functions of the same file, like
 * UE's call nodes: every parameter is a pin, named and typed like it.
 * Missing arguments become unconnected pins that insert the argument when
 * they get a value or a wire.
 */
export function completeCallPins(
  doc: GraphDocument,
  text: string,
  options: CallPinOptions
): void {
  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      if (node.kind !== 'call') {
        continue;
      }

      const symbol = calledSymbol(text, doc, fn, node);
      const params = symbol?.params;
      if (!symbol || !params) {
        continue;
      }

      const args = node.pins.filter(
        (p) => p.direction === 'in' && p.kind === 'data' && ARG_PIN.test(p.id)
      );
      const keywords = new Set(
        args
          .map((p) => p.name)
          .filter((n) => n.endsWith('='))
          .map((n) => n.slice(0, -1))
      );
      const positional = args.filter(
        (p) =>
          !p.name.endsWith('=') && p.name !== '...' && !p.name.startsWith('*')
      );

      // Types of the given arguments come from the parameters.
      for (const [index, pin] of positional.entries()) {
        const param = params[index];
        if (param && !param.rest && pin.type === 'any') {
          pin.type = param.dataType;
        }
      }

      const close = callClose(text, node);
      if (
        close === undefined ||
        positional.length < args.length - keywords.size
      ) {
        continue;
      }

      const added: Pin[] = [];
      for (const [index, param] of params.entries()) {
        if (
          index < positional.length ||
          param.rest ||
          keywords.has(param.name)
        ) {
          continue;
        }

        let prefix: string;
        if (options.keywordArguments) {
          prefix = `${args.length > 0 ? ', ' : ''}${param.name}=`;
        } else {
          // Skipped parameters before this one get a placeholder.
          const gap = index - positional.length;
          const fill = Array.from({ length: gap }, () => options.placeholder);
          prefix = `${args.length > 0 ? ', ' : ''}${fill.map((v) => `${v}, `).join('')}`;
        }

        const meta: InputPinMeta = {
          insertInitAt: close,
          insertPrefix: prefix,
          optional: true,
        };
        const defaultText = param.defaultRange
          ? text.slice(param.defaultRange.start, param.defaultRange.end)
          : '';
        added.push({
          id: `param:${param.name}`,
          name: param.name,
          direction: 'in',
          kind: 'data',
          type: param.dataType,
          literal: {
            value: defaultText,
            raw: '',
            kind: literalKind(param),
            editable: true,
          },
          meta: { ...meta },
        });
      }

      // After the last input, before the outputs.
      const at = node.pins.findLastIndex((p) => p.direction === 'in') + 1;
      node.pins.splice(at, 0, ...added);
    }
  }
}
