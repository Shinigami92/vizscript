import type {
  DataType,
  Diagnostic,
  FunctionGraph,
  GraphDocument,
  ParseOptions,
  Pin,
  SourceRange,
} from '@vizscript/core';
import {
  applyTypes,
  attachComments,
  completeCallPins,
  functionIdCounter,
  inferTypes,
  linkImports,
  linkSymbolGraphs,
  truncate,
} from '@vizscript/core';
import type { ClassDef, FunctionDef, Param, Stmt } from './ast';
import { parsePython } from './convert';
import { pythonImports } from './imports';
import type {
  DocumentContext,
  GraphSource,
  LambdaSource,
  Signature,
} from './lower-utils';
import { dataTypeOf, isDeclarationOnly, rangeOf, unwrap } from './lower-utils';
import { StatementLowering } from './statement-lowering';
import { pythonSymbols } from './symbols';
import { pythonTypes } from './type-lookup';

export const LANGUAGE_ID = 'python';

class DocumentLowering implements DocumentContext {
  public readonly functions: FunctionGraph[] = [];
  public readonly queue: GraphSource[] = [];
  public readonly signatures = new Map<string, Signature>();
  /** Types of module-level variables (from annotations or literals). */
  public readonly globals = new Map<string, DataType>();
  private readonly ids = functionIdCounter();

  public constructor(
    public readonly text: string,
    public readonly fileName: string
  ) {}

  public uniqueFunctionId(name: string): string {
    return this.ids.next(name);
  }

  public run(body: Stmt[]): void {
    const collect = (stmts: ReadonlyArray<Stmt>, prefix: string): void => {
      for (const stmt of stmts) {
        if (stmt.type === 'FunctionDef') {
          this.signatures.set(`${prefix}${stmt.name}`, {
            params: stmt.params
              .map((p) => p.name)
              .filter((name) => name !== 'self' && name !== 'cls'),
            returnType: dataTypeOf(
              stmt.returns
                ? this.text.slice(stmt.returns.start, stmt.returns.end)
                : undefined
            ),
          });
        } else if (stmt.type === 'ClassDef') {
          this.signatures.set(`${prefix}${stmt.name}`, {
            params: [],
            returnType: stmt.name,
          });
          collect(stmt.body.body, `${prefix}${stmt.name}.`);
        }
      }
    };

    collect(body, '');
    for (const stmt of body) {
      const target = stmt.type === 'Assign' ? stmt.targets[0] : undefined;
      if (
        stmt.type !== 'Assign' ||
        stmt.targets.length !== 1 ||
        target?.type !== 'Name'
      ) {
        continue;
      }

      const value = stmt.value ? unwrap(stmt.value) : undefined;
      const type = stmt.annotation
        ? dataTypeOf(
            this.text.slice(stmt.annotation.start, stmt.annotation.end)
          )
        : value?.type === 'Literal' &&
            (value.kind === 'int' || value.kind === 'float')
          ? 'number'
          : value?.type === 'Literal' && value.kind === 'string'
            ? 'string'
            : value?.type === 'Literal' && value.kind === 'bool'
              ? 'bool'
              : 'any';
      if (type !== 'any') {
        this.globals.set(target.name, type);
      }
    }

    this.queue.push({ type: 'module', body });
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      new FnGraphBuilder(this, next).run();
    }
  }
}

/** Lowers a module, class body, function or lambda into a FunctionGraph. */
class FnGraphBuilder extends StatementLowering {
  public run(): void {
    const source = this.source;
    let range: SourceRange;
    if (source.type === 'module') {
      range = { start: 0, end: this.text.length };
      this.runModule(source.body);
    } else if (source.type === 'class') {
      range = rangeOf(source.cls);
      this.runClass(source.name, source.cls);
    } else {
      range = rangeOf(source.fn);
      this.runFunction(source.name, source.kind, source.fn);
    }

    this.doc.functions.push({
      id: this.fnId,
      name: this.name,
      range,
      ...this.graph(),
    });
  }

  private runModule(body: Stmt[]): void {
    const firstExecutable = body.find((s) => !isDeclarationOnly(s));
    const entry = this.addNode({
      kind: 'entry',
      title: 'Module',
      subtitle: this.doc.fileName,
      category: 'event',
      purity: 'impure',
      range: { start: 0, end: 0 },
      pins: [
        this.execOut(
          'then',
          '',
          firstExecutable
            ? { at: firstExecutable.start, indent: '', mode: 'before' }
            : undefined
        ),
      ],
      path: 'entry',
      idText: 'entry|Module',
    });
    this.cursor = { node: entry.id, pin: 'then' };
    this.lowerStatements(body, 'body', false, false);
  }

