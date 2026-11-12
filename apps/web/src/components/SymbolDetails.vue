<script setup lang="ts">
import type {
  GraphOp,
  ScriptSymbol,
  SourceRange,
  TypeSystemInfo,
  ValueKind,
} from '@vizscript/core';
import { pinColor } from '@vizscript/core';
import { computed, ref, watch } from 'vue';
import { useTheme } from '../composables/use-theme';
import { lineColumn, snippet } from '../graph/source';
import { SYMBOL_ICONS, symbolLabel, symbolType } from '../graph/symbols';
import DetailsSection from './DetailsSection.vue';
import TypePicker from './TypePicker.vue';

/** Details of a symbol selected in "My Script" (UE: the Details panel). */
const props = defineProps<{
  symbol: ScriptSymbol;
  text: string;
  /** Number of nodes using the symbol (highlighted in the graph). */
  /** Unknown (not shown) for a locked symbol that isn't selected. */
  uses?: number;
  editable: boolean;
  /** Types and modifiers of the language (from the parser worker). */
  types: TypeSystemInfo | null;
  /** Types declared in the file, for the type picker. */
  declared: ReadonlyArray<string>;
  language: string;
  /**
   * Shown above the details of a selected variable node (UE shows the
   * variable when its Get / Set node is selected): no source, no uses.
   */
  compact?: boolean;
  /** File an import resolves to (`null`: not in the repository). */
  importPath?: string | null;
  /**
   * The description (doc comment above the declaration) and the node that
   * carries it; missing when the declaration can't have one.
   */
  description?: { nodeId: string; text: string };
  /** Runs on its own (engine callback, signal handler): name is fixed. */
  event?: boolean;
}>();

const emit = defineEmits<{
  reveal: [range: SourceRange];
  open: [];
  /** Open the file of an import at the imported name. */
  openImport: [];
  op: [op: GraphOp];
}>();

const { scheme } = useTheme();
const type = computed(() => symbolType(props.symbol));
const location = computed(() =>
  lineColumn(props.text, props.symbol.nameRange.start)
);
const source = computed(() =>
  snippet(
    props.text,
    props.symbol.kind === 'import'
      ? (props.symbol.declarationRange ?? props.symbol.range)
      : props.symbol.range,
    16
  )
);
const isImport = computed(() => props.symbol.kind === 'import');

// ----------------------------------------------------------------- rename

const renamable = computed(() => props.editable && !isImport.value);
const nameDraft = ref(props.symbol.name);
watch(
  () => props.symbol.name,
  (name) => {
    nameDraft.value = name;
  }
);

function commitDescription(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  const description = props.description;
  if (description && value.trim() !== description.text.trim()) {
    emit('op', {
      type: 'setComment',
      node: description.nodeId,
      text: value,
      doc: true,
    });
  }
}

function commitRename(): void {
  const name = nameDraft.value.trim();
  // A failed rename (toast) leaves the field as it was.
  nameDraft.value = props.symbol.name;
  if (name && name !== props.symbol.name) {
    emit('op', { type: 'renameSymbol', symbol: props.symbol.id, name });
  }
}

function cancelRename(event: KeyboardEvent): void {
  nameDraft.value = props.symbol.name;
  (event.target as HTMLInputElement).blur();
}
/** What an import takes from its module, in words. */
const importedText = computed(() => {
  const imported = props.symbol.imported;
  if (imported === '*') {
    return 'the whole module';
  }

  return imported === 'default' ? 'the default export' : (imported ?? '');
});
const isVariable = computed(() =>
  ['variable', 'constant', 'local'].includes(props.symbol.kind)
);

function code(range: SourceRange | undefined): string {
  return range ? props.text.slice(range.start, range.end) : '';
}

function color(dataType: string): string {
  return pinColor(dataType, scheme.value);
}

// ------------------------------------------------------------ value editor

const valueCode = computed(() => code(props.symbol.defaultRange).trim());

