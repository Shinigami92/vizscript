<script setup lang="ts">
import { onClickOutside, useStorage } from '@vueuse/core';
import { computed, ref, useTemplateRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToasts } from '../composables/use-toasts';
import { shareQuery, VIEW_PARAM } from '../graph/share';

const route = useRoute();
const router = useRouter();
const { show } = useToasts();

const open = ref(false);
/** Remembered choice: share the camera position and zoom with the link. */
const includeView = useStorage('vizscript:share-include-view', true);
const panel = useTemplateRef<HTMLDivElement>('panel');
onClickOutside(panel, () => (open.value = false), {
  ignore: ['.share-toggle'],
});

const hasView = computed(() => route.query[VIEW_PARAM] !== undefined);
const link = computed(() => {
  const href = router.resolve({
    path: route.path,
    query: shareQuery(route.query, includeView.value),
  }).href;
  return new URL(href, window.location.origin).toString();
});

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.value);
    show(
      includeView.value && hasView.value
        ? 'Link with the current view copied.'
        : 'Link copied.'
    );
    open.value = false;
  } catch {
    show('The clipboard is not available; copy the link by hand.', 'error');
  }
}
</script>

<template>
  <div data-ui="share-link" class="relative">
    <button
      type="button"
      class="btn-ghost share-toggle px-1.5 py-1"
      title="Share link"
      aria-label="Share link"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="i-mdi-share-variant-outline" />
    </button>
    <div
      v-if="open"
      ref="panel"
      role="dialog"
      aria-label="Share link"
      class="motion-pop absolute right-0 top-full z-40 mt-1 w-[min(24rem,calc(100vw-1rem))] rounded-lg border border-zinc-700 bg-zinc-900/98 p-3 text-sm shadow-2xl"
      @keydown.escape="open = false"
    >
      <label class="flex cursor-pointer items-start gap-2">
        <input
          v-model="includeView"
          type="checkbox"
          class="mt-0.5 accent-amber-500"
        />
        <span>
          <span class="text-zinc-100">Include current view</span>
          <span class="block text-xs text-zinc-500">
            Opens the graph at this position and zoom.
            <template v-if="!hasView"
              >(No view yet: pan or zoom the graph first.)</template
            >
          </span>
        </span>
      </label>
      <div class="mt-3 flex gap-2">
        <input
          :value="link"
          readonly
          aria-label="Link"
          class="input min-w-0 flex-1 py-1.5 font-mono text-xs"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <button type="button" class="btn-primary shrink-0" @click="copy">
          <span class="i-mdi-content-copy" /> Copy
        </button>
      </div>
    </div>
  </div>
</template>