  private runClass(name: string, cls: ClassDef): void {
    const bases = cls.bases.map((b) => this.src(rangeOf(b))).join(', ');
    const entry = this.addNode({
      kind: 'entry',
      title: name,
      subtitle: [
        bases ? `class (${truncate(bases, 30)})` : 'class',
        ...cls.decorators.map((d) => truncate(this.src(rangeOf(d)), 20)),
      ].join(' '),
      category: 'event',
      purity: 'impure',
      range: { start: cls.start, end: cls.body.start },
      pins: [this.execOut('then', '', this.blockInsert(cls.body))],
      path: 'entry',
      idText: `entry|${name}`,
    });
    this.cursor = { node: entry.id, pin: 'then' };
    this.lowerBlock(cls.body, 'body');
  }

  private runFunction(
    name: string,
    kind: string,
    fn: FunctionDef | LambdaSource
  ): void {
    const isDef = 'type' in fn;
    const subtitle = isDef
      ? [
          fn.isAsync ? 'async' : '',
          kind,
          ...fn.decorators.map((d) => truncate(this.src(rangeOf(d)), 20)),
        ]
          .filter(Boolean)
          .join(' ')
      : kind;
    const entryPins: Pin[] = [
      this.execOut('then', '', isDef ? this.blockInsert(fn.body) : undefined),
    ];
    const entry = this.addNode({
      kind: 'entry',
      title: name,
      subtitle,
      // Like UE's purple function entry; the module runs like an event.
      category: 'entry',
      purity: 'impure',
      range: { start: fn.start, end: fn.body.start },
      pins: entryPins,
      path: 'entry',
      idText: `entry|${name}`,
    });
    for (const [index, param] of fn.params.entries()) {
      const type = this.paramType(param);
      const bare = param.name.replace(/^\*+/, '');
      const pinId = `param${index}`;
      entryPins.push(
        this.dataOut(
          pinId,
          param.name,
          type,
          { sourceText: bare },
          rangeOf(param)
        )
      );
      this.declare(bare, { source: { node: entry.id, pin: pinId }, type });
    }

    this.cursor = { node: entry.id, pin: 'then' };
    if (isDef) {
      this.lowerBlock(fn.body, 'body');
      return;
    }

    // Lambda: its body expression is returned.
    const value = this.lowerExpr(fn.body, 'body/0', 'eager');
    const pin = this.dataIn('value', '', rangeOf(fn.body));
    const node = this.addNode({
      kind: 'return',
      title: 'Return',
      category: 'return',
      purity: 'impure',
      range: rangeOf(fn.body),
      pins: [this.execIn(), pin],
      path: 'body/0',
    });
    this.feed(node.id, pin, value);
    this.chain(node, null);
  }

  private paramType(param: Param): DataType {
    if (param.name.startsWith('**')) {
      return 'object';
    }

    if (param.name.startsWith('*')) {
      return 'array';
    }

    if (param.annotation) {
      return dataTypeOf(this.src(rangeOf(param.annotation)));
    }

    if (param.name === 'self' || param.name === 'cls') {
      return this.className ?? 'object';
    }

    return param.defaultValue ? this.literalType(param.defaultValue) : 'any';
  }
}

export function parsePythonDocument(
  text: string,
  fileName = 'script.py',
  options: ParseOptions = {}
): GraphDocument {
  const { body, diagnostics, comments } = parsePython(text);
  const lowering = new DocumentLowering(
    text,
    fileName.split('/').at(-1) ?? fileName
  );
  lowering.run(body);
  const doc: GraphDocument = {
    language: LANGUAGE_ID,
    functions: lowering.functions,
    diagnostics: diagnostics.map((d): Diagnostic => ({
      message: d.message,
      range: { start: d.start, end: d.end },
      severity: 'error',
    })),
    symbols: [...pythonImports(text), ...pythonSymbols(body, text)],
  };
  attachComments(doc, text, comments);
  linkSymbolGraphs(doc);
  linkImports(doc, options.imports);
  completeCallPins(doc, text, {
    placeholder: 'None',
    keywordArguments: true,
    imports: options.imports,
  });
  inferTypes(doc);
  // Types followed through the file (`len(xs)` is an `int`, `print()`
  // returns `None`).
  return applyTypes(doc, pythonTypes(text, body, options.imports), {
    text,
    options: { placeholder: 'None', keywordArguments: true },
  });
}