/** The text of a simple string literal (`"a"`, `'b'`), else `undefined`. */
function stringValue(literal: string): string | undefined {
  const match = literal.match(/^([&^]?)(["'])((?:\\.|(?!\2).)*)\2$/s);
  if (!match) {
    return undefined;
  }

  return (match[3] ?? '').replaceAll(/\\(.)/g, (_, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char
  );
}

const BOOLEANS = new Set(['true', 'false', 'True', 'False']);

/** How the value is edited: like UE, the widget follows the type. */
const valueKind = computed<ValueKind>(() => {
  const dataType = String(props.symbol.dataType);
  const current = valueCode.value;
  if (dataType === 'bool' && (current === '' || BOOLEANS.has(current))) {
    return 'bool';
  }

  if (
    dataType === 'number' &&
    (current === '' || /^[-+]?[\d_.]+(?:e[-+]?\d+)?$/i.test(current))
  ) {
    return 'number';
  }

  if (
    dataType === 'string' &&
    (current === '' || stringValue(current) !== undefined)
  ) {
    return 'string';
  }

  return 'expression';
});

const draft = ref('');
watch(
  [valueCode, valueKind],
  () => {
    draft.value =
      valueKind.value === 'string'
        ? (stringValue(valueCode.value) ?? '')
        : valueCode.value;
  },
  { immediate: true }
);

function commitValue(): void {
  const current =
    valueKind.value === 'string'
      ? stringValue(valueCode.value)
      : valueCode.value;
  // `v-model` on a number field gives a number.
  const next = String(draft.value);
  if (next === current) {
    return;
  }

  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: next === '' && valueKind.value !== 'string' ? null : next,
    kind: valueKind.value,
  });
}

function setBoolean(event: Event): void {
  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: String((event.target as HTMLInputElement).checked),
    kind: 'bool',
  });
}

function clearValue(): void {
  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: null,
    kind: 'expression',
  });
}

function setType(typeText: string | null, defaultValue?: string): void {
  emit('op', {
    type: 'setSymbolType',
    symbol: props.symbol.id,
    typeText,
    ...(defaultValue === undefined ? {} : { defaultValue }),
  });
}

// --------------------------------------------------------------- signature

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
  const base =
    props.language === 'python' || props.language === 'gdscript'
      ? 'new_param'
      : 'newParam';
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    name = `${base}${i}`;
  }

  emit('op', { type: 'addParameter', symbol: props.symbol.id, name });
}

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

// --------------------------------------------------------------- modifiers

/** Keywords and switches the language offers for this kind of symbol. */
const modifierOptions = computed(() => {
  const modifiers = props.types?.modifiers;
  if (!modifiers) {
    return undefined;
  }

  // Functions like UE's access specifier and flags (`export`, `async`).
  if (props.symbol.kind === 'function' || props.symbol.kind === 'method') {
    return modifiers[props.symbol.kind];
  }

  if (!isVariable.value) {
    return undefined;
  }

  // GDScript: the script's members are its variables, not class members.
  const member =
    props.symbol.scope !== '' &&
    props.symbol.kind !== 'local' &&
    !(props.language === 'gdscript' && props.symbol.scope === '');
  const kind =
    props.symbol.kind === 'local'
      ? 'local'
      : member
        ? 'member'
        : props.symbol.kind === 'constant'
          ? 'constant'
          : 'variable';
  return modifiers[kind];
});

function hasModifier(modifier: string): boolean {
  return (
    props.symbol.modifiers.includes(modifier) ||
    (modifier === 'export' && props.symbol.modifiers.includes('export default'))
  );
}

/** Modifiers the Details can't switch (decorators, `declare`, …). */
const otherModifiers = computed(() => {
  const options = modifierOptions.value;
  const known = new Set([
    ...(options?.keywords ?? []),
    ...(options?.access ?? []),
    ...(options?.flags ?? []),
    ...(options?.flags?.includes('export') ? ['export default'] : []),
    ...(props.types?.exportHints ?? []).map((h) => h.name),
  ]);
  return props.symbol.modifiers.filter((m) => !known.has(m));
});

// ----------------------------------------------------------- export hints

/** Exported variables of the script can get an editor hint (GDScript). */
const exportHints = computed(() =>
  props.symbol.kind === 'variable' && props.symbol.scope === ''
    ? (props.types?.exportHints ?? [])
    : []
);

/** The export annotation written (`@export_range(0, 10)`), if any. */
const currentExport = computed(() => {
  // The declaration's line, and the line above when it holds only an
  // annotation (`@export_range(0, 10)` on its own line).
  const own = props.text.lastIndexOf('\n', props.symbol.range.start - 1) + 1;
  const above = own > 0 ? props.text.lastIndexOf('\n', own - 2) + 1 : own;
  const start = /^\s*@\w+(?:\([^)]*\))?\s*$/.test(props.text.slice(above, own))
    ? above
    : own;
  const head = props.text.slice(start, props.symbol.nameRange.start);
  const match = head.match(/(@export\w*)(?:\(([^)]*)\))?/);
  return match ? { name: match[1] ?? '', args: match[2] ?? '' } : undefined;
});

