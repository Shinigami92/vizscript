import type { ModuleReference } from '@vizscript/core';
import type { Token } from './lexer';
import { tokenize } from './lexer';
import { stringLiteral } from './parser';

/** Functions whose first argument is a resource path. */
const LOADERS = new Set(['preload', 'load']);

/** Range of a string token's contents (between the quotes). */
function contentRange(token: Token): { start: number; end: number } {
  const raw = token.value;
  let i = 0;
  while ('r&^'.includes(raw[i] ?? '')) {
    i++;
  }

  const quote = raw[i] ?? '"';
  const delimiter = raw.startsWith(quote.repeat(3), i) ? 3 : 1;
  const start = token.start + i + delimiter;
  const end = raw.endsWith(quote.repeat(delimiter))
    ? token.end - delimiter
    : token.end;
  return { start, end: Math.max(start, end) };
}

/** Whether a relative string is used as a path (`preload("x.gd")`). */
function isPathArgument(tokens: ReadonlyArray<Token>, index: number): boolean {
  const before = tokens[index - 1];
  if (before?.type === 'name' && before.value === 'extends') {
    return true;
  }

  const callee = tokens[index - 2];
  return (
    before?.type === 'op' &&
    before.value === '(' &&
    callee?.type === 'name' &&
    LOADERS.has(callee.value)
  );
}

/**
 * Resource paths of a script: every `"res://…"` string and relative paths
 * in `preload()`, `load()` and `extends`.
 */
export function gdscriptReferences(text: string): ModuleReference[] {
  const { tokens } = tokenize(text);
  const references: ModuleReference[] = [];
  /** `const Name = preload("…")`: names bound to a script. */
  const bindings = new Map<string, ModuleReference>();
  const bindingAt = new Set<number>();
  tokens.forEach((token, index) => {
    if (token.type !== 'string') {
      return;
    }

    const { kind, value } = stringLiteral(token.value);
    if (kind !== 'string' || value === '' || value.includes('\n')) {
      return;
    }

    const range = contentRange(token);
    let reference: ModuleReference | undefined;
    if (value.startsWith('res://')) {
      const path = value.slice('res://'.length);
      if (path !== '') {
        reference = {
          range,
          specifier: value,
          candidates: [`/${path}`],
          anchor: 'project.godot',
        };
      }
    } else if (!/^[a-z]+:\/\//i.test(value) && isPathArgument(tokens, index)) {
      reference = {
        range,
        specifier: value,
        candidates: [value.startsWith('.') ? value : `./${value}`],
      };
    }

    if (!reference) {
      return;
    }

    references.push(reference);
    // const Name = preload("…") / var Name := load("…")
    const [keyword, name, assign, loader, paren] = [5, 4, 3, 2, 1].map(
      (back) => tokens[index - back]
    );
    if (
      paren?.value === '(' &&
      loader &&
      LOADERS.has(loader.value) &&
      (assign?.value === '=' || assign?.value === ':=') &&
      name?.type === 'name' &&
      (keyword?.value === 'const' || keyword?.value === 'var')
    ) {
      bindings.set(name.value, reference);
      bindingAt.add(index - 4);
    }
  });

  // Uses of the bound names: `Name.new()`, `Name.CONSTANT`, `is Name`.
  tokens.forEach((token, index) => {
    const binding =
      token.type === 'name' ? bindings.get(token.value) : undefined;
    if (!binding || bindingAt.has(index) || tokens[index - 1]?.value === '.') {
      return;
    }

    const use = (from: Token, symbol?: string): void => {
      references.push({
        range: { start: from.start, end: from.end },
        specifier: from.value,
        candidates: binding.candidates,
        ...(binding.anchor ? { anchor: binding.anchor } : {}),
        ...(symbol ? { symbol } : {}),
      });
    };
    use(token);
    const member = tokens[index + 2];
    if (tokens[index + 1]?.value === '.' && member?.type === 'name') {
      // `Script.new()` runs the script's `_init`.
      use(member, member.value === 'new' ? '_init' : member.value);
    }
  });
  return references.toSorted((a, b) => a.range.start - b.range.start);
}
