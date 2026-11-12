<script setup lang="ts">
import type {
  GraphOp,
  ScriptSymbol,
  SourceRange,
  TypeSystemInfo,
} from '@vizscript/core';
import { pinColor } from '@vizscript/core';
import { computed, nextTick, ref, watch } from 'vue';
import { useTheme } from '../../composables/use-theme';
import { usesSnakeCase } from '../../graph/languages';
import DetailsSection from '../DetailsSection.vue';
import TypePicker from '../TypePicker.vue';

/** Inputs and output of a function symbol (UE: Inputs / Outputs). */
const props = defineProps<{
  symbol: ScriptSymbol;
  text: string;
  editable: boolean;
  /** Types and modifiers of the language (from the parser worker). */
  types: TypeSystemInfo | null;
  /** Types declared in the file, for the type picker. */
  declared: ReadonlyArray<string>;
  language: string;
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
}>();

const { scheme } = useTheme();

function code(range: SourceRange | undefined): string {
  return range ? props.text.slice(range.start, range.end) : '';
}

function color(dataType: string): string {
  return pinColor(dataType, scheme.value);
}

/** The type system (empty while it loads). */
const typeInfo = computed<TypeSystemInfo>(
  () => props.types ?? { primitives: [], modifiers: {} }
);

/** Inputs and output are editable for functions and methods. */
const editingSignature = computed(
  () =>
    props.editable &&
    props.types !== null &&
    (props.symbol.kind === 'function' || props.symbol.kind === 'method')
);

function addParameter(): void {
  const taken = new Set((props.symbol.params ?? []).map((p) => p.name));
  const base = usesSnakeCase(props.language) ? 'new_param' : 'newParam';
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    name = `${base}${i}`;
  }

  pendingParameter.value = name;
  emit('op', { type: 'addParameter', symbol: props.symbol.id, name });
}

/** A new input starts with its name selected, like a new function. */
const pendingParameter = ref<string | null>(null);
watch(
  () => props.symbol.params?.map((p) => p.name).join(','),
  async () => {
    const name = pendingParameter.value;
    if (!name || !props.symbol.params?.some((p) => p.name === name)) {
      return;
    }

    pendingParameter.value = null;
    await nextTick();
    const input = document.querySelector<HTMLInputElement>(
      `[data-ui="parameter-name"][data-name="${CSS.escape(name)}"]`
    );
    input?.focus();
    input?.select();
  }
);

function removeParameter(index: number): void {
  emit('op', { type: 'removeParameter', symbol: props.symbol.id, index });
}

function moveParameter(from: number, to: number): void {
  emit('op', { type: 'moveParameter', symbol: props.symbol.id, from, to });
}

function renameParameter(index: number, event: Event): void {
  const name = (event.target as HTMLInputElement).value.trim();
  if (name && name !== props.symbol.params?.[index]?.name) {
    emit('op', {
      type: 'renameParameter',
      symbol: props.symbol.id,
      index,
      name,
    });
  }
}

function setParameterType(index: number, typeText: string | null): void {
  emit('op', {
    type: 'setParameterType',
    symbol: props.symbol.id,
    index,
    typeText,
  });
}

function setParameterValue(index: number, event: Event): void {
  const value = (event.target as HTMLInputElement).value.trim();
  emit('op', {
    type: 'setParameterValue',
    symbol: props.symbol.id,
    index,
    value: value === '' ? null : value,
    kind: 'expression',
  });
}

function setReturnType(typeText: string | null): void {
  emit('op', { type: 'setReturnType', symbol: props.symbol.id, typeText });
}
</script>