function setExportHint(name: string): void {
  const current = currentExport.value;
  if (!name) {
    if (current) {
      setModifier(current.name, false);
    }

    return;
  }

  const hint = exportHints.value.find((h) => h.name === name);
  setModifier(hint?.args ? `${name}(${hint.args})` : name, true);
}

// `@export_range(min, max, step, "or_greater", "suffix:m")` as fields.
const RANGE_FIELDS = ['min', 'max', 'step'];
const RANGE_FLAGS = ['or_greater', 'or_less'];

/** Top-level arguments (commas inside strings stay). */
function splitArgs(args: string): string[] {
  return (args.match(/"(?:\\.|[^"\\])*"|[^,]+/g) ?? [])
    .map((a) => a.trim())
    .filter(Boolean);
}

const range = computed(() => {
  const current = currentExport.value;
  if (current?.name !== '@export_range') {
    return undefined;
  }

  const args = splitArgs(current.args);
  const numbers = args.filter((a) => !a.startsWith('"'));
  const hints = args
    .filter((a) => a.startsWith('"'))
    .map((a) => a.slice(1, -1));
  return {
    numbers,
    flags: hints.filter((h) => RANGE_FLAGS.includes(h)),
    /** Other hints (`suffix:m`, `exp`) are kept as they are. */
    other: hints.filter((h) => !RANGE_FLAGS.includes(h)),
  };
});

function writeRange(
  numbers: ReadonlyArray<string>,
  hints: ReadonlyArray<string>
): void {
  const filled = numbers.map((n) => n.trim()).filter(Boolean);
  setExportArgs([...filled, ...hints.map((h) => `"${h}"`)].join(', '));
}

function setRangeNumber(index: number, value: string): void {
  const current = range.value;
  if (!current) {
    return;
  }

  const numbers = [...current.numbers];
  numbers[index] = value;
  writeRange(numbers, [...current.flags, ...current.other]);
}

function setRangeFlag(flag: string, enabled: boolean): void {
  const current = range.value;
  if (!current) {
    return;
  }

  // Godot's order: or_greater, or_less, then the other hints.
  const flags = RANGE_FLAGS.filter((f) =>
    f === flag ? enabled : current.flags.includes(f)
  );
  writeRange(current.numbers, [...flags, ...current.other]);
}

function setExportArgs(args: string): void {
  const current = currentExport.value;
  if (current && args.trim() !== current.args) {
    setModifier(`${current.name}(${args.trim()})`, true);
  }
}

// ---------------------------------------------------------------- private

/**
 * UE's "Private" switch where privacy is a naming convention (`_name` in
 * Python and GDScript): switching renames the symbol and its uses. Not for
 * `__dunder__` names and engine callbacks (`_ready`).
 */
const privatePrefix = computed(() => {
  const prefix = props.types?.privatePrefix;
  const { kind, name } = props.symbol;
  return prefix &&
    ['variable', 'constant', 'function', 'method', 'signal'].includes(kind) &&
    !name.startsWith(`${prefix}${prefix}`) &&
    !props.event
    ? prefix
    : undefined;
});

function setPrivate(enabled: boolean): void {
  const prefix = privatePrefix.value;
  const name = props.symbol.name;
  if (!prefix || name.startsWith(prefix) === enabled) {
    return;
  }

  emit('op', {
    type: 'renameSymbol',
    symbol: props.symbol.id,
    name: enabled ? `${prefix}${name}` : name.slice(prefix.length),
  });
}

/** The access level written, else the default (the first, `public`). */
const access = computed(() => {
  const levels = modifierOptions.value?.access ?? [];
  return levels.find((a) => props.symbol.modifiers.includes(a)) ?? levels[0];
});

function setModifier(modifier: string, enabled: boolean): void {
  emit('op', {
    type: 'setModifier',
    symbol: props.symbol.id,
    modifier,
    enabled,
  });
}
</script>

