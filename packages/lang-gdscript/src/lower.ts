import type {
  DataType,
  Diagnostic,
  FunctionGraph,
  GraphDocument,
  ParseOptions,
} from '@vizscript/core';
import {
  attachComments,
  completeCallPins,
  functionIdCounter,
  inferTypes,
  linkImports,
  linkSymbolGraphs,
} from '@vizscript/core';
import type { Stmt } from './ast';
import { dataTypeOf } from './data-type';
import type { GraphSource, LoweringContext, Signature } from './lower-utils';
import { unwrap } from './lower-utils';
import { parseGDScript } from './parser';
import { gdscriptSettings } from './settings';
import { FnGraphBuilder } from './statement-lowering';
import { gdscriptSymbols } from './symbols';

export const LANGUAGE_ID = 'gdscript';

class DocumentLowering implements LoweringContext {
  public readonly functions: FunctionGraph[] = [];
  public readonly queue: GraphSource[] = [];
  public readonly signatures = new Map<string, Signature>();
  /** Types of the script's member variables and constants. */
  public readonly memberTypes = new Map<string, DataType>();
  private readonly fnIds = functionIdCounter();

  public constructor(
    public readonly text: string,
    public readonly fileName: string
  ) {}

  public uniqueFunctionId(name: string): string {
    return this.fnIds.next(name);
  }

  public run(
    body: Stmt[],
    className: string | undefined,
    extendsName: string | undefined
  ): void {
    for (const stmt of body) {
      if (stmt.type === 'Var') {
        const value = stmt.value ? unwrap(stmt.value) : undefined;
        const literal =
          value?.type === 'Literal'
            ? value.kind === 'int' || value.kind === 'float'
              ? 'number'
              : value.kind === 'bool'
                ? 'bool'
                : value.kind === 'null'
                  ? 'any'
                  : 'string'
            : 'any';
        this.memberTypes.set(
          stmt.name,
          stmt.typeRef ? dataTypeOf(stmt.typeRef) : literal
        );
      }

      if (stmt.type === 'Func' && stmt.name) {
        this.signatures.set(stmt.name, {
          params: stmt.params.map((p) => p.name),
          returnType: dataTypeOf(stmt.returnType),
        });
      }
    }

    const name = className ?? this.fileName.replace(/\.gd$/i, '');
    this.queue.push({
      type: 'class',
      name,
      body,
      subtitle: extendsName ? `extends ${extendsName}` : 'script',
      range: { start: 0, end: this.text.length },
      prefix: '',
    });
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      new FnGraphBuilder(this, next).run();
    }
  }
}

export function parseGDScriptDocument(
  text: string,
  fileName = 'script.gd',
  options: ParseOptions = {}
): GraphDocument {
  const { script, diagnostics, comments } = parseGDScript(text);
  const lowering = new DocumentLowering(
    text,
    fileName.split('/').at(-1) ?? fileName
  );
  lowering.run(script.body, script.className, script.extendsName);
  const doc: GraphDocument = {
    language: LANGUAGE_ID,
    functions: lowering.functions,
    diagnostics: diagnostics.map((d): Diagnostic => ({
      message: d.message,
      range: { start: d.start, end: d.end },
      severity: 'error',
    })),
    symbols: gdscriptSymbols(script.body, text),
    settings: gdscriptSettings(script),
  };
  attachComments(doc, text, comments);
  linkSymbolGraphs(doc);
  linkImports(doc, options.imports);
  completeCallPins(doc, text, {
    placeholder: 'null',
    imports: options.imports,
  });
  inferTypes(doc);
  return doc;
}
