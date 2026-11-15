<script setup lang="ts">
import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  Pin,
  TypeSystemInfo,
} from '@vizscript/core';
import { arrayElements, inputSource, objectEntries } from '@vizscript/core';
import { computed, ref } from 'vue';
import type { MenuEntry } from '../ContextMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import PinValueField from './PinValueField.vue';

/**
 * An array value like UE's Details: "N elements" with ⊕ and 🗑, folded
 * open into `[0]`, `[1]` … with a field each (objects fold out into their
 * entries), a ▼ menu (Insert, Duplicate, Delete) and a grip to reorder.
 */
const props = defineProps<{
  doc: GraphDocument;
  text: string;
  /** The array literal's Make Array node. */
  node: GraphNode;
  editable: boolean;
  types: TypeSystemInfo | null;
  /** 🗑 empties the whole value (the variable's own array). */
  clearable?: boolean;
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
  clear: [];
}>();

const elements = computed(() => arrayElements(props.node) ?? []);
const open = ref(false);
const openItems = ref(new Set<number>());

function toggleItem(index: number): void {
  const next = new Set(openItems.value);
  if (!next.delete(index)) {
    next.add(index);
  }

  openItems.value = next;
}

/** The Make Object an element is, with its entries. */
function objectOf(
  pin: Pin
): { node: GraphNode; entries: ReadonlyArray<Pin> } | undefined {
  const source = inputSource(props.doc, props.node, pin);
  const entries = source ? objectEntries(source) : undefined;
  return source && entries ? { node: source, entries } : undefined;
}

/** A struct's summary, like UE: its first text, else its entry count. */
function summary(entries: ReadonlyArray<Pin>): string {
  const named = entries.find((e) => e.literal?.kind === 'string');
  return named?.literal
    ? named.literal.value
    : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
}

function add(): void {
  open.value = true;
  emit('op', { type: 'addArgument', node: props.node.id });
}

// ------------------------------------------------------------------ menu

const menu = ref<{ x: number; y: number; index: number } | null>(null);

function openMenu(event: MouseEvent, index: number): void {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { x: box.left, y: box.bottom + 2, index };
}

const menuEntries = computed<MenuEntry[]>(() => {
  const index = menu.value?.index ?? 0;
  const pin = elements.value[index];
  return [
    {
      label: 'Insert',
      icon: 'i-mdi-table-row-plus-before',
      action: () =>
        emit('op', { type: 'insertElement', node: props.node.id, index }),
    },
    {
      label: 'Duplicate',
      icon: 'i-mdi-content-copy',
      action: () =>
        emit('op', {
          type: 'insertElement',
          node: props.node.id,
          index,
          copy: true,
        }),
    },
    {
      label: 'Delete',
      icon: 'i-mdi-delete-outline',
      danger: true,
      action: () =>
        pin &&
        emit('op', {
          type: 'removeArgument',
          pin: { node: props.node.id, pin: pin.id },
        }),
    },
  ];
});

// ------------------------------------------------------------- reorder

const dragging = ref<number | null>(null);
const over = ref<number | null>(null);

function drop(index: number): void {
  const from = dragging.value;
  dragging.value = null;
  over.value = null;
  if (from !== null && from !== index) {
    emit('op', { type: 'moveElement', node: props.node.id, from, to: index });
  }
}
</script>

