<script setup lang="ts">
defineProps<{
  path: string;
  /** Name of the function shown on its own, if any. */
  focused: string | undefined;
  /** Graphs the shown one sits in (a callback's function), outermost first. */
  parents?: ReadonlyArray<{ id: string; name: string }>;
  canBack: boolean;
  canForward: boolean;
}>();

const emit = defineEmits<{
  navigate: [direction: 'back' | 'forward'];
  /** Show all functions again. */
  showAll: [];
  /** Show one of the parent graphs. */
  open: [fnId: string];
}>();
</script>

<template>
  <!-- UE's breadcrumb: back / forward and the shown function. -->
  <div
    data-ui="graph-breadcrumb"
    class="absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-950/90 px-1 py-0.5 text-xs shadow"
  >
    <button
      type="button"
      class="btn-ghost px-1"
      title="Back (Alt+←, mouse back button)"
      aria-label="Back"
      :disabled="!canBack"
      @click="emit('navigate', 'back')"
    >
      <span class="i-mdi-arrow-left" />
    </button>
    <button
      type="button"
      class="btn-ghost px-1"
      title="Forward (Alt+→)"
      aria-label="Forward"
      :disabled="!canForward"
      @click="emit('navigate', 'forward')"
    >
      <span class="i-mdi-arrow-right" />
    </button>
    <button
      type="button"
      class="truncate rounded px-1.5 py-0.5 hover:bg-zinc-800"
      :class="focused !== undefined ? 'text-zinc-400' : 'text-zinc-100'"
      title="Show all functions"
      @click="emit('showAll')"
    >
      {{ path.split('/').at(-1) }}
    </button>
    <template v-if="focused !== undefined">
      <template v-for="parent in parents ?? []" :key="parent.id">
        <span class="i-mdi-chevron-right shrink-0 text-zinc-600" />
        <button
          type="button"
          class="truncate rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800"
          :title="`Show ${parent.name}`"
          @click="emit('open', parent.id)"
        >
          {{ parent.name }}
        </button>
      </template>
      <span class="i-mdi-chevron-right shrink-0 text-zinc-600" />
      <span class="truncate px-1.5 font-semibold text-zinc-100">{{
        focused
      }}</span>
      <button
        type="button"
        class="btn-ghost px-1"
        title="Show all functions"
        aria-label="Show all functions"
        @click="emit('showAll')"
      >
        <span class="i-mdi-close" />
      </button>
    </template>
  </div>
</template>
