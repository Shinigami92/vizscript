import type {
  DataType,
  Diagnostic,
  FunctionGraph,
  GraphDocument,
  ParseOptions,
} from '@vizscript/core';
import {
  applyTypes,
  attachComments,
  completeCallPins,
  functionIdCounter,
  inferTypes,
  linkImports,
  linkSymbolGraphs,
} from '@vizscript/core';
import type { FunctionItem, Item, ValueItem } from './ast';
import { parseRust } from './convert';
import { dataTypeOf } from './data-type';
import { rustImports } from './imports';
import type { GraphSource, LoweringContext, Signature } from './lower-utils';
import { FnGraphBuilder } from './statement-lowering';
import { rustSymbols } from './symbols';
import { rustTypes } from './type-lookup';

export const LANGUAGE_ID = 'rust';

class DocumentLowering implements LoweringContext {
  public readonly functions: FunctionGraph[] = [];
  public readonly queue: GraphSource[] = [];
  public readonly signatures = new Map<string, Signature>();
  /** Types of constants and statics. */
  public readonly globals = new Map<string, DataType>();
  private readonly ids = functionIdCounter();

  public constructor(
    public readonly text: string,
    public readonly fileName: string
  ) {}

  public uniqueFunctionId(name: string): string {
    return this.ids.next(name);
  }

  private signature(fn: FunctionItem, owner?: string): Signature {
    return {
      params: fn.params.map((p) => p.name ?? '_'),
      returnType: fn.returns
        ? dataTypeOf(this.text.slice(fn.returns.start, fn.returns.end), owner)
        : 'void',
    };
  }

  /** Functions of a module (and its inline modules), queued as graphs. */
  private collect(items: ReadonlyArray<Item>, prefix: string): void {
    for (const item of items) {
      switch (item.type) {
        case 'Function': {
          this.signatures.set(`${prefix}${item.name}`, this.signature(item));
          if (item.body) {
            this.queue.push({
              type: 'function',
              name: `${prefix}${item.name}`,
              kind: 'fn',
              fn: item,
            });
          }

          break;
        }

        case 'Impl':
        case 'Trait': {
          const owner = item.type === 'Impl' ? item.target : item.name;
          for (const member of item.items) {
            if (member.type !== 'Function') {
              continue;
            }

            const name = `${prefix}${owner}::${member.name}`;
            this.signatures.set(name, this.signature(member, owner));
            if (member.body) {
              this.queue.push({
                type: 'function',
                name,
                kind: member.self ? 'method' : 'associated fn',
                owner,
                fn: member,
              });
            }
          }

          break;
        }

        case 'Mod': {
          if (item.items) {
            this.collect(item.items, `${prefix}${item.name}::`);
          }

          break;
        }

        case 'Const':
        case 'Static': {
          const type = item.valueType
            ? dataTypeOf(
                this.text.slice(item.valueType.start, item.valueType.end)
              )
            : 'any';
          if (type !== 'any') {
            this.globals.set(item.name, type);
          }

          break;
        }

        default: {
          break;
        }
      }
    }
  }

  public run(items: Item[]): void {
    this.collect(items, '');
    const values = items.filter(
      (i): i is ValueItem => i.type === 'Const' || i.type === 'Static'
    );
    if (values.length > 0) {
      this.queue.unshift({ type: 'module', items: values });
    }

    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      new FnGraphBuilder(this, next).run();
    }
  }
}

export function parseRustDocument(
  text: string,
  fileName = 'main.rs',
  options: ParseOptions = {}
): GraphDocument {
  const { items, diagnostics, comments } = parseRust(text);
  const lowering = new DocumentLowering(
    text,
    fileName.split('/').at(-1) ?? fileName
  );
  lowering.run(items);
  const doc: GraphDocument = {
    language: LANGUAGE_ID,
    functions: lowering.functions,
    diagnostics: diagnostics.map((d): Diagnostic => ({
      message: d.message,
      range: { start: d.start, end: d.end },
      severity: 'error',
    })),
    symbols: [...rustImports(text), ...rustSymbols(items, text)],
  };
  attachComments(doc, text, comments);
  linkSymbolGraphs(doc);
  linkImports(doc, options.imports);
  completeCallPins(doc, text, {
    placeholder: 'todo!()',
    imports: options.imports,
  });
  inferTypes(doc);
  // Types followed through the file (`items.len()` is a `usize`,
  // `println!` gives nothing).
  return applyTypes(doc, rustTypes(text, items), {
    text,
    options: { placeholder: 'todo!()' },
  });
}
