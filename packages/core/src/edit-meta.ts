import type { GraphNode, SourceRange } from './ir';

/**
 * Where a new statement can be inserted when wiring from an exec output pin.
 *
 * - `after`: insert `\n<indent><text>` at `at`
 * - `before`: insert `<text>\n<indent>` at `at`
 */
export interface InsertPoint {
  at: number;
  indent: string;
  mode: 'after' | 'before';
}

/** Metadata attached to statement nodes. */
export interface StatementMeta {
  stmt: SourceRange;
  /** Statement is the brace-less body of a control structure. */
  inline?: boolean;
  /**
   * Only statement of an indentation-based block: removing it must leave a
   * placeholder (e.g. `pass`) behind.
   */
  sole?: boolean;
  /**
   * The value of a function that returns one (a Rust `match` / `if` as
   * the last expression): removing it must leave the placeholder behind.
   */
  tail?: boolean;
  /** Part of a larger statement (e.g. an `elif`); cannot be moved or deleted. */
  locked?: boolean;
  /**
   * A pure node standing for an expression statement whose value is unused
   * (`a + b;`), shown like an unconnected Blueprint node.
   */
  unused?: boolean;
}

/** Metadata attached to data output pins. */
export interface OutputPinMeta {
  /** Expression text that yields this value (identifier or expression). */
  sourceText?: string;
  /** The value can only be referenced after binding it to a variable. */
  bind?: {
    /** Range of the expression producing the value. */
    expr: SourceRange;
    /** Enclosing statement. */
    stmt: SourceRange;
    /** Whether the expression is the whole expression statement. */
    isStatement: boolean;
    nameHint: string;
  };
  /** Statement the value is computed in (for pure expressions). */
  scope?: SourceRange;
  /**
   * The value exists only inside this range: a name bound by a pattern or
   * a loop (`if let Some(x) = …`), usable in its block only.
   */
  visibleIn?: SourceRange;
}

/** Metadata attached to data input pins. */
export interface InputPinMeta {
  /** Offset to insert ` = <value>` when the input has no expression yet. */
  insertInitAt?: number;
  /** Text before an inserted value (default ` = `; ` ` after `return`). */
  insertPrefix?: string;
  /**
   * The value may be left out (`return x` → `return`): disconnecting removes
   * it instead of writing a placeholder.
   */
  optional?: boolean;
  /**
   * Value of an object property with this identifier key. Written as a
   * shorthand (`{ length }`), a new value keeps the key (`length: value`);
   * a value equal to the key becomes a shorthand again.
   */
  propertyKey?: string;
  /** Range of the whole property (`key: value`), with `propertyKey`. */
  property?: SourceRange;
  /** The property is written as a shorthand (`{ length }`). */
  shorthand?: boolean;
  /** Default value of the argument's parameter, as code. */
  defaultValue?: string;
}

export interface ExecOutPinMeta {
  insert?: InsertPoint;
  continuation?: boolean;
}

export function getMeta<T>(holder: {
  meta?: Record<string, unknown>;
}): Partial<T> {
  return (holder.meta ?? {}) as Partial<T>;
}

/** The statement a node belongs to (its own, or the one computing it). */
export function owningStatement(
  node: GraphNode
): { stmt: SourceRange; meta: Partial<StatementMeta> } | undefined {
  const meta = getMeta<StatementMeta>(node);
  if (meta.stmt) {
    return { stmt: meta.stmt, meta };
  }

  for (const pin of node.pins) {
    if (pin.kind === 'data' && pin.direction === 'out') {
      const out = getMeta<OutputPinMeta>(pin);
      const stmt = out.bind?.stmt ?? out.scope;
      if (stmt) {
        return { stmt, meta: {} };
      }
    }
  }

  return undefined;
}
