<script setup lang="ts">
import type {
  GraphDocument,
  GraphOp,
  ScriptSymbol,
  SourceRange,
  TypeSystemInfo,
} from '@vizscript/core';
import { declaringNode, pinColor } from '@vizscript/core';
import { computed, ref, watch } from 'vue';
import { useTheme } from '../composables/use-theme';
import { lineColumn, snippet } from '../graph/source';
import { SYMBOL_ICONS, symbolLabel, symbolType } from '../graph/symbols';
import DetailsSection from './DetailsSection.vue';
import SymbolExportHint from './symbol-details/SymbolExportHint.vue';
import SymbolSignature from './symbol-details/SymbolSignature.vue';
import SymbolValueField from './symbol-details/SymbolValueField.vue';
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
  /** Symbols of the file (enum members for value choices). */
  symbols?: ReadonlyArray<ScriptSymbol>;
  /** The parsed file (uses of a function's inputs). */
  doc?: GraphDocument | null;
  /**
   * Value and type in the saved version of the file (last commit, file on
   * disk) for UE's reset ↶; missing for symbols that are new.
   */
  base?: { value: string | null; type: string | null };
}>();

const emit = defineEmits<{
  reveal: [range: SourceRange];
  open: [];
  /** Open the file of an import at the imported name. */
  openImport: [];
  op: [op: GraphOp];
  select: [ids: string[]];
}>();

/** Selects the SET node that computes the variable's value. */
function showValueNode(): void {
  const node = props.doc ? declaringNode(props.doc, props.symbol) : undefined;
  if (node) {
    emit('select', [node.id]);
  }
}

const { scheme } = useTheme();
const type = computed(() => symbolType(props.symbol));
const location = computed(() =>
  lineColumn(props.text, props.symbol.nameRange.start)
);
const source = computed(() =>
  snippet(
    props.text,
    // The whole declaration (`let user;`), not only the declared name.
    props.symbol.declarationRange ?? props.symbol.range,
    16
  )
);
const isImport = computed(() => props.symbol.kind === 'import');

// ----------------------------------------------------------------- rename

/** A function written as an argument (`on('x', (e) => …)`): no name. */
const callback = computed(() => props.symbol.modifiers.includes('callback'));
const renamable = computed(
  () => props.editable && !isImport.value && !callback.value
);
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
/** A field of a class that takes no default value (Rust struct fields). */
const isValuelessField = computed(
  () =>
    props.types?.noFieldValues === true &&
    props.symbol.kind === 'variable' &&
    (props.symbols ?? []).some(
      (s) =>
        s.kind === 'class' &&
        (s.scope ? `${s.scope}.${s.name}` : s.name) === props.symbol.scope
    )
);
/** The language needs a type here: no "No type" choice (Rust). */
const typeRequired = computed(
  () =>
    props.types?.requiredType !== undefined &&
    (props.symbol.kind === 'variable' || props.symbol.kind === 'constant')
);

/** Declared with the type of its value (GDScript's `var x := 1`). */
const inferredDeclaration = computed(() => {
  const operator = props.types?.inferredType;
  return (
    operator !== undefined &&
    !props.symbol.type &&
    props.text
      .slice(props.symbol.nameRange.end)
      .trimStart()
      .startsWith(operator)
  );
});

function color(dataType: string): string {
  return pinColor(dataType, scheme.value);
}

function setType(typeText: string | null, defaultValue?: string): void {
  emit('op', {
    type: 'setSymbolType',
    symbol: props.symbol.id,
    typeText,
    ...(defaultValue === undefined ? {} : { defaultValue }),
  });
}

// --------------------------------------------------------------- modifiers

/** Keywords and switches the language offers for this kind of symbol. */
const modifierOptions = computed(() => {
  const modifiers = props.types?.modifiers;
  if (!modifiers) {
    return undefined;
  }

  // Functions like UE's access specifier and flags (`export`, `async`);
  // a callback can only be `async`.
  if (props.symbol.kind === 'function' || props.symbol.kind === 'method') {
    const options = modifiers[props.symbol.kind];
    return callback.value
      ? { flags: (options?.flags ?? []).filter((f) => f === 'async') }
      : options;
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
    ...(props.types?.exposeOnSpawn ? ['constructor'] : []),
    // Shown as the label ("Callback"), not as a modifier.
    'callback',
  ]);
  return props.symbol.modifiers.filter((m) => !known.has(m));
});

// ------------------------------------------------------------------ reset

