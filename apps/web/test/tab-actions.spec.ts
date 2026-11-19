import { describe, expect, it } from 'vitest';
import { ref, shallowRef } from 'vue';
import type { LoadedFile } from '../src/composables/use-file-session';
import type { FileTabs } from '../src/composables/use-file-tabs';
import { useTabActions } from '../src/composables/use-tab-actions';

function setup(shown: string | null, next: string | null | undefined) {
  const calls: string[] = [];
  const opened: string[] = [];
  const actions = useTabActions(
    {
      file: shallowRef<LoadedFile | null>(
        shown ? { path: shown, content: '', version: '1' } : null
      ),
      tabs: {
        open: (path: string) => opened.push(path),
      } as unknown as FileTabs,
      closeTab: () => next,
      closeOtherTabs: (path) => calls.push(`others:${path}`),
      closeAllTabs: () => calls.push('all'),
    },
    {
      path: ref(shown ?? ''),
      selectFile: (path) => calls.push(`select:${path}`),
      showNoFile: () => calls.push('none'),
    }
  );
  return { actions, calls, opened };
}

describe('useTabActions', () => {
  it('shows the next tab, or the folder after the last one', () => {
    const next = setup('a.ts', 'b.ts');
    next.actions.closeTab('a.ts');
    expect(next.calls).toEqual(['select:b.ts']);

    const last = setup('a.ts', null);
    last.actions.closeTab('a.ts');
    expect(last.calls).toEqual(['none']);

    // A tab in the background: nothing else changes.
    const background = setup('a.ts', undefined);
    background.actions.closeTab('b.ts');
    expect(background.calls).toEqual([]);
  });

  it('shows the kept tab when closing the others', () => {
    const s = setup('a.ts', undefined);
    s.actions.closeOtherTabs('b.ts');
    expect(s.calls).toEqual(['others:b.ts', 'select:b.ts']);
    s.actions.closeAllTabs();
    expect(s.calls.slice(-2)).toEqual(['all', 'none']);
  });

  it('pins a file and opens it unless it is shown', () => {
    const s = setup('a.ts', undefined);
    s.actions.pinFile('a.ts');
    s.actions.pinFile('b.ts');
    expect(s.opened).toEqual(['a.ts', 'b.ts']);
    expect(s.calls).toEqual(['select:b.ts']);
  });
});
