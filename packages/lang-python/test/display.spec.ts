import { isAdvancedPin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parsePythonDocument } from '../src';

describe('isAdvancedPin', () => {
  it('folds arguments left at their default, not required ones', () => {
    const text = [
      'def fetch(city: str, retries: int = 3) -> None:',
      '    pass',
      '',
      'def show(text: str) -> None:',
      '    pass',
      '',
      'fetch("Berlin")',
      'fetch("Paris", 5)',
      'show()',
      '',
    ].join('\n');
    const nodes = parsePythonDocument(text, 't.py').functions.flatMap(
      (f) => f.nodes
    );
    const advanced = (title: string, at: number): string[] =>
      (nodes.filter((n) => n.title === title)[at]?.pins ?? [])
        .filter(isAdvancedPin)
        .map((p) => p.name);
    expect(advanced('fetch', 0)).toEqual(['retries']);
    expect(advanced('fetch', 1)).toEqual([]);
    expect(advanced('show', 0)).toEqual([]);
  });
});
