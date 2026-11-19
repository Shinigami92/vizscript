import type { DataType, DeclarationSyntax } from '@vizscript/core';
import { typeCoversInput } from '@vizscript/core';
import { addTypeScriptImport } from './add-import';
import { setDecorator, setTypeParams } from './decorators';
import { setModifier } from './modifiers';
import { parseFile } from './parse-file';
import { renameTypeScriptSymbol, typeScriptCallSites } from './rename';
import { quoteOf, quoteString } from './syntax';
import { KEYWORDS, TYPESCRIPT_TYPES } from './type-system';

/** Declarations of "My Script"; renames parse the file again. */
export function declarations(
  text: string,
  fileName?: string
): DeclarationSyntax {
  const isJs = /\.[cm]?jsx?$/i.test(fileName ?? '');
  const syntax: DeclarationSyntax = {
    typeSystem: TYPESCRIPT_TYPES,
    validType: (type) => {
      if (isJs) {
        return 'JavaScript has no type annotations.';
      }

      try {
        const source = `let x: ${type};`;
        const parsed = parseFile(source, 'type.ts');
        const [statement] = parsed.program.body;
        const declarator =
          statement?.type === 'VariableDeclaration' &&
          statement.declarations.length === 1
            ? statement.declarations[0]
            : undefined;
        const annotation =
          declarator?.id.type === 'Identifier' &&
          declarator.id.typeAnnotation?.type === 'TSTypeAnnotation'
            ? declarator.id.typeAnnotation.typeAnnotation
            : undefined;
        const valid =
          (parsed.errors?.length ?? 0) === 0 &&
          parsed.program.body.length === 1 &&
          !declarator?.init &&
          annotation?.start != null &&
          annotation.end != null &&
          typeCoversInput(
            { start: annotation.start, end: annotation.end },
            source,
            'let x: '.length,
            type
          );
        return valid ? undefined : `"${type}" is not a valid TypeScript type.`;
      } catch {
        return `"${type}" is not a valid TypeScript type.`;
      }
    },
    string: (value) => quoteString(value, quoteOf(text)),
    booleans: { true: 'true', false: 'false' },
    valueRequired: (symbol) => symbol.modifiers.includes('const'),
    returnArrow: ': ',
    callSites: (source, doc, symbol) =>
      typeScriptCallSites(
        parseFile(source, fileName).program,
        source,
        doc.symbols ?? [],
        symbol
      ),
    setModifier,
    setDecorator,
    setTypeParams,
    identifier: /^[A-Za-z_$][\w$]*$/,
    keywords: KEYWORDS,
    defaultIndent: '  ',
    blankLines: 1,
    bracedClasses: true,
    header: /^(?:import\b|['"]use strict['"]|#!)/,
    typeDeclaration: (name) => `interface ${name} {\n}`,
    fn: (name, _unit, method) =>
      method ? `${name}() {\n}` : `function ${name}() {\n}`,
    field: (name) => `${name}: string;`,
    variable: (name, { constant, member }) => {
      if (member) {
        return `${name} = undefined;`;
      }

      return constant ? `const ${name} = undefined;` : `let ${name};`;
    },
    extract: {
      fn: (name, params, body, { method, isStatic, isAsync }) => {
        const list = params
          .map((p) => {
            const type = p.type ?? typeScriptTypeOf(p.dataType);
            return type && !isJs ? `${p.name}: ${type}` : p.name;
          })
          .join(', ');
        const head = method
          ? `${isStatic ? 'static ' : ''}${isAsync ? 'async ' : ''}${name}`
          : `${isAsync ? 'async ' : ''}function ${name}`;
        return `${head}(${list}) {\n${body}\n}`;
      },
      call: (callee, args, { isAsync, output }) => {
        const store = output
          ? `${output.declare ? `${output.declare} ` : ''}${output.name} = `
          : '';
        return `${store}${isAsync ? 'await ' : ''}${callee}(${args.join(', ')});`;
      },
      returnValue: (name) => `return ${name};`,
      method: (name, className, isStatic) =>
        isStatic ? `${className}.${name}` : `this.${name}`,
    },
    addImport: (source, doc, request) =>
      addTypeScriptImport(source, doc, request, syntax),
    rename: (source, doc, symbol, name) =>
      renameTypeScriptSymbol(
        parseFile(source, fileName).program,
        doc.symbols ?? [],
        symbol,
        name
      ),
  };
  return syntax;
}

/** A pin type as TypeScript writes it, when it names one (`bool[]`). */
function typeScriptTypeOf(dataType: DataType | undefined): string | undefined {
  if (dataType?.endsWith('[]')) {
    const inner = typeScriptTypeOf(dataType.slice(0, -2));
    return inner ? `${inner}[]` : undefined;
  }

  if (dataType === 'bool') {
    return 'boolean';
  }

  return dataType === 'number' ||
    dataType === 'string' ||
    dataType === 'bigint' ||
    /^[A-Z]\w*$/.test(dataType ?? '')
    ? dataType
    : undefined;
}
