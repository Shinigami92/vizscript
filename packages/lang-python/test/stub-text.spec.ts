import { describe, expect, it } from 'vitest';
import { parsePythonDocument, preparePythonStub } from '../src';

describe('typeshed stubs for the parser', () => {
  it('keeps the branches of version and platform checks that apply', () => {
    const stub = `import sys

if sys.version_info >= (3, 12):
    def new() -> int: ...
else:
    def old() -> int: ...

class A:
    if sys.version_info >= (3, 13):
        def later(self) -> str: ...
    elif sys.version_info >= (3, 11):
        def now(self) -> str: ...
    if sys.platform == "win32":
        def windows(self) -> None: ...

if sys.platform != "win32" and sys.version_info < (3, 14):
    def posix() -> None: ...
`;
    const text = preparePythonStub(stub, '3.12');
    expect(text).toContain('\ndef new() -> int: ...');
    expect(text).not.toContain('def old');
    expect(text).toContain('\n    def now(self) -> str: ...');
    expect(text).not.toContain('def later');
    expect(text).not.toContain('def windows');
    expect(text).toContain('\ndef posix() -> None: ...');
    expect(parsePythonDocument(text, 's.py').diagnostics).toEqual([]);
  });

  it('keeps multi-line strings in a branch whole', () => {
    const stub = `import sys
class A:
    if sys.version_info >= (3, 12):
        @deprecated("""Use b.
Really.""")
        def a(self) -> int: ...
`;
    const text = preparePythonStub(stub, '3.12');
    expect(text).toContain('    @deprecated("""Use b.\nReally.""")\n    def a');
    expect(parsePythonDocument(text, 's.py').diagnostics).toEqual([]);
  });

  it('reads private type variables and aliases as Any', () => {
    const stub = `from typing import Any, TypeAlias, TypeVar
from .reader import _Stream, Reader
_T = TypeVar("_T")
_Data: TypeAlias = (
    bytes
    | str
)
def first(items: list[_T], data: _Data, stream: _Stream) -> _T: ...
`;
    expect(preparePythonStub(stub)).toBe(
      'from typing import Any, TypeAlias, TypeVar\nfrom .reader import Any, Reader\ndef first(items: list[Any], data: Any, stream: Any) -> Any: ...\n'
    );
  });

  it("makes a private instance's methods functions of the module", () => {
    const stub = `class Random:
    def seed(self, a: int | None = None) -> None: ...
    def random(self) -> float: ...

_inst: Random
seed = _inst.seed
random = _inst.random
`;
    const text = preparePythonStub(stub);
    expect(text).toContain('\ndef seed(a: int | None = None) -> None: ...');
    expect(text).toContain('\ndef random() -> float: ...');
  });
});
