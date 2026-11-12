<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  /** `col` resizes widths (vertical bar), `row` heights. */
  direction: 'col' | 'row';
  label: string;
}>();

const emit = defineEmits<{
  start: [];
  /** Pointer movement in px since the drag started. */
  move: [delta: number];
  end: [];
}>();

const active = ref(false);
let origin = 0;

function onPointerDown(event: PointerEvent): void {
  active.value = true;
  origin = props.direction === 'col' ? event.clientX : event.clientY;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  emit('start');
}

function onPointerMove(event: PointerEvent): void {
  if (active.value) {
    emit(
      'move',
      (props.direction === 'col' ? event.clientX : event.clientY) - origin
    );
  }
}

function onPointerUp(): void {
  if (active.value) {
    active.value = false;
    emit('end');
  }
}
</script>

<template>
  <div
    data-ui="sash"
    role="separator"
    :aria-label="label"
    :aria-orientation="direction === 'col' ? 'vertical' : 'horizontal'"
    class="relative z-10 shrink-0 bg-zinc-800 transition-colors hover:bg-amber-500/60"
    :class="[
      direction === 'col' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
      { 'bg-amber-500/60': active },
    ]"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  />
</template>
