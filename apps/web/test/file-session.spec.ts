import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { LoadedFile } from '../src/composables/use-file-session';
import { useFileSession } from '../src/composables/use-file-session';

/** `localStorage` for the tests. */
function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

interface Setup {
  session: ReturnType<typeof useFileSession>;
  path: ReturnType<typeof ref<string>>;
  scope: ReturnType<typeof ref<string>>;
  storage: ReturnType<typeof memoryStorage>;
  disk: Map<string, string>;
  disposed: string[];
  restored: string[];
  /** Shows a file like a route change does, and waits until it is read. */
  show: (file: string) => Promise<void>;
}

function setup(
  files: Record<string, string>,
  storage = memoryStorage()
): Setup {
  const disk = new Map(Object.entries(files));
  const path = ref('');
  const scope = ref('local/p1');
  const disposed: string[] = [];
  const restored: string[] = [];
  const session = useFileSession({
    scope,
    path,
    isFile: ref(true),
    read: (file): Promise<LoadedFile> => {
      const content = disk.get(file);
      return content === undefined
        ? Promise.reject(new Error(`No ${file}`))
        : Promise.resolve({ path: file, content, version: content });
    },
    dispose: (file) => disposed.push(file),
    onRestored: () => restored.push(path.value),
    storage,
  });
  return {
    session,
    path,
    scope,
    storage,
    disk,
    disposed,
    restored,
    show: async (file) => {
      path.value = file;
      await session.loadFile();
      await nextTick();
    },
  };
}

const draftKey = (file: string): string => `vizscript:draft:local/p1:${file}`;

describe('file session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps unsaved text per tab and writes a draft for each', async () => {
    const s = setup({ 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' });
    await s.show('a.py');
    s.session.text.value = 'a = 2\n';
    await nextTick();
    // Another file within the draft delay: both drafts are still written.
    await s.show('b.py');
    s.session.text.value = 'b = 2\n';
    await nextTick();
    vi.advanceTimersByTime(600);

    expect(JSON.parse(s.storage.getItem(draftKey('a.py')) ?? '{}')).toEqual(
      expect.objectContaining({ version: 'a = 1\n', text: 'a = 2\n' })
    );
    expect(JSON.parse(s.storage.getItem(draftKey('b.py')) ?? '{}')).toEqual(
      expect.objectContaining({ version: 'b = 1\n', text: 'b = 2\n' })
    );
    expect([...s.session.dirtyTabs.value].toSorted()).toEqual(['a.py', 'b.py']);

    // Back to a.py: its tab still has the changes.
    await s.show('a.py');
    expect(s.session.text.value).toBe('a = 2\n');
    expect(s.session.dirty.value).toBe(true);
  });

  it('restores drafts of the same version, also older formats', async () => {
    const storage = memoryStorage();
    storage.setItem(
      draftKey('a.py'),
      JSON.stringify({ base: 'a = 1\n', text: 'a = 9\n' })
    );
    storage.setItem(
      draftKey('b.py'),
      JSON.stringify({ version: 'old\n', text: 'b = 9\n' })
    );
    const s = setup({ 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' }, storage);
    await s.show('a.py');
    expect(s.session.text.value).toBe('a = 9\n');
    expect(s.restored).toEqual(['a.py']);

    // The file changed since: the draft doesn't belong to it anymore.
    await s.show('b.py');
    expect(s.session.text.value).toBe('b = 1\n');
  });

  it('marks a file saved while another one is shown', async () => {
    const s = setup({ 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' });
    await s.show('a.py');
    s.session.text.value = 'a = 2\n';
    await nextTick();
    await s.show('b.py');

    s.session.markSaved('a.py', 'a = 2\n');
    expect(s.storage.getItem(draftKey('a.py'))).toBeNull();
    expect(s.session.dirtyTabs.value.has('a.py')).toBe(false);
    expect(s.session.file.value?.path).toBe('b.py');

    // Changes made while it was written stay as a draft on the new base.
    await s.show('a.py');
    s.session.text.value = 'a = 3\n';
    await nextTick();
    s.session.markSaved('a.py', 'a = 2b\n');
    expect(s.session.file.value?.content).toBe('a = 2b\n');
    expect(JSON.parse(s.storage.getItem(draftKey('a.py')) ?? '{}')).toEqual(
      expect.objectContaining({ version: 'a = 2b\n', text: 'a = 3\n' })
    );
  });

  it('starts fresh in another folder or branch', async () => {
    const s = setup({ 'a.py': 'a = 1\n' });
    await s.show('a.py');
    s.scope.value = 'local/p2';
    await nextTick();
    expect(s.disposed).toEqual(['a.py']);
    expect(s.session.openText('a.py')).toBeUndefined();
  });

  it('keeps the newest file when an earlier read finishes late', async () => {
    const s = setup({ 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' });
    s.path.value = 'a.py';
    const slow = s.session.loadFile();
    s.path.value = 'b.py';
    await s.session.loadFile();
    await slow;
    expect(s.session.file.value?.path).toBe('b.py');
    expect(s.session.text.value).toBe('b = 1\n');
  });
});
