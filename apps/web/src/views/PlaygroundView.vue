<script setup lang="ts">
import { useStorage } from '@vueuse/core';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ScriptWorkspace from '../components/ScriptWorkspace.vue';
import { localLayoutStore } from '../graph/layout-store';
import Workbench from '../workbench/Workbench.vue';
import { SAMPLES } from './playground-samples';

const route = useRoute();
const router = useRouter();
const lastSample = useStorage('vizscript:playground:sample', 'greeter.ts');

function isSample(name: unknown): name is string {
  return typeof name === 'string' && SAMPLES.some((s) => s.name === name);
}

// The sample is part of the URL (`?sample=…`) so a shared or reloaded
// link shows the same sample; switching drops the `view` of the old one.
const sampleName = computed({
  get: () =>
    isSample(route.query.sample)
      ? route.query.sample
      : isSample(lastSample.value)
        ? lastSample.value
        : 'greeter.ts',
  set: (name: string) => {
    lastSample.value = name;
    void router.replace({ query: { sample: name } });
  },
});

if (!isSample(route.query.sample)) {
  void router.replace({ query: { ...route.query, sample: sampleName.value } });
}
const texts = useStorage<Record<string, string>>(
  'vizscript:playground:texts',
  {}
);
const version = ref(0);

function textFor(name: string): string {
  return texts.value[name] ?? SAMPLES.find((s) => s.name === name)?.text ?? '';
}

function update(value: string): void {
  texts.value = { ...texts.value, [sampleName.value]: value };
}

async function reset(): Promise<void> {
  const next = { ...texts.value };
  delete next[sampleName.value];
  texts.value = next;
  try {
    localStorage.removeItem(`vizscript:layout:playground:${sampleName.value}`);
    // Cameras of earlier resets (the version counter restarts on reload).
    const cameras = `vizscript:camera:playground:${sampleName.value}:`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(cameras)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore
  }

  // Drop the view first: the new workspace reads it when it mounts.
  await router.replace({ query: { sample: sampleName.value } });
  version.value++;
}
</script>

<template>
  <Workbench>
    <ScriptWorkspace
      :key="`${sampleName}:${version}`"
      :path="sampleName"
      :text="textFor(sampleName)"
      :base-text="SAMPLES.find((s) => s.name === sampleName)?.text"
      :layout-store="localLayoutStore(`playground:${sampleName}`)"
      :state-key="`playground:${sampleName}:${version}`"
      @update:text="update"
    >
      <template #toolbar>
        <span class="i-mdi-flask-outline text-amber-400" />
        <select
          v-model="sampleName"
          class="bg-transparent font-mono text-xs text-zinc-200 outline-none"
        >
          <option
            v-for="sample in SAMPLES"
            :key="sample.name"
            :value="sample.name"
          >
            {{ sample.name }}
          </option>
        </select>
        <button
          type="button"
          class="btn-ghost px-2 text-xs"
          title="Reset sample and layout"
          @click="reset"
        >
          <span class="i-mdi-restore" /><span class="hidden sm:inline"
            >Reset</span
          >
        </button>
      </template>
    </ScriptWorkspace>
  </Workbench>
</template>
