import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import {
  opTransaction,
  parseRole,
  textChange,
} from '../src/components/script-workspace/op-transaction';

const edits = [{ start: 7, end: 7, text: 'b = 2;\n' }];

describe('op transactions', () => {
  it('knows the text the edits make', () => {
    const transaction = opTransaction('a = 1;\n', edits, 3);
    expect(transaction.after).toBe('a = 1;\nb = 2;\n');
    expect(transaction.after).toBe(applyTextEdits('a = 1;\n', edits));
  });

  it('leaves its notes to a parse started after the edits were written', () => {
    const transaction = opTransaction('a = 1;\n', edits, 3);
    expect(parseRole(null, 4)).toBe('none');
    // Typing parsed before the op finishes after it: not the op's result.
    expect(parseRole(transaction, 2)).toBe('earlier');
    expect(parseRole(transaction, 3)).toBe('earlier');
    expect(parseRole(transaction, 4)).toBe('result');
  });

  it('follows nodes through its own edits only when they made the text', () => {
    const transaction = opTransaction('a = 1;\n', edits, 0);
    expect(textChange(transaction, 'a = 1;\n', transaction.after)).toEqual({
      before: 'a = 1;\n',
      edits,
    });

    // Typed right after the op: the change is the difference of the texts.
    const typed = `${transaction.after}c`;
    const change = textChange(transaction, 'a = 1;\n', typed);
    expect(change.edits).not.toBe(edits);
    expect(applyTextEdits(change.before, change.edits)).toBe(typed);
    expect(textChange(null, 'x', 'y').edits).toEqual([
      { start: 0, end: 1, text: 'y' },
    ]);
  });
});