<template>
  <DetailsSection v-if="symbol.params" id="symbol-inputs" title="Inputs">
    <template #actions>
      <button
        v-if="editingSignature"
        type="button"
        class="btn-ghost mb-1 px-1.5 py-0.5 text-xs"
        title="Add an input"
        @click="addParameter"
      >
        <span class="i-mdi-plus" /> Input
      </button>
    </template>
    <p v-if="symbol.params.length === 0" class="px-3 text-xs text-zinc-500">
      No inputs.
    </p>
    <template v-if="editingSignature">
      <div
        v-for="(param, index) in symbol.params"
        :key="`${index}:${param.name}`"
        class="mx-2 mb-1.5 space-y-1 rounded-md border border-zinc-800 p-1.5 text-xs"
      >
        <div class="flex items-center gap-1">
          <span
            class="size-2.5 shrink-0 rounded-full border-2"
            :style="{ borderColor: color(String(param.dataType)) }"
          />
          <input
            class="input min-w-0 flex-1 py-0.5 font-mono text-xs"
            :value="param.name"
            data-ui="parameter-name"
            :data-name="param.name"
            :aria-label="`Name of input ${index + 1}`"
            spellcheck="false"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            @change="renameParameter(index, $event)"
          />
          <button
            type="button"
            class="btn-ghost shrink-0 px-1"
            title="Move up"
            :aria-label="`Move ${param.name} up`"
            :disabled="index === 0"
            @click="moveParameter(index, index - 1)"
          >
            <span class="i-mdi-arrow-up" />
          </button>
          <button
            type="button"
            class="btn-ghost shrink-0 px-1"
            title="Move down"
            :aria-label="`Move ${param.name} down`"
            :disabled="index === symbol.params.length - 1"
            @click="moveParameter(index, index + 1)"
          >
            <span class="i-mdi-arrow-down" />
          </button>
          <button
            type="button"
            class="btn-ghost shrink-0 px-1 text-red-300"
            title="Remove this input"
            :aria-label="`Remove ${param.name}`"
            @click="removeParameter(index)"
          >
            <span class="i-mdi-close" />
          </button>
        </div>
        <div class="flex items-center gap-1">
          <TypePicker
            class="min-w-0 flex-1"
            :value="param.type?.text ?? null"
            :data-type="param.dataType"
            :types="typeInfo"
            :declared="declared"
            :editable="true"
            :required="typeInfo.requiredType !== undefined"
            @change="(typeText) => setParameterType(index, typeText)"
          />
          <input
            v-if="!typeInfo?.noParameterDefaults"
            class="input w-24 shrink-0 py-0.5 font-mono text-xs"
            :value="code(param.defaultRange)"
            placeholder="default"
            :aria-label="`Default value of ${param.name}`"
            spellcheck="false"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            @change="setParameterValue(index, $event)"
          />
        </div>
      </div>
    </template>
    <template v-else>
      <div
        v-for="param in symbol.params"
        :key="param.name"
        class="flex items-center gap-2 px-3 py-1 text-xs"
      >
        <span
          class="size-2.5 shrink-0 rounded-full border-2"
          :style="{ borderColor: color(String(param.dataType)) }"
        />
        <span class="min-w-0 truncate font-mono text-zinc-200"
          >{{ param.rest ? '…' : '' }}{{ param.name }}</span
        >
        <span
          class="ml-auto truncate font-mono"
          :class="param.type ? 'text-zinc-400' : 'text-zinc-600 italic'"
          >{{ param.type?.text ?? param.dataType }}</span
        >
        <span
          v-if="param.defaultRange || param.defaultText !== undefined"
          class="max-w-24 shrink-0 truncate font-mono text-zinc-500"
          :title="param.defaultText ?? code(param.defaultRange)"
          >= {{ param.defaultText ?? code(param.defaultRange) }}</span
        >
      </div>
    </template>
  </DetailsSection>

  <DetailsSection
    v-if="
      symbol.kind === 'function' ||
      symbol.kind === 'method' ||
      symbol.importedKind === 'function'
    "
    id="symbol-output"
    title="Output"
  >
    <div class="px-2 text-xs">
      <TypePicker
        v-if="editingSignature"
        :value="symbol.returns?.text ?? null"
        :data-type="symbol.returnType ?? 'any'"
        :types="typeInfo"
        :declared="declared"
        :editable="true"
        @change="setReturnType"
      />
      <div v-else class="flex items-center gap-2 px-1 py-1">
        <span
          class="size-2.5 shrink-0 rounded-full border-2"
          :style="{ borderColor: color(String(symbol.returnType ?? 'any')) }"
        />
        <span
          class="font-mono"
          :class="symbol.returns ? 'text-zinc-200' : 'text-zinc-600 italic'"
          >{{ symbol.returns?.text ?? 'not declared' }}</span
        >
      </div>
    </div>
  </DetailsSection>
</template>
