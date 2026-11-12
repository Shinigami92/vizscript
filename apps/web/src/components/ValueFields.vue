<script setup lang="ts">
import type { FieldValue } from '@vizscript/core';
import { colorCode, rgbaToHex, vectorCode } from '@vizscript/core';
import { computed } from 'vue';

/**
 * Value widgets like UE's: a field per vector component (X red, Y green,
 * Z blue), a color picker with alpha, and enum members to pick.
 */
const props = defineProps<{
  value: FieldValue;
  editable: boolean;
  label: string;
}>();

const emit = defineEmits<{
  /** New code of the value. */
  set: [code: string];
}>();

const AXIS_COLORS: Record<string, string> = {
  x: 'var(--colors-red-500)',
  y: 'var(--colors-green-500, #22c55e)',
  z: 'var(--colors-sky-500)',
  w: 'var(--colors-zinc-500)',
};

function setComponent(index: number, input: string): void {
  if (props.value.type !== 'vector') {
    return;
  }

  const values = [...props.value.values];
  values[index] = input;
  const code = vectorCode(props.value.name, values);
  if (code !== vectorCode(props.value.name, props.value.values)) {
    emit('set', code);
  }
}

const hex = computed(() =>
  props.value.type === 'color' ? rgbaToHex(props.value.rgba, false) : ''
);

function setColor(input: string): void {
  if (props.value.type !== 'color') {
    return;
  }

  const digits = input.replace('#', '');
  const part = (i: number): number =>
    Number.parseInt(digits.slice(i, i + 2), 16) / 255;
  const { name, rgba, html, hasAlpha } = props.value;
  emit(
    'set',
    colorCode(name, [part(0), part(2), part(4), rgba[3]], html, hasAlpha)
  );
}

function setAlpha(input: string): void {
  if (props.value.type !== 'color') {
    return;
  }

  const alpha = Math.min(1, Math.max(0, Number(input)));
  if (Number.isNaN(alpha)) {
    return;
  }

  const { name, rgba, html } = props.value;
  emit('set', colorCode(name, [rgba[0], rgba[1], rgba[2], alpha], html, true));
}

const known = computed(
  () =>
    props.value.type === 'enum' &&
    props.value.choices.some(
      (c) => props.value.type === 'enum' && c.code === props.value.current
    )
);
</script>

<template>
  <div data-ui="value-fields" class="flex min-w-0 flex-1 items-center gap-1">
    <template v-if="value.type === 'vector'">
      <label
        v-for="(field, index) in value.fields"
        :key="field"
        class="flex min-w-0 flex-1 items-center rounded border-l-2 bg-zinc-900"
        :style="{ borderLeftColor: AXIS_COLORS[field] }"
      >
        <span class="sr-only">{{ field }}</span>
        <input
          :key="`${field}:${value.values[index]}`"
          class="input min-w-0 rounded-l-none py-0.5 font-mono text-xs"
          :value="value.values[index]"
          :placeholder="field"
          :readonly="!editable"
          :aria-label="`${label} ${field}`"
          :title="field"
          inputmode="decimal"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @change="
            setComponent(index, ($event.target as HTMLInputElement).value)
          "
        />
      </label>
    </template>

    <template v-else-if="value.type === 'color'">
      <input
        type="color"
        class="h-6 w-8 shrink-0 cursor-pointer rounded border border-zinc-700 bg-transparent"
        :value="hex"
        :disabled="!editable"
        :aria-label="`${label} color`"
        @change="setColor(($event.target as HTMLInputElement).value)"
      />
      <span class="truncate font-mono text-[11px] text-zinc-400">{{
        hex
      }}</span>
      <label class="ml-auto flex items-center gap-1 text-zinc-500">
        A
        <input
          :key="value.rgba[3]"
          class="input w-14 py-0.5 font-mono text-xs"
          :value="Math.round(value.rgba[3] * 100) / 100"
          :readonly="!editable"
          :aria-label="`${label} alpha`"
          inputmode="decimal"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @change="setAlpha(($event.target as HTMLInputElement).value)"
        />
      </label>
    </template>

    <template v-else-if="value.type === 'enum'">
      <!-- Few members: buttons, like UE's Mobility; more: a dropdown. -->
      <div
        v-if="value.choices.length <= 4"
        class="flex flex-wrap gap-1"
        role="radiogroup"
        :aria-label="label"
      >
        <button
          v-for="choice in value.choices"
          :key="choice.code"
          type="button"
          role="radio"
          class="rounded px-2 py-0.5 font-mono"
          :class="
            choice.code === value.current
              ? 'bg-zinc-700 text-zinc-50'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          "
          :aria-checked="choice.code === value.current"
          :disabled="!editable"
          @click="choice.code !== value.current && emit('set', choice.code)"
        >
          {{ choice.label }}
        </button>
      </div>
      <select
        v-else
        class="input py-0.5 font-mono text-xs"
        :value="value.current"
        :disabled="!editable"
        :aria-label="label"
        @change="emit('set', ($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!known" :value="value.current">
          {{ value.current || '—' }}
        </option>
        <option
          v-for="choice in value.choices"
          :key="choice.code"
          :value="choice.code"
        >
          {{ choice.label }}
        </option>
      </select>
    </template>
  </div>
</template>
