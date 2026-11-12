import type { ImportRequest, ParseOptions } from './imports';
import type { DataType, GraphDocument, PinRef, Point } from './ir';
import type { ModuleReference } from './module-refs';

/** A text replacement on the original source. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Flow-control nodes of the action menu (UE: For Each Loop, For Loop,
 * While Loop, Switch …), written in each language's own syntax.
 */
export type FlowTemplate =
  | 'forEach'
  | 'forRange'
  | 'while'
  | 'switch'
  | 'try'
  | 'throw'
  | 'break'
  | 'continue';

export type NodeTemplate =
  | {
      type: 'call';
      callee: string;
      /** Argument expressions (source text), e.g. a wired value. */
      args?: string[];
    }
  | { type: 'setVar'; name: string; declaration: 'const' | 'let' | 'none' }
  | { type: 'branch' }
  | { type: 'return' }
  /**
   * A value on its own (UE: a lone Get node). It shows as unconnected
   * nodes until it is wired into an input.
   */
  | { type: 'value'; expression: string }
  /** A loop, switch, try … with placeholders (`for (const item of [])`). */
  | { type: 'flow'; flow: FlowTemplate }
  /**
   * Statements as source text (pasted or duplicated nodes), re-indented to
   * where they go.
   */
  | { type: 'code'; code: string };

/**
 * Language-agnostic graph edit operations. Each language backend translates
 * them into {@link TextEdit}s on its own source code.
 */
