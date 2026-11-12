<script setup lang="ts">
import type { DataType, TypeOption, TypeSystemInfo } from '@vizscript/core';
import { pinColor } from '@vizscript/core';
import {
  onClickOutside,
  useElementBounding,
  useWindowSize,
} from '@vueuse/core';
import { computed, nextTick, ref, useTemplateRef } from 'vue';
import { useTheme } from '../composables/use-theme';

/**
 * UE's pin type picker for language types: basic types and the file's own
 * types, a container (single, array, map, set), optional, or any type typed
 * by hand. The backend checks the result.
 */
const props = defineProps<{
  /** Declared type, `null` when untyped. */
  value: string | null;
  /** Pin type of the current value (dot color, shown when untyped). */
  dataType: DataType;
  types: TypeSystemInfo;
  /** Types declared in the file (classes, interfaces, enums). */
  declared: ReadonlyArray<string>;
  editable: boolean;
  /** The language needs a type here: no "No type" choice. */
  required?: boolean;
}>();

const emit = defineEmits<{
  /** New type (`null`: no type) and the default value of a basic type. */
  change: [type: string | null, defaultValue: string | undefined];
}>();

type Container = 'single' | 'array' | 'map' | 'set';

const { scheme } = useTheme();
const open = ref(false);
const query = ref('');
const container = ref<Container>('single');
const optional = ref(false);
const custom = ref('');
const root = useTemplateRef<HTMLDivElement>('root');
const popover = useTemplateRef<HTMLDivElement>('popover');
const search = useTemplateRef<HTMLInputElement>('search');

onClickOutside(
  root,
  () => {
    open.value = false;
  },
  { ignore: [popover] }
);

// The popover floats over the page (a narrow panel would clip it).
const anchor = useElementBounding(root);
const viewport = useWindowSize();
const POPOVER_WIDTH = 256;
const popoverStyle = computed(() => {
  const width = Math.max(anchor.width.value, POPOVER_WIDTH);
  const left = Math.max(
    8,
    Math.min(anchor.left.value, viewport.width.value - width - 8)
  );
  const below = anchor.bottom.value + 4;
  const fitsBelow = below + 384 < viewport.height.value;
  return {
    left: `${left}px`,
    width: `${width}px`,
    ...(fitsBelow
      ? { top: `${below}px` }
      : { bottom: `${viewport.height.value - anchor.top.value + 4}px` }),
  };
});

const containers = computed(() =>
  (
    [
      ['single', 'Single'],
      ['array', 'Array'],
      ['map', 'Map'],
      ['set', 'Set'],
    ] as const
  ).filter(([id]) => id === 'single' || props.types[id] !== undefined)
);

/** Key type of maps: the language's string type. */
const mapKey = computed(
  () =>
    props.types.primitives.find((p) => p.dataType === 'string')?.name ??
    'string'
);

function matches(name: string): boolean {
  return name.toLowerCase().includes(query.value.trim().toLowerCase());
}

const basic = computed(() =>
  props.types.primitives.filter((p) => matches(p.name))
);
const own = computed(() => props.declared.filter((name) => matches(name)));

function compose(base: string): string {
  let type = base;
  if (container.value === 'map' && props.types.map) {
    type = props.types.map.replace('K', mapKey.value).replace('V', base);
  } else if (container.value !== 'single') {
    const template = props.types[container.value];
    type = template ? template.replace('T', base) : base;
  }

  return optional.value && props.types.optional
    ? props.types.optional.replace('T', type)
    : type;
}

/** Default value of a picked type: only for plain basic types. */
function defaultOf(option: TypeOption | undefined): string | undefined {
  if (optional.value) {
    return props.types.primitives.find((p) => p.dataType === 'any')
      ?.defaultValue;
  }

  return container.value === 'single'
    ? option?.defaultValue
    : props.types.containerDefaults?.[container.value];
}

function pick(base: string, option?: TypeOption): void {
  open.value = false;
  emit('change', compose(base), defaultOf(option));
}

function clear(): void {
  open.value = false;
  emit('change', null, undefined);
}

/**
 * Default value of a type typed by hand: like a picked one when it is a
 * basic type (`number`) or a container of anything (`Item[]`, `list[Item]`).
 */
function customDefault(type: string): string | undefined {
  const primitive = props.types.primitives.find((p) => p.name === type);
  if (primitive) {
    return primitive.defaultValue;
  }

  for (const kind of ['array', 'set'] as const) {
    const template = props.types[kind];
    const at = template?.lastIndexOf('T') ?? -1;
    if (!template || at < 0) {
      continue;
    }

    const before = template.slice(0, at);
    const after = template.slice(at + 1);
    if (
      type.length > before.length + after.length &&
      type.startsWith(before) &&
      type.endsWith(after)
    ) {
      return props.types.containerDefaults?.[kind];
    }
  }

  return undefined;
}

