<script setup lang="ts">
import type { GraphView } from '@vizscript/canvas';
import { MAX_ZOOM, MIN_ZOOM } from '@vizscript/canvas';

defineProps<{
  view: GraphView | undefined;
  /** Zoom of the camera. */
  zoom: number;
}>();

const ZOOM_STEP = 1.25;
</script>

<template>
  <!-- Zoom controls: they only change the view of the graph. -->
  <div
    class="absolute right-3 bottom-3 z-10 flex items-center rounded-md border border-zinc-800 bg-zinc-900/90 text-zinc-300 shadow-lg backdrop-blur"
    data-ui="zoom-controls"
    role="group"
    aria-label="Zoom"
  >
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-l-md hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
      title="Zoom out"
      aria-label="Zoom out"
      :disabled="zoom <= MIN_ZOOM + 1e-3"
      @click="view?.zoomBy(1 / ZOOM_STEP)"
    >
      <span class="i-mdi-minus" />
    </button>
    <button
      type="button"
      class="h-7 min-w-12 px-1 text-xs tabular-nums hover:bg-zinc-800 hover:text-zinc-100"
      title="Reset zoom to 100%"
      aria-label="Reset zoom to 100%"
      @click="view?.setZoom(1)"
    >
      {{ Math.round(zoom * 100) }}%
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
      title="Zoom in"
      aria-label="Zoom in"
      :disabled="zoom >= MAX_ZOOM - 1e-3"
      @click="view?.zoomBy(ZOOM_STEP)"
    >
      <span class="i-mdi-plus" />
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-r-md border-l border-zinc-800 hover:bg-zinc-800 hover:text-zinc-100"
      title="Zoom to fit all nodes (Home)"
      aria-label="Zoom to fit all nodes"
      @click="view?.frameAll()"
    >
      <span class="i-mdi-fit-to-page-outline" />
    </button>
  </div>
</template>
