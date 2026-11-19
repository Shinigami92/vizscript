import type { Ref, ShallowRef } from 'vue';
import { computed, shallowRef, watch } from 'vue';
import type { TreeChanges } from '../graph/tree-changes';
import {
  hasTreeChanges,
  NO_TREE_CHANGES,
  parseTreeChanges,
} from '../graph/tree-changes';
import type { KeyValueStorage } from '../storage/browser-storage';
import {
  readStored,
  removeStored,
  writeStored,
} from '../storage/browser-storage';

export interface TreeChangesStore {
  changes: ShallowRef<TreeChanges>;
  /** Replaces the changes and keeps them in the browser. */
  set: (next: TreeChanges) => void;
}

/**
 * Files created, renamed and deleted in a repository branch
 * (`vizscript:tree:<scope>`), kept like drafts until the branch is left
 * for good.
 */
export function useTreeChanges(
  scope: Ref<string>,
  storage?: KeyValueStorage
): TreeChangesStore {
  const key = computed(() => `vizscript:tree:${scope.value}`);
  const read = (k: string): TreeChanges =>
    readStored(k, parseTreeChanges, storage) ?? NO_TREE_CHANGES;
  const changes = shallowRef(read(key.value));
  watch(key, (k) => {
    changes.value = read(k);
  });

  return {
    changes,
    set: (next) => {
      changes.value = next;
      if (hasTreeChanges(next)) {
        writeStored(key.value, next, storage);
      } else {
        removeStored(key.value, storage);
      }
    },
  };
}
