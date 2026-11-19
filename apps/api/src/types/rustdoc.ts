/**
 * A crate's public API as Rust declarations, one text per module, from the
 * rustdoc JSON docs.rs builds (`/crate/<name>/<version>/json`): functions,
 * structs, enums, traits, type aliases, constants and inherent `impl`
 * blocks, with bodies left empty. The web app parses them like any Rust
 * file (the backend's own language, like Python's typeshed stubs), so
 * `use serde_json::from_str;` gets the function's pins.
 *
 * rustdoc's format changes between versions (`format_version`): renamed
 * fields are read under both names (`sig` / `decl`, `path` / `name`,
 * `use` / `import`, `type_alias` / `typedef`).
 */

export interface CrateStubs {
  crate: string;
  version: string;
  /** Declarations by module path inside the crate (`''`, `bytes::complete`). */
  modules: Record<string, string>;
}

type Json = Record<string, unknown>;

interface Item {
  id?: unknown;
  name?: string | null;
  visibility?: unknown;
  inner: Json;
}

/** Items of one module (or impl / trait) at most; a crate's modules at most. */
const ITEM_LIMIT = 2000;
const MODULE_LIMIT = 500;

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The single key of a tagged value (`{ "function": {…} }`). */
function tagOf(value: unknown): [string, unknown] | undefined {
  const record = obj(value);
  const key = record ? Object.keys(record)[0] : undefined;
  return key && record ? [key, record[key]] : undefined;
}

/** A Rust type as text, without lifetimes. */
export function typeText(type: unknown): string {
  if (typeof type === 'string') {
    return type;
  }

  const tagged = tagOf(type);
  if (!tagged) {
    return '_';
  }

  const [kind, value] = tagged;
  const v = obj(value);
  switch (kind) {
    case 'primitive':
    case 'generic': {
      return str(value) ?? '_';
    }

    case 'resolved_path': {
      // `crate::error::Result`, `alloc::string::String`: the name people
      // write and the built-in types know.
      const name = (str(v?.path) ?? str(v?.name) ?? '_').split('::').at(-1);
      return `${name ?? '_'}${genericArgs(v?.args)}`;
    }

    case 'borrowed_ref': {
      return `&${v?.is_mutable === true || v?.mutable === true ? 'mut ' : ''}${typeText(v?.type)}`;
    }

    case 'raw_pointer': {
      return `*${v?.is_mutable === true || v?.mutable === true ? 'mut' : 'const'} ${typeText(v?.type)}`;
    }

    case 'tuple': {
      const items = list(value).map(typeText);
      return items.length === 1 ? `(${items[0]},)` : `(${items.join(', ')})`;
    }

    case 'slice': {
      return `[${typeText(value)}]`;
    }

    case 'array': {
      return `[${typeText(v?.type)}; ${str(v?.len) ?? '_'}]`;
    }

    case 'impl_trait': {
      return `impl ${bounds(value) || 'Sized'}`;
    }

    case 'dyn_trait': {
      const traits = list(v?.traits).map((t) =>
        typeText({ resolved_path: obj(t)?.trait })
      );
      return `dyn ${traits.join(' + ') || 'Sized'}`;
    }

    case 'qualified_path': {
      return `${typeText(v?.self_type)}::${str(v?.name) ?? '_'}`;
    }

    case 'function_pointer': {
      const sig = obj(v?.sig) ?? obj(v?.decl);
      const inputs = list(sig?.inputs).map((input) => typeText(list(input)[1]));
      const output = sig?.output ? ` -> ${typeText(sig.output)}` : '';
      return `fn(${inputs.join(', ')})${output}`;
    }

    default: {
      return '_';
    }
  }
}

/**
 * `<T, U>` and associated types (`Output = I`) of a path, or a closure's
 * `(I) -> O` (`impl Fn(I) -> O`).
 */
function genericArgs(args: unknown): string {
  const parenthesized = obj(obj(args)?.parenthesized);
  if (parenthesized) {
    const inputs = list(parenthesized.inputs).map(typeText).join(', ');
    const output =
      parenthesized.output === null || parenthesized.output === undefined
        ? ''
        : ` -> ${typeText(parenthesized.output)}`;
    return `(${inputs})${output}`;
  }

  const angled = obj(obj(args)?.angle_bracketed);
  if (!angled) {
    return '';
  }

  const types = list(angled.args).flatMap((arg) => {
    const type = obj(arg)?.type;
    return type === undefined ? [] : [typeText(type)];
  });
  const assoc = list(angled.constraints ?? angled.bindings).flatMap((c) => {
    const constraint = obj(c);
    const equality = obj(obj(constraint?.binding)?.equality);
    const name = str(constraint?.name);
    return name && equality?.type !== undefined
      ? [`${name} = ${typeText(equality.type)}`]
      : [];
  });
  const all = [...types, ...assoc];
  return all.length > 0 ? `<${all.join(', ')}>` : '';
}

