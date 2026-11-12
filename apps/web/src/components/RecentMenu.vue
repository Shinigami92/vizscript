<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { recentLocation, timeAgo, useRecentStore } from '../stores/recent';
import type { MenuEntry } from './ContextMenu.vue';
import ContextMenu from './ContextMenu.vue';

const recent = useRecentStore();
const router = useRouter();
const menu = ref<{ x: number; y: number } | null>(null);

function toggle(event: MouseEvent): void {
  if (menu.value) {
    menu.value = null;
    return;
  }

  void recent.load();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { x: rect.left, y: rect.bottom + 4 };
}

const entries = computed<MenuEntry[]>(() => [
  { type: 'header', label: 'Recently opened' },
  ...recent.projects.slice(0, 10).map((project): MenuEntry => ({
    label: `${project.owner}/${project.repo}${project.path ? ` · ${project.path.split('/').at(-1)}` : ''}`,
    icon: 'i-mdi-source-repository',
    shortcut: timeAgo(project.openedAt),
    action: () => void router.push(recentLocation(project)),
  })),
  { type: 'separator' },
  {
    label: 'All repositories',
    icon: 'i-mdi-format-list-bulleted',
    action: () => void router.push('/repos'),
  },
]);
</script>

<template>
  <template v-if="recent.projects.length > 0">
    <button
      type="button"
      class="btn-ghost recent-toggle px-2"
      title="Recently opened"
      aria-label="Recently opened"
      aria-haspopup="menu"
      :aria-expanded="menu !== null"
      @click="toggle"
    >
      <span class="i-mdi-history" />
    </button>
    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :entries="entries"
      :ignore="['.recent-toggle']"
      label="Recently opened"
      @close="menu = null"
    />
  </template>
</template>