/** Like UE's ↶: the type differs from the saved version. */
const typeChanged = computed(
  () =>
    props.base !== undefined &&
    isVariable.value &&
    props.base.type !== (props.symbol.type?.text ?? null)
);

function resetType(): void {
  emit('op', {
    type: 'setSymbolType',
    symbol: props.symbol.id,
    typeText: props.base?.type ?? null,
  });
}

// ------------------------------------------------------- expose on spawn

/** UE's "Expose on Spawn": a class field set by the constructor. */
const spawnable = computed(
  () =>
    props.types?.exposeOnSpawn === true &&
    props.symbol.kind === 'variable' &&
    props.symbol.scope !== '' &&
    !props.symbol.modifiers.includes('static') &&
    !props.symbol.name.startsWith('#')
);

// --------------------------------------------------------------- category

/**
 * UE's Category: GDScript export groups of exported script variables
 * (moving the variable under its group's `@export_group` line).
 */
const groupable = computed(
  () =>
    props.types?.symbolGroups === true &&
    props.symbol.kind === 'variable' &&
    props.symbol.scope === '' &&
    props.symbol.modifiers.some((m) => m.startsWith('@export'))
);
const knownGroups = computed(() => [
  ...new Set(
    (props.symbols ?? [])
      .map((s) => s.group)
      .filter((g): g is string => g !== undefined)
  ),
]);

function setGroup(group: string): void {
  if (group.trim() !== (props.symbol.group ?? '')) {
    emit('op', {
      type: 'setSymbolGroup',
      symbol: props.symbol.id,
      group: group.trim(),
    });
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
    !props.event &&
    !callback.value
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
      v-if="description && !callback && (editable || description.text)"
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
          <dd class="flex min-w-0 items-center gap-1">
            <TypePicker
              v-if="types && isVariable"
              :value="symbol.type?.text ?? null"
              :data-type="symbol.dataType"
              :types="types"
              :declared="declared"
              :editable="editable"
              :required="typeRequired"
              :inferable="true"
              :inferred="inferredDeclaration"
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
            <button
              v-if="editable && typeChanged"
              type="button"
              class="btn-ghost shrink-0 px-1 text-amber-400"
              :title="`Reset to the saved type (${base?.type ?? 'none'})`"
              aria-label="Reset the type"
              @click="resetType"
            >
              <span class="i-mdi-restore" />
            </button>
          </dd>
        </template>
        <SymbolValueField
          v-if="isVariable && !isValuelessField"
          :symbol="symbol"
          :text="text"
          :editable="editable"
          :types="types"
          :symbols="symbols"
          :base="base"
          @op="emit('op', $event)"
          @show-node="showValueNode"
        />
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
        <SymbolExportHint
          :symbol="symbol"
          :text="text"
          :editable="editable"
          :types="types"
          @op="emit('op', $event)"
        />
        <template v-if="groupable">
          <dt class="pt-1 text-zinc-500">Category</dt>
          <dd>
            <input
              :key="`${symbol.id}:${symbol.group ?? ''}`"
              class="input py-1 text-xs"
              :value="symbol.group ?? ''"
              :readonly="!editable"
              :list="`groups-${symbol.id}`"
              placeholder="Default"
              aria-label="Category"
              title="Export group; Group/Subgroup nests"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
              @change="setGroup(($event.target as HTMLInputElement).value)"
            />
            <datalist :id="`groups-${symbol.id}`">
              <option v-for="name in knownGroups" :key="name" :value="name" />
            </datalist>
          </dd>
        </template>
        <template v-if="spawnable && !compact">
          <dt class="pt-0.5 text-zinc-500">Expose on spawn</dt>
          <dd>
            <label
              class="flex cursor-pointer items-center gap-1.5 text-zinc-300"
              title="A parameter of the constructor (set when created)"
            >
              <input
                type="checkbox"
                class="accent-amber-500"
                :checked="symbol.modifiers.includes('constructor')"
                :disabled="!editable"
                aria-label="Expose on spawn"
                @change="
                  setModifier(
                    'constructor',
                    ($event.target as HTMLInputElement).checked
                  )
                "
              />
              <span class="font-mono text-zinc-500">constructor(…)</span>
            </label>
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
            !callback &&
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

    <SymbolSignature
      :symbol="symbol"
      :text="text"
      :editable="editable"
      :types="types"
      :declared="declared"
      :language="language"
      :doc="doc"
      @op="emit('op', $event)"
    />

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
