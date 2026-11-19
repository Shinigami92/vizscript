<script setup lang="ts">
import type { GraphOp, ScriptSymbol, TypeSystemInfo } from '@vizscript/core';
import { computed } from 'vue';

/**
 * What a class extends and implements, or an interface extends: rows of
 * Details' general section, edited as written (`Base<T>`, `A, B`); names
 * from other files get their imports.
 */
const props = defineProps<{
  symbol: ScriptSymbol;
  types?: TypeSystemInfo | null;
  editable: boolean;
}>();

const emit = defineEmits<{ op: [op: GraphOp] }>();

type Clause = 'extends' | 'implements';

const kind = computed(() => {
  if (props.symbol.kind === 'class') {
    return 'class';
  }

  return props.symbol.kind === 'type' &&
    props.symbol.modifiers.includes('interface')
    ? 'interface'
    : undefined;
});

/** The clauses shown: editable ones, else those written. */
const rows = computed(() => {
  const editable = kind.value
    ? (props.types?.heritage?.[kind.value] ?? [])
    : [];
  const all: Clause[] = ['extends', 'implements'];
  return all.flatMap((clause) => {
    const value = props.symbol[clause] ?? '';
    const canEdit = props.editable && editable.includes(clause);
    return canEdit || value ? [{ clause, value, canEdit }] : [];
  });
});

function label(clause: Clause): string {
  return clause === 'extends' ? 'Extends' : 'Implements';
}

function change(clause: Clause, event: Event): void {
  const text = (event.target as HTMLInputElement).value.trim();
  if (text !== (props.symbol[clause] ?? '')) {
    emit('op', {
      type: 'setHeritage',
      symbol: props.symbol.id,
      clause,
      text,
    });
  }
}
</script>

<template>
  <template v-for="row in rows" :key="row.clause">
    <dt class="text-zinc-500" :class="{ 'pt-1': row.canEdit }">
      {{ label(row.clause) }}
    </dt>
    <dd :data-ui="`symbol-${row.clause}`" class="min-w-0">
      <input
        v-if="row.canEdit"
        :key="row.value"
        class="input py-0.5 font-mono text-xs"
        :value="row.value"
        placeholder="none"
        :aria-label="`${label(row.clause)} of ${symbol.name}`"
        spellcheck="false"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        @change="change(row.clause, $event)"
      />
      <span v-else class="block truncate font-mono text-zinc-200">{{
        row.value
      }}</span>
    </dd>
  </template>
</template>