/** Trait bounds as text (`Fn(I) -> O + Clone`), lifetimes left out. */
function bounds(value: unknown): string {
  return list(value)
    .flatMap((bound) => {
      const traitBound = obj(obj(bound)?.trait_bound);
      return traitBound ? [typeText({ resolved_path: traitBound.trait })] : [];
    })
    .join(' + ');
}

/** `<T: Bound, U>` of type parameters (lifetimes left out). */
function generics(value: unknown): string {
  const params = list(obj(value)?.params).flatMap((param) => {
    const p = obj(param);
    const type = obj(obj(p?.kind)?.type);
    const name = str(p?.name);
    if (!name || !type || type.is_synthetic === true) {
      return [];
    }

    const bound = bounds(type.bounds);
    return [bound ? `${name}: ${bound}` : name];
  });
  return params.length > 0 ? `<${params.join(', ')}>` : '';
}

/** `<T, U>`: the names of type parameters, for `impl<…> Name<T, U>`. */
function genericNames(value: unknown): string {
  const names = list(obj(value)?.params).flatMap((param) => {
    const p = obj(param);
    const type = obj(obj(p?.kind)?.type);
    const name = str(p?.name);
    return name && type && type.is_synthetic !== true ? [name] : [];
  });
  return names.length > 0 ? `<${names.join(', ')}>` : '';
}

/** `&self`, `&mut self`, `self` for a method's receiver, else `name: T`. */
function parameter(input: unknown): string {
  const [name, type] = list(input);
  const text = typeText(type);
  if (name === 'self') {
    return text === 'Self' ? 'self' : text.replace(/Self$/, 'self');
  }

  return `${str(name) ?? '_'}: ${text}`;
}

function functionText(name: string, fn: Json, pub: boolean): string {
  const sig = obj(fn.sig) ?? obj(fn.decl);
  const inputs = list(sig?.inputs).map(parameter).join(', ');
  const output =
    sig?.output === null || sig?.output === undefined
      ? ''
      : ` -> ${typeText(sig.output)}`;
  const header = obj(fn.header);
  const asyncWord = header?.is_async === true || header?.async === true;
  return `${pub ? 'pub ' : ''}${asyncWord ? 'async ' : ''}fn ${name}${generics(fn.generics)}(${inputs})${output} {}`;
}

/** A literal stays; any other expression becomes `todo!()`. */
function constValue(value: unknown): string {
  const text = str(value) ?? str(obj(value)?.expr) ?? '';
  return /^(?:-?[\d_.]+(?:[iu]\d+|f\d+|usize|isize)?|true|false|"[^"]*"|'[^']')$/.test(
    text
  )
    ? text
    : 'todo!()';
}

function isPublic(item: Item): boolean {
  return item.visibility === 'public';
}

class Converter {
  private readonly modules: Record<string, string> = {};
  private readonly seen = new Set<string>();

  public constructor(private readonly index: Record<string, Item>) {}

  public result(): Record<string, string> {
    return this.modules;
  }

  private item(id: unknown): Item | undefined {
    return typeof id === 'number' || typeof id === 'string'
      ? this.index[String(id)]
      : undefined;
  }

  /** A module's public items, under `path` (a re-exported one too). */
  public module(moduleId: unknown, path: string[]): void {
    const key = `${String(moduleId)}@${path.join('::')}`;
    if (
      this.seen.has(key) ||
      Object.keys(this.modules).length >= MODULE_LIMIT
    ) {
      return;
    }

    this.seen.add(key);
    const lines: string[] = [];
    const names = new Set<string>();
    this.items(moduleId, path, lines, names, new Set());
    this.modules[path.join('::')] = lines.join('\n');
  }

  private items(
    moduleId: unknown,
    path: string[],
    lines: string[],
    names: Set<string>,
    globs: Set<string>
  ): void {
    const module = obj(this.item(moduleId)?.inner.module);
    for (const id of list(module?.items).slice(0, ITEM_LIMIT)) {
      const item = this.item(id);
      if (item && isPublic(item)) {
        this.declare(item, item.name ?? '', path, lines, names, globs);
      }
    }
  }

  private declare(
    item: Item,
    name: string,
    path: string[],
    lines: string[],
    names: Set<string>,
    globs: Set<string>
  ): void {
    const tagged = tagOf(item.inner);
    if (!tagged) {
      return;
    }

    const [kind, value] = tagged;
    const v = obj(value) ?? {};
    if (kind === 'use' || kind === 'import') {
      const target = this.item(v.id);
      const alias = str(v.name) ?? '';
      if (!target) {
        return;
      }

      if (v.is_glob === true || v.glob === true) {
        const key = String(v.id);
        if (!globs.has(key)) {
          globs.add(key);
          this.items(v.id, path, lines, names, globs);
        }
      } else {
        this.declare(target, alias, path, lines, names, globs);
      }

      return;
    }

    if (kind === 'module') {
      this.module(item.id, [...path, name]);
      return;
    }

    if (!name || names.has(name)) {
      return;
    }

    const text = this.render(kind, v, name);
    if (text) {
      names.add(name);
      lines.push(text);
    }
  }

