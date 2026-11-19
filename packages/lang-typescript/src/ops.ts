import type { GraphOp, OpResult, ParseOptions } from '@vizscript/core';
import { applyInValue, applyTextOp } from '@vizscript/core';
import { declarations } from './declarations';
import { parseTypeScript } from './lower';
import { quoteOf, TYPESCRIPT_SYNTAX } from './syntax';
import { TYPESCRIPT_TYPES } from './type-system';

/** The empty text default (`''`) in the file's quotes. */
function withQuotes(text: string, op: GraphOp): GraphOp {
  if (op.type === 'withImport') {
    return { ...op, op: withQuotes(text, op.op) };
  }

  return op.type === 'setSymbolType' && op.defaultValue === "''"
    ? { ...op, defaultValue: quoteOf(text).repeat(2) }
    : op;
}

export function applyTypeScriptOp(
  text: string,
  op: GraphOp,
  fileName?: string,
  options?: ParseOptions
): OpResult {
  if (op.type === 'inValue') {
    return applyInValue(text, op, TYPESCRIPT_TYPES, (host) =>
      applyTypeScriptOp(host, op.op, fileName, options)
    );
  }

  return applyTextOp(
    text,
    parseTypeScript(text, fileName, options),
    withQuotes(text, op),
    {
      ...TYPESCRIPT_SYNTAX,
      declarations: declarations(text, fileName),
    }
  );
}