<template>
  <div class="min-w-0 flex-1" data-ui="array-value">
    <div class="flex items-center gap-1">
      <!-- The variable's name, so the elements below get the full width. -->
      <slot name="label" />
      <button
        type="button"
        class="btn-ghost flex min-w-0 items-center gap-1 px-1 py-0.5 text-zinc-300"
        :aria-expanded="open"
        @click="open = !open"
      >
        <span
          class="motion-rotate i-mdi-chevron-down block shrink-0"
          :class="{ '-rotate-90': !open }"
        />
        <span class="truncate"
          >{{ elements.length }} element{{
            elements.length === 1 ? '' : 's'
          }}</span
        >
      </button>
      <template v-if="editable">
        <button
          type="button"
          class="btn-ghost ml-auto shrink-0 px-1"
          title="Add an element"
          aria-label="Add an element"
          @click="add"
        >
          <span class="i-mdi-plus-circle-outline" />
        </button>
        <button
          v-if="clearable && elements.length > 0"
          type="button"
          class="btn-ghost shrink-0 px-1"
          title="Remove all elements"
          aria-label="Remove all elements"
          @click="emit('clear')"
        >
          <span class="i-mdi-delete-outline" />
        </button>
      </template>
      <slot name="actions" />
    </div>

    <ol
      v-if="open && elements.length > 0"
      class="mt-0.5 space-y-0.5 border-l border-zinc-800 pl-1.5"
    >
      <li
        v-for="(pin, index) in elements"
        :key="pin.id"
        data-ui="array-element"
        class="rounded"
        :class="{ 'bg-amber-500/10': over === index && dragging !== index }"
        @dragover.prevent="over = index"
        @dragleave="over === index && (over = null)"
        @drop.prevent="drop(index)"
      >
        <div class="group flex min-w-0 items-center gap-1">
          <span
            v-if="editable"
            class="i-mdi-drag shrink-0 cursor-grab text-zinc-600 opacity-0 group-hover:opacity-100"
            draggable="true"
            title="Drag to reorder"
            @dragstart="dragging = index"
            @dragend="dragging = null"
          />
          <template v-for="object in [objectOf(pin)]" :key="pin.id">
            <button
              v-if="object"
              type="button"
              class="btn-ghost flex min-w-0 flex-1 items-center gap-1 px-0.5 py-0.5 text-left"
              :aria-expanded="openItems.has(index)"
              @click="toggleItem(index)"
            >
              <span
                class="motion-rotate i-mdi-chevron-down block shrink-0"
                :class="{ '-rotate-90': !openItems.has(index) }"
              />
              <span class="shrink-0 font-mono text-zinc-500"
                >[{{ index }}]</span
              >
              <span class="truncate text-zinc-300">{{
                summary(object.entries)
              }}</span>
            </button>
            <template v-else>
              <span class="shrink-0 font-mono text-zinc-500"
                >[{{ index }}]</span
              >
              <div class="min-w-0 flex-1">
                <PinValueField
                  :doc="doc"
                  :text="text"
                  :node="node"
                  :pin="pin"
                  :editable="editable"
                  :types="types"
                  :label="`Element ${index}`"
                  @op="emit('op', $event)"
                />
              </div>
            </template>
          </template>
          <button
            v-if="editable"
            type="button"
            class="btn-ghost shrink-0 px-0.5"
            :title="`Actions of element ${index}`"
            :aria-label="`Actions of element ${index}`"
            data-ui="array-element-menu"
            @click="openMenu($event, index)"
          >
            <span class="i-mdi-menu-down block" />
          </button>
        </div>
        <template v-for="object in [objectOf(pin)]" :key="`${pin.id}:entries`">
          <dl
            v-if="object && openItems.has(index)"
            class="mb-1 ml-4 grid grid-cols-[4.5rem_1fr] items-center gap-x-1.5 gap-y-0.5 border-l border-zinc-800 pl-1.5"
          >
            <template v-for="entry in object.entries" :key="entry.id">
              <dt class="truncate font-mono text-zinc-500" :title="entry.name">
                {{ entry.name }}
              </dt>
              <dd class="min-w-0">
                <PinValueField
                  :doc="doc"
                  :text="text"
                  :node="object.node"
                  :pin="entry"
                  :editable="editable"
                  :types="types"
                  :label="`${entry.name} of element ${index}`"
                  @op="emit('op', $event)"
                />
              </dd>
            </template>
          </dl>
        </template>
      </li>
    </ol>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :entries="menuEntries"
      label="Array element actions"
      :ignore="['[data-ui=array-element-menu]']"
      @close="menu = null"
    />
  </div>
</template>
