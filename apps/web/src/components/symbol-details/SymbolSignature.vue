<script setup lang="ts">
import type {
  FieldValue,
  GraphDocument,
  GraphOp,
  ScriptSymbol,
  SourceRange,
  TypeSystemInfo,
  ValueKind,
} from '@vizscript/core';
import { fieldValue, isArrayType } from '@vizscript/core';
import { computed, nextTick, ref, watch } from 'vue';
import { usesSnakeCase } from '../../graph/languages';
import { decoratable, parameterUses } from '../../graph/symbols';
import DetailsSection from '../DetailsSection.vue';
import NumberField from '../NumberField.vue';
import PinIcon from '../PinIcon.vue';
import TypePicker from '../TypePicker.vue';
import ValueFields from '../ValueFields.vue';
import ArrayDefaultField from './ArrayDefaultField.vue';
import DecoratorList from './DecoratorList.vue';
import { PLACEHOLDER_VALUES, stringValue, valueKindOf } from './value-kinds';

/** Inputs and output of a function or signal (UE: Inputs / Outputs). */
const props = defineProps<{
  symbol: ScriptSymbol;
  text: string;
  editable: boolean;
  /** Types and modifiers of the language (from the parser worker). */
  types: TypeSystemInfo | null;
  /** Types declared in the file, for the type picker. */
  declared: ReadonlyArray<string>;
  language: string;
  /** The parsed file, to find uses of an input before removing it. */
  doc?: GraphDocument | null;
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
}>();

function code(range: SourceRange | undefined): string {
  return range ? props.text.slice(range.start, range.end) : '';
}

/** The type system (empty while it loads). */
const typeInfo = computed<TypeSystemInfo>(
  () => props.types ?? { primitives: [], modifiers: {} }
);

/** Inputs (and outputs) are editable for functions, methods and signals. */
const editingSignature = computed(
  () =>
    props.editable &&
    props.types !== null &&
    (props.symbol.kind === 'function' ||
      props.symbol.kind === 'method' ||
      props.symbol.kind === 'signal')
);

/** Inputs of class methods take decorators (`@Param('id')`). */
const decoratesParams = computed(
  () => decoratable(props.types, props.doc, props.symbol).params
);

function setParamDecorator(
  param: number,
  index: number | undefined,
  text: string | null
): void {
  emit('op', {
    type: 'setDecorator',
    symbol: props.symbol.id,
    param,
    ...(index === undefined ? {} : { index }),
    text,
  });
}

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
  const param = props.symbol.params?.[index];
  const uses = param ? parameterUses(props.doc, props.symbol, param.name) : 0;
  // Like deleting a variable that is in use (My Script).
  if (
    param &&
    uses > 0 &&
    !globalThis.confirm(
      `${param.name} is used by ${uses} node${uses === 1 ? '' : 's'}. Remove it anyway? Its uses stay and will show errors.`
    )
  ) {
    return;
  }

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
  const current = code(props.symbol.params?.[index]?.defaultRange).trim();
  emit('op', {
    type: 'setParameterValue',
    symbol: props.symbol.id,
    index,
    value: value === '' ? null : value,
    // An empty field takes text unless it is code; code stays code.
    kind:
      current === '' || PLACEHOLDER_VALUES.has(current) ? 'auto' : 'expression',
  });
}

/** The default is code (a name, a call), not text: shown as such. */
function defaultIsCode(
  param: NonNullable<ScriptSymbol['params']>[number]
): boolean {
  const current = code(param.defaultRange).trim();
  return current !== '' && !PLACEHOLDER_VALUES.has(current);
}

/** Inputs whose details are folded out (UE: collapsed by default). */
const expanded = ref(new Set<string>());

function toggle(name: string): void {
  const next = new Set(expanded.value);
  if (!next.delete(name)) {
    next.add(name);
  }

  expanded.value = next;
}

/** Vector, color and enum defaults get UE's value fields. */
function defaultFields(
  param: NonNullable<ScriptSymbol['params']>[number]
): FieldValue | undefined {
  const value = code(param.defaultRange);
  return value
    ? fieldValue(
        value,
        param.type?.text ?? String(param.dataType),
        props.types,
        props.doc?.symbols ?? [],
        props.text
      )
    : undefined;
}

