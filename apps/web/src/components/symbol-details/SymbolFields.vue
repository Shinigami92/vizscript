<script setup lang="ts">
import type { GraphOp, ScriptSymbol, TypeSystemInfo } from '@vizscript/core';
import { holdsFields, qualifiedName, typeParamName } from '@vizscript/core';
import { computed, nextTick, ref } from 'vue';
import { usesSnakeCase } from '../../graph/languages';
import DetailsSection from '../DetailsSection.vue';
import TypePicker from '../TypePicker.vue';

/**
 * Fields of an interface or object type, like the members of UE's struct
 * editor: name, type and remove; `readonly` folds out.
 */
const props = defineProps<{
  symbol: ScriptSymbol;
  /** All symbols of the file: the fields are members of `symbol`. */
  symbols: ReadonlyArray<ScriptSymbol>;
  editable: boolean;
  types: TypeSystemInfo | null;
  /** Types declared in the file, for the type picker. */
  declared: ReadonlyArray<string>;
  language: string;
}>();

/** The type's type parameters, offered by the type pickers. */
const typeParams = computed(() =>
  (props.symbol.typeParams ?? []).map(typeParamName)
);
const emit = defineEmits<{
  op: [op: GraphOp];
}>();

const owner = computed(() => qualifiedName(props.symbol));
const fields = computed(() =>
  props.symbols.filter((s) => s.kind === 'variable' && s.scope === owner.value)
);
/** The type system (empty while it loads). */
const typeInfo = computed<TypeSystemInfo>(
  () => props.types ?? { primitives: [], modifiers: {} }
);
const flags = computed(() => typeInfo.value.modifiers.field?.flags ?? []);

const expanded = ref(new Set<string>());

function toggle(name: string): void {
  const next = new Set(expanded.value);
  if (!next.delete(name)) {
    next.add(name);
  }

  expanded.value = next;
}

/**
 * "+ Field": a row for the new field's name first; the field is written
 * once it is named (one undo step), like a new input.
 */
const newField = ref<string | null>(null);

async function addField(): Promise<void> {
  const taken = new Set(fields.value.map((f) => f.name));
  const base = usesSnakeCase(props.language) ? 'new_field' : 'newField';
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    name = `${base}${i}`;
  }

  newField.value = name;
  await nextTick();
  const input = document.querySelector<HTMLInputElement>(
    '[data-ui="field-new"]'
  );
  input?.focus();
  input?.select();
}

function commitField(event: Event): void {
  if (newField.value === null) {
    return;
  }

  const name = (event.target as HTMLInputElement).value.trim();
  newField.value = null;
  if (name !== '') {
    emit('op', { type: 'addVariable', scope: owner.value, name });
  }
}

function rename(field: ScriptSymbol, event: Event): void {
  const name = (event.target as HTMLInputElement).value.trim();
  if (name && name !== field.name) {
    emit('op', { type: 'renameSymbol', symbol: field.id, name });
  }
}

function setType(field: ScriptSymbol, typeText: string | null): void {
  emit('op', { type: 'setSymbolType', symbol: field.id, typeText });
}

function setFlag(field: ScriptSymbol, modifier: string, event: Event): void {
  emit('op', {
    type: 'setModifier',
    symbol: field.id,
    modifier,
    enabled: (event.target as HTMLInputElement).checked,
  });
}

function remove(field: ScriptSymbol): void {
  emit('op', { type: 'deleteSymbol', symbol: field.id });
}
</script>

<template>
  <DetailsSection v-if="holdsFields(symbol)" id="symbol-fields" title="Fields">
    <template #actions>
      <button
        v-if="editable && types"
        type="button"
        class="btn-ghost mb-1 px-1.5 py-0.5 text-xs"
        title="Add a field"
        @click="addField"
      >
        <span class="i-mdi-plus" /> Field
      </button>
    </template>
    <p v-if="fields.length === 0" class="px-3 text-xs text-zinc-500">
      No fields.
    </p>
    <div
      v-for="field in fields"
      :key="field.id"
      data-ui="field-row"
      class="text-xs"
    >
      <div class="flex items-center gap-1 px-1.5 py-0.5">
        <button
          type="button"
          class="btn-ghost shrink-0 px-0.5"
          :class="{ invisible: flags.length === 0 }"
          :aria-expanded="expanded.has(field.name)"
          :aria-label="`Details of ${field.name}`"
          :title="expanded.has(field.name) ? 'Hide details' : 'Show details'"
          @click="toggle(field.name)"
        >
          <span
            class="motion-rotate i-mdi-chevron-down block"
            :class="{ '-rotate-90': !expanded.has(field.name) }"
          />
        </button>
        <input
          class="input min-w-0 flex-1 py-0.5 font-mono text-xs"
          :value="field.name"
          :readonly="!editable"
          data-ui="field-name"
          :data-name="field.name"
          :aria-label="`Name of field ${field.name}`"
          spellcheck="false"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          @change="rename(field, $event)"
        />
        <TypePicker
          class="w-32 shrink-0"
          :value="field.type?.text ?? null"
          :data-type="field.dataType"
          :types="typeInfo"
          :declared="declared"
          :type-params="typeParams"
          :editable="editable"
          :required="typeInfo.requiredType !== undefined"
          @change="(typeText) => setType(field, typeText)"
        />
        <button
          v-if="editable"
          type="button"
          class="btn-ghost shrink-0 px-1 text-red-300"
          title="Remove this field"
          :aria-label="`Remove ${field.name}`"
          @click="remove(field)"
        >
          <span class="i-mdi-close" />
        </button>
      </div>
      <dl
        v-if="expanded.has(field.name)"
        class="mb-1 ml-5 mr-2 grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1 border-l border-zinc-800 py-1 pl-2"
      >
        <dt class="text-zinc-500">Modifiers</dt>
        <dd class="flex flex-wrap gap-x-3">
          <label
            v-for="flag in flags"
            :key="flag"
            class="flex cursor-pointer items-center gap-1 font-mono text-zinc-300"
          >
            <input
              type="checkbox"
              class="accent-amber-500"
              :checked="field.modifiers.includes(flag)"
              :disabled="!editable"
              @change="setFlag(field, flag, $event)"
            />
            {{ flag }}
          </label>
        </dd>
      </dl>
    </div>
    <div
      v-if="newField !== null"
      class="flex items-center gap-1 px-1.5 py-0.5 text-xs"
    >
      <span class="i-mdi-plus shrink-0 px-0.5 text-zinc-500" />
      <input
        class="input min-w-0 flex-1 py-0.5 font-mono text-xs"
        :value="newField"
        data-ui="field-new"
        aria-label="Name of the new field"
        spellcheck="false"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        @keydown.esc.prevent.stop="newField = null"
        @blur="commitField"
      />
    </div>
  </DetailsSection>
</template>