export type GraphOp =
  | { type: 'deleteNodes'; nodeIds: string[] }
  | { type: 'setLiteral'; node: string; pin: string; value: string }
  | { type: 'connect'; from: PinRef; to: PinRef }
  | { type: 'disconnect'; pin: PinRef }
  /** Breaks every data wire of a node (UE: "Break Node Link(s)"). */
  | { type: 'disconnectNode'; node: string }
  /**
   * Another variable for a Get or Set, another function for a call; the
   * wires stay (UE: "Replace References" / "Replace with").
   */
  | { type: 'replaceReference'; node: string; name: string }
  | {
      type: 'addNode';
      template: NodeTemplate;
      /** Exec output pin the new statement should follow. */
      after?: PinRef;
      /** Exec input pin of a statement the new one should precede. */
      before?: PinRef;
      position?: Point;
    }
  /** Replaces the expression feeding a data input. */
  | { type: 'setInput'; pin: PinRef; expression: string }
  /** Moves the expression feeding a data input into a new variable. */
  | { type: 'extract'; pin: PinRef; name: string; position?: Point }
  /** Stores the value of a data output in a new variable. */
  | { type: 'promote'; pin: PinRef; name: string; position?: Point }
  /** Adds a call that receives the value of a data output. */
  | { type: 'callWith'; pin: PinRef; callee: string; position?: Point }
  /**
   * Uses the value of a data output in a new expression (`$value` marks it),
   * e.g. `$value + undefined` for a `+` node (UE: drag from an output).
   */
  | { type: 'useValue'; pin: PinRef; expression: string; position?: Point }
  /** Sets the comment above a node's code (empty text removes it). */
  | {
      type: 'setComment';
      node: string;
      text: string;
      /** A description of a function or variable: a doc comment. */
      doc?: boolean;
    }
  /** Puts the statements of the nodes into a titled region. */
  | { type: 'addCommentBox'; nodes: string[]; title: string }
  | { type: 'renameCommentBox'; box: string; title: string }
  /** Removes the region markers; the code inside stays. */
  | { type: 'deleteCommentBox'; box: string }
  /** Adds an empty function to the module (`scope: ''`) or a class. */
  | { type: 'addFunction'; scope: string; name: string }
  /**
   * Adds a variable to the module (`scope: ''`), a class, or (with
   * `local`) the function whose qualified name is `scope`.
   */
  | {
      type: 'addVariable';
      scope: string;
      name: string;
      local?: boolean;
      constant?: boolean;
    }
  /** Adds a signal (GDScript). */
  | { type: 'addSignal'; name: string }
  /** Renames a symbol and its uses in the file. */
  | { type: 'renameSymbol'; symbol: string; name: string }
  /** Removes the declaration of a symbol (its uses stay). */
  | { type: 'deleteSymbol'; symbol: string }
  /**
   * Sets (or with `null` removes) the declared type of a variable. A
   * `defaultValue` replaces a missing or placeholder value (`undefined`,
   * `None`), like UE resets the default value when the type changes.
   */
  | {
      type: 'setSymbolType';
      symbol: string;
      typeText: string | null;
      defaultValue?: string;
    }
  /**
   * Sets (or with `null` removes) the value of a variable. `kind` tells how
   * to write it: `string` is quoted by the language, `expression` is code.
   */
  | {
      type: 'setSymbolValue';
      symbol: string;
      value: string | null;
      kind: ValueKind;
    }
  /**
   * Turns a modifier of a declaration on or off: `export`, `static`,
   * `readonly`, `@export`, `@onready`, or the declaration keyword
   * (`const`, `let`, `var`; turning one on replaces the other).
   */
  | {
      type: 'setModifier';
      symbol: string;
      modifier: string;
      enabled: boolean;
    }
  /**
   * Adds an input to a function (UE: Inputs `+`). Same-file calls get
   * `argument` (or the language's placeholder) for it.
   */
  | {
      type: 'addParameter';
      symbol: string;
      name: string;
      typeText?: string;
      argument?: string;
    }
  /** Removes an input and its argument from same-file calls. */
  | { type: 'removeParameter'; symbol: string; index: number }
  /** Moves an input, and the arguments of same-file calls with it. */
  | { type: 'moveParameter'; symbol: string; from: number; to: number }
  | { type: 'renameParameter'; symbol: string; index: number; name: string }
  | {
      type: 'setParameterType';
      symbol: string;
      index: number;
      typeText: string | null;
    }
  | {
      type: 'setParameterValue';
      symbol: string;
      index: number;
      value: string | null;
      kind: ValueKind;
    }
  /** Sets (or with `null` removes) the declared return type. */
  | { type: 'setReturnType'; symbol: string; typeText: string | null }
  /** Adds a placeholder argument to a call (UE: "Add pin"). */
  | { type: 'addArgument'; node: string }
  /** Removes an argument of a call with its comma (UE: "Remove pin"). */
  | { type: 'removeArgument'; pin: PinRef }
  /**
   * Moves all data wires of `from` to `to` (UE: Ctrl+drag a pin): the
   * inputs an output fed take the other output, or an input's wire goes
   * to another input.
   */
  | { type: 'moveWires'; from: PinRef; to: PinRef }
  /**
   * UE's "Collapse to Function": the statements of `nodes` become a new
   * function `name`, called where they were.
   */
  | {
      type: 'collapseToFunction';
      nodes: string[];
      name: string;
      /** Where the call node goes (where the collapsed nodes were). */
      position?: Point;
    }
  /** Moves a variable into a category (`group`; `''`: none). */
  | { type: 'setSymbolGroup'; symbol: string; group: string }
  /** Changes a setting of the script (`extends`, `@tool`; see `settings`). */
  | { type: 'setScriptSetting'; setting: string; value: string }
  /** Another op that uses a name of another file, plus its import. */
  | { type: 'withImport'; import: ImportRequest; op: GraphOp };

/** How a value typed in the Details panel is written. */
export type ValueKind = 'string' | 'number' | 'bool' | 'expression';

/** A basic type of a language, for the type picker. */
export interface TypeOption {
  /** As written in the code (`string`, `int`, `Vector2`). */
  name: string;
  /** Pin type (color and value editor). */
  dataType: DataType;
  /** Value of a new variable of this type (`""`, `0`, `Vector2.ZERO`). */
  defaultValue: string;
}

/** An operator or value node offered by the action menu. */
export interface ExpressionTemplate {
  label: string;
  /** Menu group: `Math`, `Comparison`, `Logic`, `Text`, `Values`, … */
  category: string;
  /** Code with `$1`, `$2` … for its inputs, e.g. `$1 + $2`. */
  template: string;
  /** Pin type of the result (for the Context Sensitive filter). */
  result?: DataType;
  /** Extra words that find it (`add`, `plus`, `equals`). */
  keywords?: string;
}

