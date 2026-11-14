import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type {
  DataType,
  Diagnostic,
  FunctionGraph,
  GraphDocument,
  GraphNode,
  ParseOptions,
  Pin,
  SourceRange,
} from '@vizscript/core';
import type { InsertPoint } from '@vizscript/core';
import {
  applyTypes,
  attachComments,
  completeCallPins,
  inferTypes,
  isArrayType,
  linkImports,
  linkSymbolGraphs,
} from '@vizscript/core';
import { patternAnnotation, typeFromAnnotation } from './annotations';
import type { DocumentContext, PendingFunction } from './lower-utils';
import { DECLARATION_ONLY, patternName, rangeOf, unwrap } from './lower-utils';
import { StatementLowering } from './statement-lowering';
import { typeScriptReexports, typeScriptSymbols } from './symbols';

export const LANGUAGE_ID = 'typescript';

class DocumentLowering implements DocumentContext {
  public readonly functions: FunctionGraph[] = [];
  public readonly queue: PendingFunction[] = [];
  public readonly functionParams = new Map<string, string[]>();
  public readonly functionReturnTypes = new Map<string, DataType>();
  private readonly fnIds = new Map<string, number>();

  public constructor(
    public readonly text: string,
    public readonly fileName: string
  ) {}

  public uniqueFunctionId(name: string): string {
    const count = this.fnIds.get(name) ?? 0;
    this.fnIds.set(name, count + 1);
    return count === 0 ? `fn:${name}` : `fn:${name}~${count}`;
  }

  private collectSignatures(program: t.Program): void {
    const visit = (stmt: t.Statement): void => {
      if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
        visit(stmt.declaration);
        return;
      }

      if (
        stmt.type === 'ExportDefaultDeclaration' &&
        stmt.declaration.type === 'FunctionDeclaration'
      ) {
        visit(stmt.declaration);
        return;
      }

      if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        this.functionParams.set(
          stmt.id.name,
          stmt.params.map((p) => patternName(p, this.text))
        );
        this.functionReturnTypes.set(
          stmt.id.name,
          typeFromAnnotation(stmt.returnType)
        );
      }

      if (stmt.type === 'VariableDeclaration') {
        for (const decl of stmt.declarations) {
          const init = decl.init ? unwrap(decl.init) : undefined;
          if (
            decl.id.type === 'Identifier' &&
            init &&
            (init.type === 'ArrowFunctionExpression' ||
              init.type === 'FunctionExpression')
          ) {
            this.functionParams.set(
              decl.id.name,
              init.params.map((p) => patternName(p, this.text))
            );
            this.functionReturnTypes.set(
              decl.id.name,
              typeFromAnnotation(init.returnType)
            );
          }
        }
      }
    };

    for (const stmt of program.body) {
      visit(stmt);
    }
  }

  public run(program: t.Program): void {
    this.collectSignatures(program);
    new FnGraphBuilder(this, 'Module', 'module', program).run();
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      new FnGraphBuilder(this, next.name, next.kind, next.fn).run();
    }
  }
}

/** Lowers one function (or the module top level) into a FunctionGraph. */
class FnGraphBuilder extends StatementLowering {
  public run(): void {
    const fn = this.fn;
    const entryPins: Pin[] = [];
    let entryInsert: InsertPoint | undefined;
    let subtitle: string;
    let entryRange: SourceRange;
    let returnType: DataType = 'any';

    if (fn.type === 'Program') {
      subtitle = this.doc.fileName || 'module';
      entryRange = { start: 0, end: 0 };
      // New statements go before the first executable top-level statement.
      const firstExecutable = fn.body.find(
        (s) => !DECLARATION_ONLY.has(s.type)
      );
      const lastImport = fn.body.findLast(
        (s) => s.type === 'ImportDeclaration'
      );
      entryInsert = firstExecutable
        ? { at: firstExecutable.start ?? 0, indent: '', mode: 'before' }
        : {
            at: lastImport?.end ?? fn.end ?? this.text.length,
            indent: '',
            mode: 'after',
          };
    } else {
      subtitle = !fn.async
        ? this.kind
        : this.kind.startsWith('export')
          ? this.kind.replace('function', 'async function')
          : `async ${this.kind}`;
      entryRange = { start: fn.start ?? 0, end: fn.body.start ?? 0 };
      entryInsert = this.blockInsert(fn.body);
      returnType = typeFromAnnotation(fn.returnType);
    }

    entryPins.push(this.execOut('then', '', entryInsert));
    const entry = this.addNode({
      kind: 'entry',
      title: this.name,
      subtitle,
      // Like UE: functions start purple, the module's code runs like an event.
      category: fn.type === 'Program' ? 'event' : 'entry',
      purity: 'impure',
      range: entryRange,
      pins: entryPins,
      path: 'entry',
      idText: `entry|${this.name}`,
    });

    if (fn.type !== 'Program') {
      for (const [index, param] of fn.params.entries()) {
        this.declareParam(entry, entryPins, param, index);
      }
    }

    this.cursor = { node: entry.id, pin: 'then' };

    if (fn.type === 'Program') {
      this.lowerStatements(fn.body, 'body', false);
    } else if (fn.body.type === 'BlockStatement') {
      this.lowerStatements(fn.body.body, 'body', false);
    } else {
      // Arrow function with an expression body: implicit return.
      const body = fn.body;
      this.currentStatement = rangeOf(body);
      const value = this.lowerExpr(body, 'body/0', 'eager');
      const pin = this.dataIn('value', '', rangeOf(body), returnType);
      const node = this.addNode({
        kind: 'return',
        title: 'Return',
        category: 'return',
        purity: 'impure',
        range: rangeOf(body),
        pins: [this.execIn(), pin],
        path: 'body/0',
      });
      this.feed(node.id, pin, value);
      this.chain(node, null);
    }

    this.doc.functions.push({
      id: this.fnId,
      name: this.name,
      range: rangeOf(fn),
      nodes: this.nodes,
      edges: this.edges,
    });
  }

