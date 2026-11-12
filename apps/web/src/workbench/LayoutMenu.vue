<script setup lang="ts">
import { PRESETS, VIEW_IDS, VIEW_TITLES } from '@vizscript/workbench';
import { computed, ref } from 'vue';
import type { MenuEntry } from '../components/ContextMenu.vue';
import ContextMenu from '../components/ContextMenu.vue';
import { useToasts } from '../composables/use-toasts';
import { useWorkbenchStore } from '../stores/workbench';

const store = useWorkbenchStore();
const { show } = useToasts();
const menu = ref<{ x: number; y: number } | null>(null);

function toggleMenu(event: MouseEvent): void {
  if (menu.value) {
    menu.value = null;
    return;
  }

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { x: rect.right - 256, y: rect.bottom + 4 };
}

const entries = computed<MenuEntry[]>(() => [
  { type: 'header', label: 'Views' },
  ...VIEW_IDS.filter((view) => store.available.has(view)).map(
    (view): MenuEntry => ({
      label: VIEW_TITLES[view],
      icon: store.isVisible(view)
        ? 'i-mdi-checkbox-marked-outline text-amber-400'
        : 'i-mdi-checkbox-blank-outline',
      action: () => store.toggle(view),
    })
  ),
  ...(store.isMobile
    ? []
    : ([
        { type: 'separator' },
        { type: 'header', label: 'Layouts' },
        ...PRESETS.map((preset): MenuEntry => ({
          label: preset.name,
          icon:
            store.presetId === preset.id
              ? 'i-mdi-radiobox-marked text-amber-400'
              : 'i-mdi-radiobox-blank',
          action: () => store.applyPreset(preset.id),
        })),
        { type: 'separator' },
        {
          label: 'Reset layout',
          icon: 'i-mdi-restore',
          action: () => {
            void store.reset();
            show('Layout reset to the default.');
          },
        },
      ] satisfies MenuEntry[])),
]);
</script>

<template>
  <button
    type="button"
    class="btn-ghost layout-menu-toggle px-2"
    title="Layout: show, hide and arrange views"
    aria-label="Layout"
    aria-haspopup="menu"
    :aria-expanded="menu !== null"
    @click="toggleMenu"
  >
    <span class="i-mdi-view-dashboard-edit-outline" />
  </button>
  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :entries="entries"
    :ignore="['.layout-menu-toggle']"
    label="Layout"
    @close="menu = null"
  />
</template>
