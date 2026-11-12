<script setup lang="ts">
import { useToasts } from '../composables/use-toasts';

const { toasts, dismiss } = useToasts();
</script>

<template>
  <div
    data-ui="toasts"
    class="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
  >
    <button
      v-for="toast in toasts"
      :key="toast.id"
      type="button"
      class="pointer-events-auto max-w-sm rounded-lg border px-4 py-2 text-left text-sm shadow-lg"
      :class="
        toast.kind === 'error'
          ? 'border-red-800 bg-red-950/95 text-red-100'
          : 'border-zinc-700 bg-zinc-900/95 text-zinc-100'
      "
      @click="dismiss(toast.id)"
    >
      {{ toast.message }}
    </button>
  </div>
</template>
