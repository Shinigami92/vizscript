<script setup lang="ts">
import { computed, ref, watch } from 'vue';

/**
 * A number like UE's spin box: drag left / right on it to change the value
 * (Shift: ×10, Alt: ×0.1), click to type, ↑ / ↓ step (written on Enter or
 * blur). The step follows the
 * value's decimals (`0.19` steps by `0.01`). Emits the new value as text.
 */
const props = defineProps<{
  value: string;
  editable: boolean;
  label: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  commit: [value: string];
}>();

const draft = ref(props.value);
watch(
  () => props.value,
  (value) => {
    draft.value = value;
  }
);

const input = ref<HTMLInputElement | null>(null);
const focused = ref(false);
const scrubbing = ref(false);

/** Digits after the point (`1_000.25` → 2). */
function decimals(text: string): number {
  const match = text.replaceAll('_', '').match(/\.(\d+)/);
  return match?.[1]?.length ?? 0;
}

const places = computed(() => decimals(props.value));
const step = computed(() => 10 ** -places.value);

function parse(text: string): number | undefined {
  const value = Number(text.replaceAll('_', '').trim());
  return text.trim() === '' || Number.isNaN(value) ? undefined : value;
}

function format(value: number, digits: number): string {
  return value.toFixed(Math.min(Math.max(digits, 0), 10));
}

function factor(event: { shiftKey: boolean; altKey: boolean }): number {
  return event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
}

/** Digits for a step: more when Alt makes it finer than the value has. */
function digitsFor(change: number): number {
  const fine = Math.max(0, Math.ceil(-Math.log10(Math.abs(change) || 1)));
  return Math.max(places.value, fine);
}

function commit(): void {
  const next = draft.value.trim();
  if (next !== props.value.trim()) {
    emit('commit', next);
  }
}

function nudge(direction: 1 | -1, event: KeyboardEvent): void {
  const current = parse(draft.value);
  if (current === undefined) {
    return;
  }

  // Written on Enter or blur, like typing: a write would re-render the
  // field and take its focus away.
  const change = direction * step.value * factor(event);
  draft.value = format(current + change, digitsFor(change));
}

// ------------------------------------------------------------- scrubbing

let start: { x: number; value: number; pointer: number } | undefined;

function onPointerDown(event: PointerEvent): void {
  if (!props.editable || focused.value || event.button !== 0) {
    return;
  }

  const value = parse(draft.value);
  if (value === undefined) {
    return;
  }

  // Not focused yet: a drag scrubs, a click types (on pointer up).
  event.preventDefault();
  start = { x: event.clientX, value, pointer: event.pointerId };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!start) {
    return;
  }

  const dx = event.clientX - start.x;
  if (!scrubbing.value && Math.abs(dx) < 3) {
    return;
  }

  scrubbing.value = true;
  const change = Math.round(dx / 4) * step.value * factor(event);
  draft.value = format(
    start.value + change,
    digitsFor(step.value * factor(event))
  );
}

function onPointerUp(event: PointerEvent): void {
  if (!start) {
    return;
  }

  (event.currentTarget as HTMLElement).releasePointerCapture(start.pointer);
  start = undefined;
  if (scrubbing.value) {
    scrubbing.value = false;
    commit();
    return;
  }

  input.value?.focus();
  input.value?.select();
}
</script>

<template>
  <input
    ref="input"
    v-model="draft"
    class="input py-0.5 font-mono text-xs"
    :class="{
      'cursor-ew-resize': editable && !focused,
      'select-none': scrubbing,
    }"
    type="text"
    inputmode="decimal"
    :readonly="!editable"
    :placeholder="placeholder"
    :aria-label="label"
    :title="editable ? 'Drag to change, click to type' : undefined"
    spellcheck="false"
    @focus="focused = true"
    @blur="
      focused = false;
      commit();
    "
    @keydown.enter.prevent="input?.blur()"
    @keydown.up.prevent="nudge(1, $event)"
    @keydown.down.prevent="nudge(-1, $event)"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  />
</template>