function setParameterDefault(index: number, value: string): void {
  emit('op', {
    type: 'setParameterValue',
    symbol: props.symbol.id,
    index,
    value,
    kind: 'expression',
  });
}

/**
 * An input of an array type: its default gets UE's array rows, across the
 * whole width with the label in their header.
 */
function isArrayParam(
  param: NonNullable<ScriptSymbol['params']>[number]
): boolean {
  return (
    (param.dataType === 'array' || isArrayType(param.dataType)) &&
    !defaultFields(param)
  );
}

/** How an input's default is edited: the widget follows its type. */
function defaultKind(
  param: NonNullable<ScriptSymbol['params']>[number]
): ValueKind {
  const current = code(param.defaultRange).trim();
  return valueKindOf(
    param.dataType,
    PLACEHOLDER_VALUES.has(current) ? '' : current
  );
}

/** A typed default; an empty number or flag removes it, `''` is text. */
function setTypedDefault(index: number, value: string, kind: ValueKind): void {
  const param = props.symbol.params?.[index];
  const current = code(param?.defaultRange).trim();
  const next = kind === 'string' ? value : value.trim();
  if (kind === 'string' ? stringValue(current) === next : current === next) {
    return;
  }

  emit('op', {
    type: 'setParameterValue',
    symbol: props.symbol.id,
    index,
    value: next === '' && kind !== 'string' ? null : next,
    kind,
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
      <!-- UE's input rows: name, type and remove; the details fold out. -->
      <div
        v-for="(param, index) in symbol.params"
        :key="`${index}:${param.name}`"
        data-ui="parameter-row"
        class="text-xs"
      >
        <div class="flex items-center gap-1 px-1.5 py-0.5">
          <button
            type="button"
            class="btn-ghost shrink-0 px-0.5"
            :aria-expanded="expanded.has(param.name)"
            :aria-label="`Details of ${param.name}`"
            :title="expanded.has(param.name) ? 'Hide details' : 'Show details'"
            @click="toggle(param.name)"
          >
            <span
              class="motion-rotate i-mdi-chevron-down block"
              :class="{ '-rotate-90': !expanded.has(param.name) }"
            />
          </button>
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
          <TypePicker
            class="w-32 shrink-0"
            :value="param.type?.text ?? null"
            :data-type="param.dataType"
            :types="typeInfo"
            :declared="declared"
            :editable="true"
            :required="typeInfo.requiredType !== undefined"
            @change="(typeText) => setParameterType(index, typeText)"
          />
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
        <dl
          v-if="expanded.has(param.name)"
          class="mb-1 ml-5 mr-2 grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1 border-l border-zinc-800 py-1 pl-2"
        >
          <template
            v-if="!typeInfo?.noParameterDefaults && symbol.kind !== 'signal'"
          >
            <dt v-if="!isArrayParam(param)" class="text-zinc-500">
              Default value
            </dt>
            <dd
              v-for="fields in [defaultFields(param)]"
              :key="param.name"
              class="flex min-w-0 items-center gap-1"
              :class="{ 'col-span-2': isArrayParam(param) }"
            >
              <ValueFields
                v-if="fields"
                :value="fields"
                :editable="true"
                :label="`Default value of ${param.name}`"
                @set="(value) => setParameterDefault(index, value)"
              />
              <ArrayDefaultField
                v-else-if="isArrayParam(param)"
                :symbol="symbol"
                :index="index"
                :text="text"
                :editable="true"
                :types="types"
                @op="emit('op', $event)"
              >
                <template #label>
                  <span class="mr-1 w-[6.5rem] shrink-0 text-zinc-500"
                    >Default value</span
                  >
                </template>
                <input
                  class="input w-full py-0.5 font-mono text-xs"
                  :value="code(param.defaultRange)"
                  :aria-label="`Default value of ${param.name}`"
                  spellcheck="false"
                  @keydown.enter.prevent="
                    ($event.target as HTMLInputElement).blur()
                  "
                  @change="setParameterValue(index, $event)"
                />
              </ArrayDefaultField>
              <label
                v-else-if="defaultKind(param) === 'bool'"
                class="flex cursor-pointer items-center gap-1.5 px-1 py-0.5"
              >
                <input
                  type="checkbox"
                  class="accent-amber-500"
                  :checked="/^true$/i.test(code(param.defaultRange))"
                  :aria-label="`Default value of ${param.name}`"
                  @change="
                    setTypedDefault(
                      index,
                      String(($event.target as HTMLInputElement).checked),
                      'bool'
                    )
                  "
                />
                <span class="font-mono text-zinc-300">{{
                  code(param.defaultRange) || 'none'
                }}</span>
              </label>
              <NumberField
                v-else-if="defaultKind(param) === 'number'"
                :value="code(param.defaultRange)"
                :editable="true"
                placeholder="none"
                :label="`Default value of ${param.name}`"
                @commit="(value) => setTypedDefault(index, value, 'number')"
              />
              <input
                v-else-if="defaultKind(param) === 'string'"
                class="input w-full py-0.5 text-xs"
                :value="stringValue(code(param.defaultRange)) ?? ''"
                :placeholder="param.defaultRange ? '' : 'none'"
                :aria-label="`Default value of ${param.name}`"
                spellcheck="false"
                @keydown.enter.prevent="
                  ($event.target as HTMLInputElement).blur()
                "
                @change="
                  setTypedDefault(
                    index,
                    ($event.target as HTMLInputElement).value,
                    'string'
                  )
                "
              />
              <input
                v-else
                class="input w-full py-0.5 font-mono text-xs"
                :value="code(param.defaultRange)"
                placeholder="none"
                :aria-label="`Default value of ${param.name}`"
                spellcheck="false"
                @keydown.enter.prevent="
                  ($event.target as HTMLInputElement).blur()
                "
                @change="setParameterValue(index, $event)"
              />
              <span
                v-if="
                  defaultKind(param) === 'expression' &&
                  !defaultFields(param) &&
                  !isArrayParam(param) &&
                  defaultIsCode(param)
                "
                class="shrink-0 text-[11px] text-zinc-500"
                title="Written as code, as it is: put text in quotes"
                >code</span
              >
            </dd>
          </template>
          <template v-if="param.decorators || decoratesParams">
            <dt class="self-start pt-1 text-zinc-500">Decorators</dt>
            <dd data-ui="parameter-decorators" class="min-w-0">
              <DecoratorList
                :decorators="param.decorators ?? []"
                :editable="decoratesParams"
                :owner="`input ${param.name}`"
                @set="
                  (decorator, text) => setParamDecorator(index, decorator, text)
                "
              />
            </dd>
          </template>
          <dt class="text-zinc-500">Order</dt>
          <dd class="flex gap-1">
            <button
              type="button"
              class="btn-ghost px-1"
              title="Move up"
              :aria-label="`Move ${param.name} up`"
              :disabled="index === 0"
              @click="moveParameter(index, index - 1)"
            >
              <span class="i-mdi-arrow-up" />
            </button>
            <button
              type="button"
              class="btn-ghost px-1"
              title="Move down"
              :aria-label="`Move ${param.name} down`"
              :disabled="index === symbol.params.length - 1"
              @click="moveParameter(index, index + 1)"
            >
              <span class="i-mdi-arrow-down" />
            </button>
          </dd>
        </dl>
      </div>
    </template>
    <template v-else>
      <div
        v-for="param in symbol.params"
        :key="param.name"
        class="flex items-center gap-2 px-3 py-1 text-xs"
      >
        <PinIcon :pin="{ kind: 'data', type: param.dataType }" />
        <span
          v-if="param.decorators"
          data-ui="parameter-decorators"
          class="max-w-28 shrink-0 truncate font-mono text-zinc-500"
          :title="param.decorators.join(' ')"
          >{{ param.decorators.join(' ') }}</span
        >
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
        <PinIcon :pin="{ kind: 'data', type: symbol.returnType ?? 'any' }" />
        <span
          class="font-mono"
          :class="symbol.returns ? 'text-zinc-200' : 'text-zinc-600 italic'"
          >{{ symbol.returns?.text ?? 'not declared' }}</span
        >
      </div>
    </div>
  </DetailsSection>
</template>