<template>
  <div data-ui="symbol-details">
    <div class="border-b border-zinc-800 px-3 py-2.5">
      <div class="flex items-center gap-2">
        <span
          class="shrink-0"
          :class="SYMBOL_ICONS[symbol.importedKind ?? symbol.kind]"
        />
        <!-- Like UE's name field: rename here (uses are renamed too). -->
        <input
          v-if="renamable"
          v-model="nameDraft"
          data-ui="symbol-name"
          class="-mx-1 min-w-0 flex-1 truncate rounded bg-transparent px-1 font-semibold text-zinc-50 hover:bg-zinc-800 focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-amber-500"
          :aria-label="`Name of ${symbol.name}`"
          spellcheck="false"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          @keydown.escape.prevent="cancelRename($event)"
          @change="commitRename"
        />
        <span v-else class="truncate font-semibold text-zinc-50">{{
          symbol.name
        }}</span>
      </div>
      <div class="mt-0.5 text-xs text-zinc-400">
        {{ symbolLabel(symbol)
        }}<template v-if="symbol.scope"> in {{ symbol.scope }}</template>
      </div>
    </div>

    <!-- UE's Description: the doc comment above the declaration. -->
    <div
      v-if="description && (editable || description.text)"
      data-ui="symbol-description"
      class="border-b border-zinc-800/80 px-3 py-2"
    >
      <textarea
        :key="description.nodeId"
        class="input min-h-12 resize-y text-xs"
        :value="description.text"
        :readonly="!editable"
        placeholder="Description…"
        :aria-label="`Description of ${symbol.name}`"
        rows="2"
        @change="commitDescription"
      />
    </div>

    <DetailsSection id="symbol-general" :title="symbolLabel(symbol)">
      <dl class="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1.5 px-3 text-xs">
        <template v-if="isImport">
          <dt class="text-zinc-500">Module</dt>
          <dd class="truncate font-mono text-zinc-200" :title="symbol.module">
            {{ symbol.module }}
          </dd>
          <dt class="text-zinc-500">Imports</dt>
          <dd class="truncate text-zinc-200">
            <span
              :class="{
                'font-mono':
                  symbol.imported !== '*' && symbol.imported !== 'default',
              }"
              >{{ importedText }}</span
            >
          </dd>
          <template v-if="importPath !== undefined">
            <dt class="text-zinc-500">File</dt>
            <dd class="min-w-0">
              <button
                v-if="importPath"
                type="button"
                class="block max-w-full truncate text-left font-mono text-sky-300 hover:text-sky-200 hover:underline"
                :title="`Open ${importPath}`"
                @click="emit('openImport')"
              >
                {{ importPath }}
              </button>
              <span v-else class="text-zinc-500">{{
                symbol.importedKind ? 'Library' : 'Not in this repository'
              }}</span>
            </dd>
          </template>
        </template>
        <template v-else-if="!symbol.params">
          <dt class="pt-0.5 text-zinc-500">Type</dt>
          <dd class="min-w-0">
            <TypePicker
              v-if="types && isVariable"
              :value="symbol.type?.text ?? null"
              :data-type="symbol.dataType"
              :types="types"
              :declared="declared"
              :editable="editable"
              @change="setType"
            />
            <span
              v-else
              class="flex min-w-0 items-center gap-1.5 px-1.5 font-mono"
            >
              <span
                class="size-2 shrink-0 rounded-full"
                :style="{ background: color(String(symbol.dataType)) }"
              />
              <span
                class="truncate"
                :class="
                  type.inferred ? 'text-zinc-500 italic' : 'text-zinc-200'
                "
                >{{ type.text }}</span
              >
            </span>
          </dd>
        </template>
        <template v-if="isVariable">
          <dt class="pt-1 text-zinc-500">
            {{ symbol.kind === 'local' ? 'Value' : 'Default value' }}
          </dt>
          <dd class="flex min-w-0 items-center gap-1">
            <template v-if="!editable">
              <span class="truncate px-1.5 font-mono text-zinc-200">{{
                valueCode || '—'
              }}</span>
            </template>
            <label
              v-else-if="valueKind === 'bool'"
              class="flex cursor-pointer items-center gap-1.5 px-1.5 py-0.5"
            >
              <input
                type="checkbox"
                class="accent-amber-500"
                :checked="valueCode === 'true' || valueCode === 'True'"
                :aria-label="`Value of ${symbol.name}`"
                @change="setBoolean"
              />
              <span class="font-mono text-zinc-300">{{
                valueCode || 'no value'
              }}</span>
            </label>
            <input
              v-else
              :key="`${symbol.id}:${valueKind}`"
              v-model="draft"
              class="input py-0.5 text-xs"
              :class="valueKind === 'string' ? '' : 'font-mono'"
              :type="valueKind === 'number' ? 'number' : 'text'"
              :placeholder="valueKind === 'string' ? 'Text' : 'No value'"
              :aria-label="`Value of ${symbol.name}`"
              spellcheck="false"
              @keydown.enter.prevent="commitValue"
              @blur="commitValue"
            />
            <button
              v-if="editable && symbol.defaultRange"
              type="button"
              class="btn-ghost shrink-0 px-1"
              title="Remove the value"
              aria-label="Remove the value"
              @click="clearValue"
            >
              <span class="i-mdi-close" />
            </button>
          </dd>
        </template>
        <template v-if="modifierOptions?.keywords">
          <dt class="pt-1 text-zinc-500">Declaration</dt>
          <dd
            class="flex flex-wrap gap-1"
            role="group"
            aria-label="Declaration"
          >
            <button
              v-for="keyword in modifierOptions.keywords"
              :key="keyword"
              type="button"
              class="rounded px-2 py-0.5 font-mono"
              :class="
                hasModifier(keyword)
                  ? 'bg-zinc-700 text-zinc-50'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              "
              :aria-pressed="hasModifier(keyword)"
              :disabled="!editable"
              @click="setModifier(keyword, true)"
            >
              {{ keyword }}
            </button>
          </dd>
        </template>
        <template v-if="modifierOptions?.access">
          <dt class="pt-1 text-zinc-500">Access</dt>
          <dd class="flex flex-wrap gap-1" role="group" aria-label="Access">
            <button
              v-for="level in modifierOptions.access"
              :key="level"
              type="button"
              class="rounded px-2 py-0.5 font-mono"
              :class="
                access === level
                  ? 'bg-zinc-700 text-zinc-50'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              "
              :aria-pressed="access === level"
              :disabled="!editable"
              @click="access !== level && setModifier(level, true)"
            >
              {{ level }}
            </button>
          </dd>
        </template>
        <template v-if="exportHints.length > 0">
          <dt class="pt-1 text-zinc-500">Export</dt>
          <dd class="flex min-w-0 flex-col gap-1">
            <select
              class="input py-1 font-mono text-xs"
              :value="currentExport?.name ?? ''"
              :disabled="!editable"
              aria-label="Export hint"
              @change="
                setExportHint(($event.target as HTMLSelectElement).value)
              "
            >
              <option value="">not exported</option>
              <option
                v-for="hint in exportHints"
                :key="hint.name"
                :value="hint.name"
              >
                {{ hint.name }}
              </option>
            </select>
            <!-- UE's Slider / Value Range: min … max, step, open ends. -->
            <div
              v-if="range"
              :key="currentExport?.args"
              data-ui="export-range"
              class="flex flex-col gap-1"
            >
              <div class="flex items-center gap-1">
                <input
                  v-for="(field, i) in RANGE_FIELDS"
                  :key="field"
                  class="input min-w-0 py-1 font-mono text-xs"
                  :value="range.numbers[i] ?? ''"
                  :placeholder="field"
                  :readonly="!editable"
                  :aria-label="field"
                  :title="field"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                  @change="
                    setRangeNumber(i, ($event.target as HTMLInputElement).value)
                  "
                />
              </div>
              <div class="flex flex-wrap gap-x-3">
                <label
                  v-for="flag in RANGE_FLAGS"
                  :key="flag"
                  class="flex cursor-pointer items-center gap-1.5 font-mono text-zinc-300"
                >
                  <input
                    type="checkbox"
                    class="accent-amber-500"
                    :checked="range.flags.includes(flag)"
                    :disabled="!editable"
                    @change="
                      setRangeFlag(
                        flag,
                        ($event.target as HTMLInputElement).checked
                      )
                    "
                  />
                  {{ flag }}
                </label>
              </div>
            </div>
            <input
              v-else-if="currentExport && currentExport.args !== ''"
              :key="`${currentExport.name}:${currentExport.args}`"
              class="input py-1 font-mono text-xs"
              :value="currentExport.args"
              :readonly="!editable"
              :aria-label="`Arguments of ${currentExport.name}`"
              spellcheck="false"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
              @change="setExportArgs(($event.target as HTMLInputElement).value)"
            />
          </dd>
        </template>
        <template v-if="privatePrefix && !compact">
          <dt class="pt-0.5 text-zinc-500">Private</dt>
          <dd>
            <label
              class="flex cursor-pointer items-center gap-1.5 text-zinc-300"
              :title="`Renames to ${symbol.name.startsWith(privatePrefix) ? symbol.name.slice(privatePrefix.length) : privatePrefix + symbol.name}`"
            >
              <input
                type="checkbox"
                class="accent-amber-500"
                :checked="symbol.name.startsWith(privatePrefix)"
                :disabled="!editable"
                aria-label="Private"
                @change="
                  setPrivate(($event.target as HTMLInputElement).checked)
                "
              />
              <span class="font-mono text-zinc-500"
                >{{ privatePrefix }}name</span
              >
            </label>
          </dd>
        </template>
        <template v-if="modifierOptions?.flags">
          <dt class="pt-0.5 text-zinc-500">Modifiers</dt>
          <dd class="flex flex-wrap gap-x-3 gap-y-1">
            <label
              v-for="flag in modifierOptions.flags"
              :key="flag"
              class="flex cursor-pointer items-center gap-1.5 font-mono text-zinc-300"
            >
              <input
                type="checkbox"
                class="accent-amber-500"
                :checked="hasModifier(flag)"
                :disabled="!editable"
                @change="
                  setModifier(flag, ($event.target as HTMLInputElement).checked)
                "
              />
              {{ flag }}
            </label>
          </dd>
        </template>
        <template v-if="symbol.extends">
          <dt class="text-zinc-500">Extends</dt>
          <dd class="truncate font-mono text-zinc-200">{{ symbol.extends }}</dd>
        </template>
        <template
          v-if="
            !compact &&
            uses !== undefined &&
            symbol.kind !== 'type' &&
            symbol.kind !== 'enum' &&
            !(isImport && symbol.modifiers.includes('type'))
          "
        >
          <dt class="text-zinc-500">Used by</dt>
          <dd class="text-zinc-300">
            {{ uses }} node{{ uses === 1 ? '' : 's' }}
            <span v-if="uses > 0" class="text-zinc-500">(highlighted)</span>
          </dd>
        </template>
      </dl>
    </DetailsSection>

    <!-- Rarely needed rows, folded like UE's "Advanced". -->
    <DetailsSection
      v-if="!compact"
      id="symbol-advanced"
      title="Advanced"
      default-collapsed
    >
      <dl class="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1.5 px-3 text-xs">
        <template v-if="otherModifiers.length > 0 && !isImport">
          <dt class="text-zinc-500">
            {{ modifierOptions ? 'Also' : 'Modifiers' }}
          </dt>
          <dd class="flex flex-wrap gap-1">
            <span
              v-for="modifier in otherModifiers"
              :key="modifier"
              class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
              >{{ modifier }}</span
            >
          </dd>
        </template>
        <dt class="text-zinc-500">Location</dt>
        <dd>
          <button
            type="button"
            class="text-left text-sky-300 hover:text-sky-200 hover:underline"
            @click="emit('reveal', symbol.nameRange)"
          >
            Line {{ location.line }}, column {{ location.column }}
          </button>
        </dd>
      </dl>
    </DetailsSection>

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
              :aria-label="`Name of input ${index + 1}`"
              spellcheck="false"
              @keydown.enter.prevent="
                ($event.target as HTMLInputElement).blur()
              "
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
              @change="(typeText) => setParameterType(index, typeText)"
            />
            <input
              class="input w-24 shrink-0 py-0.5 font-mono text-xs"
              :value="code(param.defaultRange)"
              placeholder="default"
              :aria-label="`Default value of ${param.name}`"
              spellcheck="false"
              @keydown.enter.prevent="
                ($event.target as HTMLInputElement).blur()
              "
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

    <DetailsSection v-if="!compact" id="symbol-source" title="Source">
      <pre
        class="mx-3 overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-[11px] leading-snug text-zinc-300"
        >{{ source }}</pre>
    </DetailsSection>

    <div v-if="symbol.fnId && !compact" class="px-3 py-3">
      <button
        type="button"
        class="btn-ghost w-full justify-center border border-zinc-800"
        @click="emit('open')"
      >
        <span class="i-mdi-graph-outline" /> Show in graph
      </button>
    </div>
  </div>
</template>

<style scoped>
.section {
  @apply border-b border-zinc-800/80 py-2;
}

.section-title {
  @apply px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500;
}
</style>
