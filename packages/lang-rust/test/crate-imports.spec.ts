import type { GraphDocument, ImportedDeclaration, Pin } from '@vizscript/core';
import { exportedSymbols, exportedTypeMembers } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseRustDocument } from '../src';

// Like the server's stubs of a crate (from docs.rs's rustdoc JSON).
const STUBS = `pub fn from_str<T>(s: &str) -> Result<T> {}
pub fn to_string<T>(value: &T) -> Result<String> {}
pub enum Value {
    Null,
    Bool(bool),
    String(String),
}
impl Value {
    pub fn as_str(&self) -> Option<&str> {}
    pub fn as_i64(&self) -> Option<i64> {}
    pub fn pointer(&self, pointer: &str) -> Option<&Value> {}
    pub fn take(&mut self) -> Value {}
    fn hidden(&self) -> bool {}
}
pub struct Client<T> {
    pub timeout: u64,
}
impl<T> Client<T> {
    pub fn new() -> Self {}
    pub async fn send(&self, body: T) -> Result<Response> {}
    pub fn build(&self) -> Result<Response, Error> {}
}
pub struct Response {}
impl Response {
    pub fn status(&self) -> u16 {}
}
pub type Result<T> = core::result::Result<T, Error>;
`;

const TEXT = `use serde_json::{from_str, Value};
use serde_json::Client as Http;
use serde_json::Response;

async fn run(text: &str, value: Value) {
    let name = value.as_str();
    let count = value.as_i64();
    let inner = value.pointer("/a");
    let parsed: Value = from_str(text).unwrap();
    let client: Http<String> = Http::new();
    let wait = client.timeout;
    let response = client.send(String::new()).await;
    let built = client.build().map_err(|e| e.to_string())?;
}
`;

function declarations(): ImportedDeclaration[] {
  const stubs = parseRustDocument(STUBS, 'serde_json.rs');
  const exports = exportedSymbols(stubs, STUBS);
  const members = exportedTypeMembers(stubs, STUBS);
  const named = (name: string, local = name): ImportedDeclaration => {
    const declaration = exports.find((s) => s.name === name);
    const own = members.filter((s) => s.scope === name);
    return {
      name: local,
      ...(declaration ? { declaration } : {}),
      ...(own.length > 0 ? { members: own } : {}),
    };
  };
  return [
    named('from_str'),
    named('Value'),
    named('Client', 'Http'),
    named('Response'),
  ];
}

function outputs(doc: GraphDocument): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  for (const node of doc.functions.flatMap((f) => f.nodes)) {
    for (const pin of node.pins) {
      if (pin.range && pin.direction === 'out' && pin.kind === 'data') {
        pins.set(TEXT.slice(pin.range.start, pin.range.end), pin);
      }
    }
  }

  return pins;
}

describe('types of crate imports', () => {
  it('lists the public members of exported types, scoped by the type', () => {
    const stubs = parseRustDocument(STUBS, 'serde_json.rs');
    const members = exportedTypeMembers(stubs, STUBS).map(
      (s) => `${s.scope}.${s.name}`
    );
    expect(members).toEqual([
      'Value.as_str',
      'Value.as_i64',
      'Value.pointer',
      'Value.take',
      'Client.timeout',
      'Client.new',
      'Client.send',
      'Client.build',
      'Response.status',
    ]);
  });

  const doc = parseRustDocument(TEXT, 'main.rs', {
    imports: declarations(),
  });
  const pins = outputs(doc);
  const typeOf = (code: string): string | undefined => pins.get(code)?.typeText;

  it('follows methods, fields and functions of imported types', () => {
    expect(typeOf('value.as_str()')).toBe('Option<str>');
    expect(typeOf('value.as_i64()')).toBe('Option<i64>');
    expect(typeOf('value.pointer("/a")')).toBe('Option<Value>');
    expect(typeOf('Http::new()')).toBe('Http');
    expect(typeOf('client.timeout')).toBe('u64');
    expect(typeOf('client.send(String::new()).await')).toBe('Result<Response>');
    // `?` after std's `map_err` keeps the crate's type.
    expect(typeOf('client.build().map_err(|e| e.to_string())?')).toBe(
      'Response'
    );
  });

  it('lists the members of an imported type for the action menu', () => {
    expect(
      doc.typeMembers?.['Value']?.find((m) => m.name === 'as_str')
    ).toMatchObject({
      kind: 'method',
      detail: 'as_str() -> Option<&str>',
    });
    expect(doc.typeMembers?.['Value']?.some((m) => m.name === 'hidden')).toBe(
      false
    );
  });

  it('names the parameters of imported methods', () => {
    const pointer = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'pointer');
    expect(
      pointer?.pins
        .filter((p) => p.direction === 'in' && p.kind === 'data')
        .map((p) => [p.id, p.name, p.type])
    ).toEqual([
      // UE's Target: the type the method is called on.
      ['target', 'self', 'Value'],
      ['arg0', 'pointer', 'string'],
    ]);
  });
});

const BY_PATH = `fn run(text: &str) {
    let parsed: serde_json::Value = serde_json::from_str(text).unwrap();
    let name = parsed.as_str();
    let json = serde_json::to_string(&parsed);
    let null = serde_json::Value::Null;
    let client = serde_json::Client::new();
    let wait = client.timeout;
}
`;

describe('crate items named by their path', () => {
  it('lists the items a file names by a path, not std or its own', () => {
    const doc = parseRustDocument(
      `use nom::IResult;
use std::fmt;

fn f(v: serde_json::Value, r: std::io::Result<()>) -> crate::Item {
    let a = ignore::overrides::OverrideBuilder::new(".");
    let b = serde_json::to_string(&v);
    let c = Item::new();
    let d = super::helper();
    let e = serde_json::Value::Null;
}
`,
      'main.rs'
    );
    expect(doc.libraryPaths).toEqual([
      'serde_json::Value',
      'ignore::overrides::OverrideBuilder',
      'serde_json::to_string',
    ]);
  });

  const stubs = parseRustDocument(STUBS, 'serde_json.rs');
  const exports = exportedSymbols(stubs, STUBS);
  const members = exportedTypeMembers(stubs, STUBS);
  const byPath = (item: string): ImportedDeclaration => {
    const own = members.filter((s) => s.scope === item);
    const declaration = exports.find((s) => s.name === item);
    return {
      name: `serde_json::${item}`,
      ...(declaration ? { declaration } : {}),
      ...(own.length > 0 ? { members: own } : {}),
    };
  };
  const doc = parseRustDocument(BY_PATH, 'main.rs', {
    imports: ['Value', 'from_str', 'to_string', 'Client'].map(byPath),
  });
  const pins = new Map<string, Pin>();
  for (const node of doc.functions.flatMap((f) => f.nodes)) {
    for (const pin of node.pins) {
      if (pin.range && pin.direction === 'out' && pin.kind === 'data') {
        pins.set(BY_PATH.slice(pin.range.start, pin.range.end), pin);
      }
    }
  }

  const typeOf = (code: string): string | undefined => pins.get(code)?.typeText;

  it('follows them like imported names', () => {
    expect(typeOf('parsed.as_str()')).toBe('Option<str>');
    expect(typeOf('serde_json::to_string(&parsed)')).toBe('Result<String>');
    // `from_str<T>`'s `T` is unknown, not a type named `T`.
    expect(typeOf('serde_json::from_str(text)')).toBeUndefined();
    expect(typeOf('serde_json::Value::Null')).toBe('Value');
    expect(typeOf('serde_json::Client::new()')).toBe('Client');
    expect(typeOf('client.timeout')).toBe('u64');
  });
});