/**
 * Types of a language, as data (sent from the parser worker to the type
 * picker). Containers are templates with `T` (`T[]`, `list[T]`) and `K`/`V`.
 */
export interface TypeSystemInfo {
  primitives: TypeOption[];
  array?: string;
  map?: string;
  set?: string;
  optional?: string;
  /** Values of new containers (`[]`, `new Map()`, `set()`). */
  containerDefaults?: { array?: string; map?: string; set?: string };
  /** Value of an empty input (`undefined`, `None`, `null`). */
  placeholder?: string;
  /**
   * Operators and values of the action menu (UE: `+`, Make Literal String,
   * Select, Make Array …). `$1`, `$2` … are their inputs.
   */
  expressions?: ExpressionTemplate[];
  /**
   * Editor hints of exported variables (GDScript's `@export_range`, like
   * UE's Slider Range); `args` are the default arguments.
   */
  exportHints?: Array<{ name: string; args?: string }>;
  /**
   * Values the Details panel edits with fields instead of code: vector
   * constructors with their components (`Vector2(x, y)`), and the color
   * constructor (`Color(r, g, b, a)`), like UE's vector and color fields.
   */
  valueEditors?: {
    vectors?: Record<string, string[]>;
    color?: string;
  };
  /** Flow-control nodes the language has (GDScript has no `try`). */
  flow?: FlowTemplate[];
  /**
   * Class fields can be constructor parameters (UE's "Expose on Spawn"),
   * switched with the `constructor` modifier.
   */
  exposeOnSpawn?: boolean;
  /** Variables can be put into categories (`ScriptSymbol.group`). */
  symbolGroups?: boolean;
  /**
   * Prefix that makes a name private by convention (`_` in Python and
   * GDScript); Details offers it as UE's "Private" switch.
   */
  privatePrefix?: string;
  /** Modifiers the Details panel offers per kind of symbol. */
  modifiers: Partial<
    Record<
      'variable' | 'constant' | 'member' | 'local' | 'function' | 'method',
      {
        /** Mutually exclusive declaration keywords (`const` / `let`). */
        keywords?: string[];
        /**
         * Access levels of class members (`public` / `protected` /
         * `private`); none written means the first.
         */
        access?: string[];
        /** Independent switches (`export`, `@export`, `async`). */
        flags?: string[];
      }
    >
  >;
}

export type OpResult =
  | { ok: true; edits: TextEdit[] }
  | { ok: false; error: string };

export interface LanguageBackend {
  /** Unique id, e.g. `typescript`. */
  id: string;
  /** Human readable name. */
  name: string;
  /** Handled file extensions including the dot. */
  extensions: ReadonlyArray<string>;
  /** `options` carries the declarations of imported names. */
  parse(text: string, fileName?: string, options?: ParseOptions): GraphDocument;
  applyOp(
    text: string,
    op: GraphOp,
    fileName?: string,
    options?: ParseOptions
  ): OpResult;
  /** Files referenced by the source (imports, …) for Ctrl/Cmd+click. */
  references?(text: string, fileName?: string): ModuleReference[];
  /** Types and modifiers offered by the Details panel. */
  typeSystem?: TypeSystemInfo;
  /**
   * Declarations of a library module the backend knows (a stub in its own
   * language, e.g. Python's standard library), parsed like a file.
   */
  library?(module: string): { text: string; fileName: string } | undefined;
  /** Library modules the backend knows (offered by the action menu). */
  libraries?: ReadonlyArray<string>;
}

/**
 * Applies non-overlapping edits. Edits are applied back to front so offsets
 * stay valid.
 */
export function applyTextEdits(
  text: string,
  edits: ReadonlyArray<TextEdit>
): string {
  const sorted = [...edits].toSorted(
    (a, b) => b.start - a.start || b.end - a.end
  );
  let result = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) {
      throw new Error(
        `Overlapping text edits at ${edit.start}-${edit.end} and ${lastStart}`
      );
    }

    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    lastStart = edit.start;
  }

  return result;
}
