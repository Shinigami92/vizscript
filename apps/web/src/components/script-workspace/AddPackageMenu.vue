<script setup lang="ts">
import type { PackageSearchResult } from '@vizscript/api-contract';
import type {
  DependencyKind,
  GraphOp,
  ProjectDependency,
  ScriptSymbol,
} from '@vizscript/core';
import { useDebounceFn } from '@vueuse/core';
import { computed, onMounted, ref, shallowRef } from 'vue';
import { useToasts } from '../../composables/use-toasts';
import {
  defaultKind,
  ecosystemOf,
  installCommand,
  kindLabel,
  kindsOf,
  libraryImport,
  listedVersion,
  manifestEdit,
  manifestFor,
  sameLibrary,
} from '../../graph/add-package';
import { projectDependencies } from '../../graph/project-dependencies';
import { SYMBOL_ICONS } from '../../graph/symbols';
import type { ActionEntry } from '../ActionMenu.vue';
import ActionMenu from '../ActionMenu.vue';

/**
 * "+" in My Script's Imports: search a library in the language's registry
 * (through the server), pick what to import from it, and how the manifest
 * lists it. Writes the import into the file and the dependency into the
 * manifest (an open tab with unsaved changes), one undo step for both.
 */
const props = defineProps<{
  at: { x: number; y: number };
  path: string;
  files: ReadonlySet<string> | undefined;
  /** Reads a project file (the manifests that list the libraries). */
  readFile?: (path: string) => Promise<string>;
  /**
   * Changes the manifest and writes the import (one undo step). A
   * function, not an event: the menu closes (and unmounts) while the
   * manifest is still being changed.
   */
  addLibrary: (
    manifest: string,
    edit: (text: string) => string,
    op?: GraphOp
  ) => Promise<boolean>;
  /** A library's module as code names it and its exports. */
  offer: (
    name: string,
    version: string
  ) => Promise<{ module: string; exports: ScriptSymbol[] }>;
  /**
   * Only list this library in the manifest (an import's "not listed"
   * warning: the import is there already).
   */
  listOnly?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const toasts = useToasts();
const ecosystem = computed(() => ecosystemOf(props.path));
const manifest = computed(() => manifestFor(props.files, props.path));
const manifestName = computed(
  () => manifest.value?.split('/').at(-1) ?? 'the manifest'
);

const query = ref('');
const results = shallowRef<PackageSearchResult[]>([]);
const searching = ref(false);
const failed = ref(false);
/** Libraries the project lists already (imported in their version). */
const listed = shallowRef<ReadonlyArray<ProjectDependency>>([]);
const picked = shallowRef<{
  result: PackageSearchResult;
  /** The manifest lists it already: only the import is written. */
  listed?: boolean;
  module: string;
  exports: ScriptSymbol[];
  /** Its exports are still being read (big type packages take a while). */
  reading: boolean;
} | null>(null);
const kind = ref<DependencyKind>('runtime');
/** A new key opens the menu again (after picking a library or a kind). */
const menuKey = ref(0);
let reopen = false;

const search = useDebounceFn(async (text: string) => {
  const target = ecosystem.value;
  if (!target || text === '') {
    results.value = [];
    searching.value = false;
    return;
  }

  try {
    const response = await fetch(
      `/api/types/search?ecosystem=${target}&q=${encodeURIComponent(text)}`
    );
    if (query.value === text) {
      failed.value = !response.ok;
      results.value = response.ok
        ? ((await response.json()) as PackageSearchResult[])
        : [];
    }
  } catch {
    failed.value = true;
  } finally {
    if (query.value === text) {
      searching.value = false;
    }
  }
}, 300);

function onQuery(text: string): void {
  if (picked.value) {
    return;
  }

  query.value = text;
  searching.value = text !== '';
  void search(text);
}

/** How code names a library's module before its files are read. */
function guessModule(name: string): string {
  return ecosystem.value === 'npm'
    ? name
    : name.toLowerCase().replaceAll('-', '_');
}

/** How the project lists a library from the registry, if it does. */
function listing(name: string): ProjectDependency | undefined {
  const target = ecosystem.value;
  return target
    ? listed.value.find((d) => !d.local && sameLibrary(target, d.name, name))
    : undefined;
}

/** The version a listed library is used in, else the registry's latest. */
function versionOf(result: PackageSearchResult): string {
  const dependency = listing(result.name);
  return (dependency && listedVersion(dependency)) ?? result.version;
}

/**
 * Shows the library's choices at once (the whole module, the kinds); its
 * named exports follow when read.
 */
async function pick(found: PackageSearchResult): Promise<void> {
  reopen = true;
  const dependency = listing(found.name);
  const result = { ...found, version: versionOf(found) };
  kind.value = dependency?.kind ?? defaultKind(props.path, result.name);
  if (props.listOnly) {
    picked.value = { result, module: '', exports: [], reading: false };
    return;
  }

  const current = {
    result,
    ...(dependency ? { listed: true } : {}),
    module: guessModule(result.name),
    exports: [],
    reading: true,
  };
  picked.value = current;
  const offer = await props
    .offer(result.name, result.version)
    .catch(() => ({ module: current.module, exports: [] }));
  if (picked.value === current) {
    picked.value = { ...current, ...offer, reading: false };
  }
}

/** List-only: the library looked up by its exact name, picked when found. */
async function lookUp(name: string): Promise<void> {
  query.value = name;
  searching.value = true;
  await search(name);
  const exact = results.value.find(
    (r) => ecosystem.value && sameLibrary(ecosystem.value, r.name, name)
  );
  if (exact) {
    kind.value = defaultKind(props.path, exact.name);
    picked.value = { result: exact, module: '', exports: [], reading: false };
  }
}

/** Reads the libraries the project lists (none when it can't). */
async function readListed(): Promise<void> {
  try {
    listed.value = await projectDependencies(
      props.files,
      props.readFile,
      props.path
    );
  } catch {
    listed.value = [];
  }
}

onMounted(() => {
  void readListed();
  if (props.listOnly) {
    void lookUp(props.listOnly);
  }
});

/** Writes the dependency into the manifest only. */
async function list(as: DependencyKind): Promise<void> {
  const chosen = picked.value;
  const target = manifest.value;
  if (!chosen || !target) {
    return;
  }

  const { name, version } = chosen.result;
  let changed: boolean;
  try {
    changed = await props.addLibrary(
      target,
      manifestEdit(target, name, version, as)
    );
  } catch {
    toasts.show(`${manifestName.value} could not be read.`, 'error');
    return;
  }

  toasts.show(
    changed
      ? addedMessage(name, version, target)
      : `${target} lists ${name} already.`
  );
}

function addedMessage(name: string, version: string, target: string): string {
  return `Added ${name} ${version} to ${target} (unsaved). Run \`${installCommand(props.files, target)}\` to update the lockfile.`;
}

async function add(imported: string | undefined): Promise<void> {
  const chosen = picked.value;
  const target = manifest.value;
  if (!chosen || !target) {
    return;
  }

  const { name, version } = chosen.result;
  let changed: boolean;
  try {
    changed = await props.addLibrary(
      target,
      manifestEdit(target, name, version, kind.value),
      {
        type: 'addImport',
        import: libraryImport(props.path, chosen.module, imported),
      }
    );
  } catch {
    toasts.show(`${manifestName.value} could not be read.`, 'error');
    return;
  }

  // A library the manifest lists already only gets its import.
  if (changed) {
    toasts.show(addedMessage(name, version, target));
  }
}

/** A module re-exported as one name (`export * as z`). */
function isNamespace(symbol: ScriptSymbol): boolean {
  return symbol.modifiers.includes('namespace');
}

const SHOWN_KINDS = new Set([
  'function',
  'class',
  'type',
  'enum',
  'variable',
  'constant',
]);

const entries = computed((): ActionEntry[] => {
  const chosen = picked.value;
  if (!chosen) {
    if (!manifest.value) {
      return [
        {
          label: `No ${ecosystem.value === 'npm' ? 'package.json' : ecosystem.value === 'crates' ? 'Cargo.toml' : 'pyproject.toml'} above this file`,
          category: '',
          disabled:
            'A library is listed in the project’s manifest; this file has none.',
          action: () => undefined,
        },
      ];
    }

    if (query.value === '') {
      const registry =
        ecosystem.value === 'npm'
          ? 'npm'
          : ecosystem.value === 'crates'
            ? 'crates.io'
            : 'PyPI (by its exact name)';
      return [
        {
          label: `Type a library’s name to search ${registry}`,
          category: '',
          disabled: `It is added to ${manifest.value}`,
          action: () => undefined,
        },
      ];
    }

    return results.value.map((result) => ({
      label: result.name,
      category: 'Libraries',
      icon: 'i-mdi-package-variant-closed text-amber-400',
      hint: listing(result.name)
        ? `${versionOf(result)} · listed`
        : result.version,
      // Found by the registry, so always kept by the menu's own search.
      keywords: query.value,
      ...(result.description ? { detail: result.description } : {}),
      action: () => void pick(result),
    }));
  }

  const target = ecosystem.value;
  if (props.listOnly && target) {
    // Suggested kind first; one click writes it.
    return kindsOf(target)
      .toSorted((a, b) => Number(b === kind.value) - Number(a === kind.value))
      .map((option) => ({
        label: kindLabel(target, option),
        category: `Add ${chosen.result.name} ${chosen.result.version} to ${manifestName.value} as`,
        icon:
          option === kind.value
            ? 'i-mdi-plus text-amber-400'
            : 'i-mdi-plus text-zinc-500',
        ...(option === kind.value ? { hint: 'suggested' } : {}),
        action: () => void list(option),
      }));
  }

  const imports: ActionEntry[] = [
    {
      label: chosen.module,
      category: 'Import',
      icon: 'i-mdi-file-import-outline',
      hint: 'whole module',
      keywords: 'all module namespace',
      action: () => void add(undefined),
    },
    ...(chosen.reading
      ? [
          {
            label: `Reading what ${chosen.result.name} exports…`,
            category: 'Import',
            icon: 'i-mdi-loading animate-spin text-zinc-500',
            disabled:
              'Big type packages take a while; the whole module can be imported already.',
            action: () => undefined,
          },
        ]
      : []),
    // Namespaces first (zod's `z`); their members are reached through them.
    ...chosen.exports
      .filter((symbol) => symbol.scope === '' && SHOWN_KINDS.has(symbol.kind))
      .toSorted((a, b) => Number(isNamespace(b)) - Number(isNamespace(a)))
      .map((symbol): ActionEntry => ({
        label: symbol.name,
        category: 'Import',
        icon: isNamespace(symbol)
          ? 'i-mdi-file-import-outline'
          : SYMBOL_ICONS[symbol.kind],
        hint: isNamespace(symbol) ? 'namespace' : symbol.kind,
        action: () => void add(symbol.name),
      })),
  ];
  const kinds: ActionEntry[] =
    target && !chosen.listed
      ? kindsOf(target).map((option) => ({
          label: kindLabel(target, option),
          category: `List in ${manifestName.value} as`,
          icon:
            option === kind.value
              ? 'i-mdi-check text-amber-400'
              : 'i-mdi-circle-small text-zinc-500',
          action: () => {
            kind.value = option;
            reopen = true;
          },
        }))
      : [];
  return [...imports, ...kinds];
});

const title = computed(() => {
  const chosen = picked.value;
  if (props.listOnly) {
    return `Add ${props.listOnly} to ${manifestName.value}`;
  }

  if (!chosen) {
    return 'Add a library';
  }

  const { name, version } = chosen.result;
  return chosen.listed
    ? `Import from ${name} ${version}`
    : `Add ${name} ${version}`;
});

function suggest(): ActionEntry[] {
  return !picked.value && query.value !== '' && results.value.length === 0
    ? [
        {
          label: searching.value
            ? 'Searching…'
            : failed.value
              ? 'The registry is not reachable'
              : 'No library found',
          category: '',
          disabled: searching.value
            ? 'Asking the registry'
            : 'Try another name',
          action: () => undefined,
        },
      ]
    : [];
}

function onClose(): void {
  if (reopen) {
    reopen = false;
    menuKey.value++;
    return;
  }

  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <ActionMenu
      :key="menuKey"
      :x="at.x"
      :y="at.y"
      :title="title"
      :entries="entries"
      :suggest="suggest"
      @query="onQuery"
      @close="onClose"
    />
  </Teleport>
</template>
