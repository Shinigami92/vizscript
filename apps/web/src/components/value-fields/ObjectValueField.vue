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
import PinType from '../PinType.vue';
import ArrayValueField from './ArrayValueField.vue';
import EntryKey from './EntryKey.vue';
import PinValueField from './PinValueField.vue';

/**
 * An object or dictionary value like UE's Details of a struct or map:
 * "N entries" with ⊕ and 🗑, folded open into `key | value | type` rows
 * with a ▼ menu (Rename, Delete). Values fold open again when they are
 * arrays or objects themselves.
 */
// Nested objects render this component again, by its name.
defineOptions({ name: 'ObjectValueField' });

const props = defineProps<{
  doc: GraphDocument;
  text: string;
  /** The literal's Make Object node. */
  node: GraphNode;
  editable: boolean;
  types: TypeSystemInfo | null;
  /** 🗑 empties the whole value (the variable's own object). */
  clearable?: boolean;
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
  clear: [];
}>();

const entries = computed(() => objectEntries(props.node) ?? []);
const open = ref(false);

/**
 * The array or object an entry holds: its rows go across the full width
 * below its key, like UE's nested struct rows.
 */
function containerOf(
  pin: Pin
): { node: GraphNode; isArray: boolean } | undefined {
  const source = inputSource(props.doc, props.node, pin);
  if (source && arrayElements(source)) {
    return { node: source, isArray: true };
  }

  return source && objectEntries(source)
    ? { node: source, isArray: false }
    : undefined;
}

// ---------------------------------------------------------- add / rename

/** The new entry whose key is typed, or the entry being renamed. */
const adding = ref(false);
const renaming = ref<string | null>(null);

function startAdd(): void {
  open.value = true;
  renaming.value = null;
  adding.value = true;
}

function startRename(pin: Pin): void {
  adding.value = false;
  renaming.value = pin.id;
}

function commitKey(pin: Pin | null, key: string): void {
  adding.value = false;
  renaming.value = null;
  if (key === '' || key === pin?.name) {
    return;
  }

  emit(
    'op',
    pin
      ? { type: 'renameEntry', pin: { node: props.node.id, pin: pin.id }, key }
      : { type: 'addArgument', node: props.node.id, name: key }
  );
}

function cancelKey(): void {
  adding.value = false;
  renaming.value = null;
}

// ------------------------------------------------------------------ menu

const menu = ref<{ x: number; y: number; pin: Pin } | null>(null);

function openMenu(event: MouseEvent, pin: Pin): void {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { x: box.left, y: box.bottom + 2, pin };
}

const menuEntries = computed<MenuEntry[]>(() => {
  const pin = menu.value?.pin;
  return pin
    ? [
        {
          label: 'Rename',
          icon: 'i-mdi-rename-outline',
          action: () => startRename(pin),
        },
        {
          label: 'Delete',
          icon: 'i-mdi-delete-outline',
          danger: true,
          action: () =>
            emit('op', {
              type: 'removeArgument',
              pin: { node: props.node.id, pin: pin.id },
            }),
        },
      ]
    : [];
});
</script>

<template>
  <div class="min-w-0 flex-1" data-ui="object-value">
    <div class="flex items-center gap-1">
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
          >{{ entries.length }} entr{{
            entries.length === 1 ? 'y' : 'ies'
          }}</span
        >
      </button>
      <template v-if="editable">
        <button
          type="button"
          class="btn-ghost ml-auto shrink-0 px-0.5"
          title="Add an entry"
          aria-label="Add an entry"
          @click="startAdd"
        >
          <span class="i-mdi-plus-circle-outline" />
        </button>
        <button
          v-if="clearable && entries.length > 0"
          type="button"
          class="btn-ghost shrink-0 px-0.5"
          title="Remove all entries"
          aria-label="Remove all entries"
          @click="emit('clear')"
        >
          <span class="i-mdi-delete-outline" />
        </button>
      </template>
      <slot name="actions" />
    </div>

    <dl
      v-if="open && (entries.length > 0 || adding)"
      class="mt-0.5 grid items-center gap-x-1 gap-y-0.5 border-l border-zinc-800 pl-1.5"
      :class="
        editable
          ? 'grid-cols-[4.5rem_minmax(0,1fr)_auto_auto]'
          : 'grid-cols-[4.5rem_minmax(0,1fr)_auto]'
      "
    >
      <template v-for="entry in entries" :key="entry.id">
        <template v-for="nested in [containerOf(entry)]" :key="entry.id">
          <div v-if="nested" class="col-span-full min-w-0">
            <component
              :is="nested.isArray ? ArrayValueField : 'ObjectValueField'"
              :doc="doc"
              :text="text"
              :node="nested.node"
              :editable="editable"
              :types="types"
              @op="emit('op', $event)"
            >
              <template #label>
                <div class="w-[4.5rem] shrink-0" data-ui="object-entry">
                  <EntryKey
                    :name="entry.name"
                    :editing="renaming === entry.id"
                    :editable="editable"
                    :label="`New key of ${entry.name}`"
                    @start="startRename(entry)"
                    @commit="(key) => commitKey(entry, key)"
                    @cancel="cancelKey"
                  />
                </div>
              </template>
              <template #actions>
                <PinType :pin="entry" />
                <button
                  v-if="editable"
                  type="button"
                  class="btn-ghost flex w-4 shrink-0 justify-center px-0"
                  :title="`Actions of ${entry.name}`"
                  :aria-label="`Actions of ${entry.name}`"
                  data-ui="object-entry-menu"
                  @click="openMenu($event, entry)"
                >
                  <span class="i-mdi-menu-down block" />
                </button>
              </template>
            </component>
          </div>
          <template v-else>
            <dt class="min-w-0" data-ui="object-entry">
              <EntryKey
                :name="entry.name"
                :editing="renaming === entry.id"
                :editable="editable"
                :label="`New key of ${entry.name}`"
                @start="startRename(entry)"
                @commit="(key) => commitKey(entry, key)"
                @cancel="cancelKey"
              />
            </dt>
            <dd class="min-w-0">
              <PinValueField
                :doc="doc"
                :text="text"
                :node="node"
                :pin="entry"
                :editable="editable"
                :types="types"
                :label="`Value of ${entry.name}`"
                @op="emit('op', $event)"
              />
            </dd>
            <PinType :pin="entry" />
            <button
              v-if="editable"
              type="button"
              class="btn-ghost flex w-4 shrink-0 justify-center px-0"
              :title="`Actions of ${entry.name}`"
              :aria-label="`Actions of ${entry.name}`"
              data-ui="object-entry-menu"
              @click="openMenu($event, entry)"
            >
              <span class="i-mdi-menu-down block" />
            </button>
          </template>
        </template>
      </template>
      <template v-if="adding">
        <dt class="min-w-0">
          <EntryKey
            name=""
            editing
            :editable="editable"
            label="Key of the new entry"
            @commit="(key) => commitKey(null, key)"
            @cancel="cancelKey"
          />
        </dt>
        <dd class="col-span-3 truncate text-[11px] text-zinc-500">
          Enter adds the entry
        </dd>
      </template>
    </dl>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :entries="menuEntries"
      label="Entry actions"
      :ignore="['[data-ui=object-entry-menu]']"
      @close="menu = null"
    />
  </div>
</template>