function applyCustom(): void {
  const type = custom.value.trim();
  if (type) {
    open.value = false;
    emit('change', type, customDefault(type));
  }
}

async function toggle(): Promise<void> {
  if (!props.editable) {
    return;
  }

  open.value = !open.value;
  if (open.value) {
    query.value = '';
    custom.value = props.value ?? '';
    await nextTick();
    search.value?.focus();
  }
}

function color(dataType: DataType): string {
  return pinColor(dataType, scheme.value);
}
</script>

<template>
  <div ref="root" data-ui="type-picker" class="relative min-w-0">
    <button
      type="button"
      class="flex w-full min-w-0 items-center gap-1.5 rounded border border-transparent px-1.5 py-0.5 text-left font-mono"
      :class="
        editable
          ? 'hover:border-zinc-700 hover:bg-zinc-900 focus-visible:border-amber-500 focus-visible:outline-none'
          : 'cursor-default'
      "
      :aria-expanded="open"
      aria-haspopup="dialog"
      :title="editable ? 'Change the type' : undefined"
      @click="toggle"
    >
      <span
        class="size-2 shrink-0 rounded-full"
        :style="{ background: color(dataType) }"
      />
      <span
        class="min-w-0 truncate"
        :class="value ? 'text-zinc-200' : 'text-zinc-500 italic'"
        >{{ value ?? String(dataType) }}</span
      >
      <span v-if="!value" class="shrink-0 font-sans text-zinc-600"
        >(inferred)</span
      >
      <span
        v-if="editable"
        class="i-mdi-chevron-down ml-auto shrink-0 text-zinc-500"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="popover"
        data-ui="type-picker-popover"
        role="dialog"
        aria-label="Type"
        class="motion-pop fixed z-50 flex max-h-96 flex-col rounded-lg border border-zinc-700 bg-zinc-900 text-xs shadow-2xl"
        :style="popoverStyle"
        @keydown.esc.stop="open = false"
      >
        <div class="space-y-1.5 border-b border-zinc-800 p-2">
          <input
            ref="search"
            v-model="query"
            type="search"
            class="input py-1 text-xs"
            placeholder="Search types"
            aria-label="Search types"
          />
          <div
            class="flex items-center gap-1"
            role="group"
            aria-label="Container"
          >
            <button
              v-for="[id, label] in containers"
              :key="id"
              type="button"
              class="rounded px-1.5 py-0.5"
              :class="
                container === id
                  ? 'bg-zinc-700 text-zinc-50'
                  : 'text-zinc-400 hover:text-zinc-200'
              "
              :aria-pressed="container === id"
              @click="container = id"
            >
              {{ label }}
            </button>
            <label
              v-if="types.optional"
              class="ml-auto flex cursor-pointer items-center gap-1 text-zinc-400"
            >
              <input
                v-model="optional"
                type="checkbox"
                class="accent-amber-500"
              />
              Optional
            </label>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto py-1">
          <button v-if="!required" type="button" class="option" @click="clear">
            <span class="size-2 shrink-0 rounded-full bg-zinc-600" />
            <span class="text-zinc-400 italic">No type (inferred)</span>
          </button>
          <p v-if="basic.length > 0" class="group-title">Basic</p>
          <button
            v-for="option in basic"
            :key="option.name"
            type="button"
            class="option"
            @click="pick(option.name, option)"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :style="{ background: color(option.dataType) }"
            />
            <span class="font-mono">{{ compose(option.name) }}</span>
          </button>
          <template v-if="own.length > 0">
            <p class="group-title">In this file</p>
            <button
              v-for="name in own"
              :key="name"
              type="button"
              class="option"
              @click="pick(name)"
            >
              <span
                class="size-2 shrink-0 rounded-full"
                :style="{ background: color(name) }"
              />
              <span class="font-mono">{{ compose(name) }}</span>
            </button>
          </template>
        </div>

        <form
          class="flex gap-1 border-t border-zinc-800 p-2"
          @submit.prevent="applyCustom"
        >
          <input
            v-model="custom"
            class="input py-1 font-mono text-xs"
            placeholder="Any type, as written in code"
            aria-label="Custom type"
            spellcheck="false"
          />
          <button type="submit" class="btn-ghost shrink-0 px-2 text-xs">
            Set
          </button>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.group-title {
  @apply px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500;
}

.option {
  @apply flex w-full items-center gap-2 px-3 py-1 text-left text-zinc-200 hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none;
}
</style>
