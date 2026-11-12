<script setup lang="ts">
import type { GraphOp, ScriptSymbol, TypeSystemInfo } from '@vizscript/core';
import { computed } from 'vue';

/** The export hint row of a script variable (GDScript): `<dt>` and `<dd>`. */
const props = defineProps<{
  symbol: ScriptSymbol;
  text: string;
  editable: boolean;
  types: TypeSystemInfo | null;
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
}>();

function setModifier(modifier: string, enabled: boolean): void {
  emit('op', {
    type: 'setModifier',
    symbol: props.symbol.id,
    modifier,
    enabled,
  });
}

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
  const match = head.match(
    /(@export(?!_group|_subgroup|_category)\w*)(?:\(([^)]*)\))?/
  );
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
</script>

<template>
  <template v-if="exportHints.length > 0">
    <dt class="pt-1 text-zinc-500">Export</dt>
    <dd class="flex min-w-0 flex-col gap-1">
      <select
        class="input py-1 font-mono text-xs"
        :value="currentExport?.name ?? ''"
        :disabled="!editable"
        aria-label="Export hint"
        @change="setExportHint(($event.target as HTMLSelectElement).value)"
      >
        <option value="">not exported</option>
        <option v-for="hint in exportHints" :key="hint.name" :value="hint.name">
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
                setRangeFlag(flag, ($event.target as HTMLInputElement).checked)
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
</template>