  private declareParam(
    entry: GraphNode,
    entryPins: Pin[],
    param: t.Node,
    index: number
  ): void {
    const name = patternName(param, this.text);
    const type = typeFromAnnotation(patternAnnotation(param));
    const pinId = `param${index}`;
    entryPins.push(
      this.dataOut(
        pinId,
        name,
        type,
        { sourceText: name.replace(/^\.\.\./, '') },
        rangeOf(param)
      )
    );

    let identifier: t.Node = param;
    if (identifier.type === 'TSParameterProperty') {
      identifier = identifier.parameter;
    }

    if (identifier.type === 'AssignmentPattern') {
      identifier = identifier.left;
    }

    if (identifier.type === 'RestElement') {
      identifier = identifier.argument;
    }

    if (identifier.type === 'Identifier') {
      this.declare(identifier.name, {
        source: { node: entry.id, pin: pinId },
        type:
          param.type === 'RestElement' && !isArrayType(type) ? 'array' : type,
      });
    }
  }
}

/** Parses a file with Babel (TypeScript unless it is plain JavaScript). */
export function parseFile(
  text: string,
  fileName = 'file.ts'
): ReturnType<typeof parse> {
  const isJsLike = /\.[cm]?jsx?$/i.test(fileName);
  const isJsx = /\.[jt]sx$/i.test(fileName);
  return parse(text, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: [
      ...(isJsLike ? [] : [['typescript', {}] as ['typescript', object]]),
      ...(isJsx || isJsLike ? ['jsx' as const] : []),
    ],
  });
}

export function parseTypeScript(
  text: string,
  fileName = 'file.ts',
  options: ParseOptions = {}
): GraphDocument {
  const diagnostics: Diagnostic[] = [];
  let program: t.Program;
  let comments: SourceRange[] = [];
  try {
    const file = parseFile(text, fileName);
    program = file.program;
    comments = (file.comments ?? []).map((c) => ({
      start: c.start ?? 0,
      end: c.end ?? 0,
    }));
    for (const error of file.errors ?? []) {
      const pos = (error as { pos?: number }).pos ?? 0;
      diagnostics.push({
        message: (error as { message?: string }).message ?? String(error),
        range: { start: pos, end: pos + 1 },
        severity: 'error',
      });
    }
  } catch (error) {
    const pos = (error as { pos?: number }).pos ?? 0;
    diagnostics.push({
      message: error instanceof Error ? error.message : String(error),
      range: { start: pos, end: pos + 1 },
      severity: 'error',
    });
    return { language: LANGUAGE_ID, functions: [], diagnostics };
  }

  const lowering = new DocumentLowering(
    text,
    fileName.split('/').at(-1) ?? fileName
  );
  lowering.run(program);
  const doc: GraphDocument = {
    language: LANGUAGE_ID,
    functions: lowering.functions,
    diagnostics,
    symbols: typeScriptSymbols(program, text),
    reexports: typeScriptReexports(program),
  };
  attachComments(doc, text, comments);
  linkSymbolGraphs(doc);
  linkImports(doc, options.imports);
  completeCallPins(doc, text, {
    placeholder: 'undefined',
    imports: options.imports,
  });
  inferTypes(doc);
  // The checker's types, as the graph shows them (argument pins of calls).
  return options.checked?.text === text
    ? applyTypes(doc, options.checked.types, {
        text,
        options: { placeholder: 'undefined' },
      })
    : doc;
}
