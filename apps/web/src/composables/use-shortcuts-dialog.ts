import { createGlobalState } from '@vueuse/core';
import type { Ref } from 'vue';
import { ref } from 'vue';

/** Whether the keyboard shortcuts dialog is open (`?` anywhere). */
export const useShortcutsDialog = createGlobalState((): Ref<boolean> =>
  ref(false)
);
