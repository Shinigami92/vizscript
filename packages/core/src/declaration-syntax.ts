import type { ImportRequest } from './imports';
import type { DataType, GraphDocument } from './ir';
import type { OpResult, TypeSystemInfo } from './ops';
import type { CallSite } from './signature-ops';
import type { ScriptSymbol } from './symbols';

/**
 * How a language declares things, for adding, renaming and deleting
 * symbols from "My Script" (UE: the `+` buttons of "My Blueprint").
 */
export interface DeclarationSyntax {
  /** Valid names (`[A-Za-z_]\w*`, …). */
  identifier: RegExp;
  /** Reserved words that cannot be names. */
  keywords: ReadonlySet<string>;
  /** Indentation of a new file (`'    '` in Python). */
  defaultIndent: string;
  /** Blank lines around functions (2 in Python and GDScript). */
  blankLines: number;
  /** Members of a class are written inside `{ … }` (TypeScript). */
  bracedClasses: boolean;
  /** Lines that stay at the top of a file (imports, `extends`, …). */
  header: RegExp;
  /**
   * Comment lines right below the header that belong to it, like GDScript's
   * `##` class description after `extends` (only while no blank line or
   * code comes between).
   */
  headerDoc?: RegExp;
  /** A new empty function or method (lines after the first not indented). */
  fn: (name: string, unit: string, method: boolean) => string;
  /** A new variable declaration. */
  variable: (
    name: string,
    options: { constant: boolean; member: boolean }
  ) => string;
  /** A new signal (GDScript). */
  signal?: (name: string) => string;
  /** A new empty type (`interface X {}`, `class X:`); none: no `+`. */
  typeDeclaration?: (name: string, unit: string) => string;
  /** Types and modifiers offered by the Details panel. */
  typeSystem: TypeSystemInfo;
  /** Error message for an invalid type annotation. */
  validType: (text: string) => string | undefined;
  /** A string literal (`"text"` with the language's escapes). */
  string: (value: string) => string;
  /** Boolean literals. */
  booleans: { true: string; false: string };
  /** Whether a variable cannot exist without a value (`const`, Python). */
  valueRequired: (symbol: ScriptSymbol, typed: boolean) => boolean;
  /** Written between `)` and a return type (`: ` or ` -> `). */
  returnArrow: string;
  /** Calls of a function or method in the same file. */
  callSites?: (
    text: string,
    doc: GraphDocument,
    symbol: ScriptSymbol
  ) => CallSite[];
  /** Turns a modifier of a declaration on or off. */
  setModifier: (
    text: string,
    doc: GraphDocument,
    symbol: ScriptSymbol,
    modifier: string,
    enabled: boolean
  ) => OpResult;
  /**
   * Edits that rename a symbol and its uses; backends resolve the uses with
   * their own scope rules.
   */
  rename: (
    text: string,
    doc: GraphDocument,
    symbol: ScriptSymbol,
    name: string
  ) => OpResult;
  /** Edits that move a variable into a category (`ScriptSymbol.group`). */
  setSymbolGroup?: (
    text: string,
    doc: GraphDocument,
    symbol: ScriptSymbol,
    group: string
  ) => OpResult;
  /** Edits that change a script setting (`GraphDocument.settings`). */
  setScriptSetting?: (
    text: string,
    doc: GraphDocument,
    setting: string,
    value: string
  ) => OpResult;
  /** How collapsed nodes become a function and its call (`collapse.ts`). */
  extract?: ExtractSyntax;
  /** Edits that import a name of another file (see `addImport`). */
  addImport?: (
    text: string,
    doc: GraphDocument,
    request: ImportRequest
  ) => OpResult;
}

/** An input of a collapsed function. */
export interface ExtractParam {
  name: string;
  /** Declared type of the variable it comes from. */
  type?: string;
}

/** Language syntax for "Collapse to function". */
export interface ExtractSyntax {
  /**
   * The new function: `body` is indented by one unit, the other lines of
   * the result are not (like `fn`).
   */
  fn: (
    name: string,
    params: ReadonlyArray<ExtractParam>,
    body: string,
    options: {
      method: boolean;
      isStatic: boolean;
      isAsync: boolean;
      /** Type of the returned variable: as declared, and its pin type. */
      returns?: { type?: string; dataType: DataType };
    }
  ) => string;
  /** The statement that calls it, with the output stored if there is one. */
  call: (
    callee: string,
    args: ReadonlyArray<string>,
    options: {
      isAsync: boolean;
      /** `declare`: the keyword of a new variable (`const`), else assign. */
      output?: { name: string; declare?: string };
    }
  ) => string;
  /** `return x` with the language's terminator. */
  returnValue: (name: string) => string;
  /** Callee of a method of the same class (`this.name`, `self.name`). */
  method: (name: string, className: string, isStatic: boolean) => string;
}