  private render(kind: string, v: Json, name: string): string | undefined {
    switch (kind) {
      case 'function': {
        return functionText(name, v, true);
      }

      case 'struct': {
        return [this.struct(v, name), this.impls(v, name)]
          .filter(Boolean)
          .join('\n');
      }

      case 'enum': {
        const variants = list(v.variants).flatMap((id) => {
          const variant = this.item(id);
          const inner = obj(variant?.inner.variant);
          return variant?.name && inner
            ? [`    ${variant.name}${this.variantFields(inner.kind)},`]
            : [];
        });
        return [
          `pub enum ${name}${generics(v.generics)} {\n${variants.join('\n')}\n}`,
          this.impls(v, name),
        ]
          .filter(Boolean)
          .join('\n');
      }

      case 'trait': {
        const methods = list(v.items).flatMap((id) => {
          const member = this.item(id);
          const fn = obj(member?.inner.function);
          return member?.name && fn
            ? [
                `    ${functionText(member.name, fn, false).replace(/ \{\}$/, ';')}`,
              ]
            : [];
        });
        return `pub trait ${name}${generics(v.generics)} {\n${methods.join('\n')}\n}`;
      }

      case 'type_alias':
      case 'typedef': {
        // `type Result<T> = Result<T, Error>` would name itself: the full
        // path then (`core::result::Result<T, Error>`).
        const target = typeText(v.type);
        const own = target === name || target.startsWith(`${name}<`);
        const path = str(obj(obj(v.type)?.resolved_path)?.path);
        return `pub type ${name}${generics(v.generics)} = ${
          own && path ? `${path}${target.slice(name.length)}` : target
        };`;
      }

      case 'constant':
      case 'static': {
        const word = kind === 'static' ? 'static' : 'const';
        const value = obj(v.const)?.expr ?? v.expr;
        return `pub ${word} ${name}: ${typeText(v.type)} = ${constValue(value)};`;
      }

      default: {
        return undefined;
      }
    }
  }

  private struct(v: Json, name: string): string {
    const head = `pub struct ${name}${generics(v.generics)}`;
    const kind = v.kind;
    if (kind === 'unit') {
      return `${head};`;
    }

    const tagged = tagOf(kind);
    if (tagged?.[0] === 'tuple') {
      const fields = list(tagged[1]).map((id) => {
        const field = this.item(id);
        return field ? `pub ${typeText(field.inner.struct_field)}` : '_';
      });
      return `${head}(${fields.join(', ')});`;
    }

    const plain = obj(tagged?.[1]);
    const fields = list(plain?.fields ?? v.fields).flatMap((id) => {
      const field = this.item(id);
      return field?.name && isPublic(field)
        ? [`    pub ${field.name}: ${typeText(field.inner.struct_field)},`]
        : [];
    });
    return `${head} {\n${fields.join('\n')}\n}`;
  }

  private variantFields(kind: unknown): string {
    const tagged = tagOf(kind);
    if (!tagged) {
      return '';
    }

    const fields = list(obj(tagged[1])?.fields ?? tagged[1]).map((id) =>
      this.item(id)
    );
    if (tagged[0] === 'tuple') {
      return `(${fields.map((f) => (f ? typeText(f.inner.struct_field) : '_')).join(', ')})`;
    }

    return ` { ${fields
      .flatMap((f) =>
        f?.name ? [`${f.name}: ${typeText(f.inner.struct_field)}`] : []
      )
      .join(', ')} }`;
  }

  /** Inherent `impl` blocks: the type's own public methods. */
  private impls(v: Json, name: string): string {
    const methods = list(v.impls).flatMap((id) => {
      const impl = obj(this.item(id)?.inner.impl);
      if (!impl || impl.trait !== null || impl.is_synthetic === true) {
        return [];
      }

      return list(impl.items)
        .slice(0, ITEM_LIMIT)
        .flatMap((itemId) => {
          const member = this.item(itemId);
          const fn = obj(member?.inner.function);
          return member?.name && fn && isPublic(member)
            ? [`    ${functionText(member.name, fn, true)}`]
            : [];
        });
    });
    return methods.length > 0
      ? `impl${generics(v.generics)} ${name}${genericNames(v.generics)} {\n${methods.join('\n')}\n}`
      : '';
  }
}

/** The stubs of a crate from its rustdoc JSON; `undefined` if it isn't one. */
export function rustdocStubs(
  json: unknown,
  crate: string,
  version: string
): CrateStubs | undefined {
  const root = obj(json);
  const index = obj(root?.index) as Record<string, Item> | undefined;
  if (!root || !index || root.root === undefined) {
    return undefined;
  }

  const converter = new Converter(index);
  converter.module(root.root, []);
  return { crate, version, modules: converter.result() };
}
