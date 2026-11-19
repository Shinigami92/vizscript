import type { StatementSyntax } from '@vizscript/core';

/** Quote most strings of the file use. */
export function quoteOf(text: string): string {
  const single = text.match(/'/g)?.length ?? 0;
  const double = text.match(/"/g)?.length ?? 0;
  return single > double ? "'" : '"';
}

export function quoteString(value: string, quote: string): string {
  let escaped = value.replaceAll('\\', '\\\\');
  if (quote === '`') {
    escaped = escaped.replaceAll('`', '\\`').replaceAll('${', '\\${');
    return `\`${escaped}\``;
  }

  escaped = escaped
    .replaceAll(quote, `\\${quote}`)
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
  return `${quote}${escaped}${quote}`;
}

/**
 * An expression as a statement: `{ a: 1 }` or `function () {}` at the
 * start of a statement would be a block or a declaration.
 */
function expressionStatement(expression: string): string {
  return /^(?:\{|function\b|class\b|let\s*\[)/.test(expression)
    ? `(${expression});`
    : `${expression};`;
}

export const TYPESCRIPT_SYNTAX: StatementSyntax = {
  placeholder: 'undefined',
  objectEntry: {
    write: (key, value) =>
      `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : quoteString(key, "'")}: ${value}`,
    padded: true,
  },
  emptyBody: '{}',
  bindingName: (hint) => `${hint}Result`,
  declare: (name, expr) => `const ${name} = ${expr};`,
  declarePrefix: (name) => `const ${name} = `,
  quote: (value, literal) =>
    quoteString(
      value,
      literal.kind === 'template' ? '`' : (literal.raw[0] ?? "'")
    ),
  appendToFile: true,
  // Classes and `const` functions don't exist before their line.
  definitionsRunInOrder: true,
  elseBranch: (body, indent, unit, elseIf) =>
    elseIf ? ` else ${body}` : ` else {\n${indent}${unit}${body}\n${indent}}`,
  statementEnd: ';',
  expressionStatement,
  comment: {
    line: '//',
    region: (title) => (title ? `// #region ${title}` : '// #region'),
    endRegion: '// #endregion',
    doc: 'block',
  },
  template: (template, indent, unit) => {
    switch (template.type) {
      case 'flow': {
        return {
          forEach: `for (const item of undefined) {\n${indent}}`,
          forRange: `for (let i = 0; i < 10; i++) {\n${indent}}`,
          while: `while (false) {\n${indent}}`,
          switch: `switch (undefined) {\n${indent}${unit}case 0:\n${indent}${unit}${unit}break;\n${indent}${unit}default:\n${indent}${unit}${unit}break;\n${indent}}`,
          try: `try {\n${indent}} catch (error) {\n${indent}}`,
          throw: 'throw undefined;',
          break: 'break;',
          continue: 'continue;',
        }[template.flow];
      }

      case 'call': {
        const callee = template.callee.trim();
        return /^[\w$.]+$/.test(callee)
          ? `${callee}(${(template.args ?? []).join(', ')});`
          : undefined;
      }

      case 'setVar': {
        const name = template.name.trim();
        if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(name)) {
          return undefined;
        }

        // `let x;` needs no value (its value pin inserts one); `const` does.
        const value = template.value?.trim();
        return template.declaration === 'none'
          ? `${name} = ${value || 'undefined'};`
          : template.declaration === 'let' && !value
            ? `let ${name};`
            : `${template.declaration} ${name} = ${value || 'undefined'};`;
      }

      case 'branch': {
        return `if (true) {\n${indent}}`;
      }

      case 'return': {
        return 'return;';
      }

      case 'value': {
        const expression = template.expression.trim();
        return expression ? expressionStatement(expression) : undefined;
      }
    }
  },
};
