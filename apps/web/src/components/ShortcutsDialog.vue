<script setup lang="ts">
import { useEventListener } from '@vueuse/core';
import { useTemplateRef, watch } from 'vue';
import { useShortcutsDialog } from '../composables/use-shortcuts-dialog';
import { isMac } from '../graph/source';

/**
 * All mouse and keyboard controls, like VS Code's keyboard shortcuts
 * reference. `{Key}` in an input is shown as a key; `Mod` is ⌘ or Ctrl.
 */
const GROUPS: ReadonlyArray<{
  title: string;
  rows: ReadonlyArray<{ action: string; input: string }>;
}> = [
  {
    title: 'Navigate',
    rows: [
      {
        action: 'Pan',
        input: 'Right or middle drag, {Space} + drag, or two-finger scroll',
      },
      {
        action: 'Zoom',
        input: 'Mouse wheel, {Ctrl} + scroll, pinch, or the zoom controls',
      },
      { action: 'Zoom to selection', input: '{F}' },
      { action: 'Zoom to fit all', input: '{Home}' },
      {
        action: 'Find nodes',
        input: '{Mod}{F}, then {Enter} / {Shift}{Enter} for next / previous',
      },
      { action: 'Jump to code', input: 'Double-click a node' },
      {
        action: 'Edit a variable',
        input: 'Select one of its Get / Set nodes; Details shows the variable',
      },
      {
        action: 'Go to definition',
        input: '{F12} on a call or variable node',
      },
      {
        action: 'Open an imported file',
        input: '{Mod} + click the import in the code',
      },
    ],
  },
  {
    title: 'Select and move',
    rows: [
      { action: 'Select', input: 'Click, or drag a marquee' },
      { action: 'Add to selection', input: '{Shift} + click' },
      { action: 'Toggle selection', input: '{Mod} + click' },
      { action: 'Select a whole function', input: 'Click its frame title' },
      {
        action: 'Move',
        input: 'Drag a node; all selected nodes and reroute points move',
      },
      {
        action: 'Context menu',
        input: 'Right-click a node, pin, wire, frame or empty space',
      },
    ],
  },
  {
    title: 'Edit',
    rows: [
      {
        action: 'Edit a value',
        input: 'Double-click an inline value, or use the Details panel',
      },
      { action: 'Rewire', input: 'Drag from a pin to another pin' },
      {
        action: 'Fill in an argument',
        input: 'Type into the pin of a call, or wire a value into it',
      },
      {
        action: 'Add an argument pin',
        input: 'Right-click a call → Add argument pin',
      },
      {
        action: 'Add an operator or value',
        input: 'Drag a wire into empty space and type (+, ==, join, text …)',
      },
      {
        action: 'Reorder statements',
        input: "Drag an exec output onto another node's exec input",
      },
      {
        action: 'Add a node',
        input: 'Drag a wire into empty space and type, or right-click',
      },
      {
        action: 'Disconnect a wire',
        input: '{Alt} + click a pin (the nodes stay)',
      },
      { action: 'Add a reroute point', input: 'Double-click a wire' },
      { action: 'Remove a reroute point', input: '{Alt} + click it' },
      { action: 'Delete', input: '{Delete} / {Backspace}' },
      { action: 'Save to disk (local folders)', input: '{Mod}{S}' },
      { action: 'Undo', input: '{Mod}{Z}' },
      { action: 'Redo', input: '{Mod}{Shift}{Z}' },
    ],
  },
  {
    title: 'Comments',
    rows: [
      {
        action: 'Comment a node',
        input: 'Double-click its bubble, or right-click → Add comment',
      },
      { action: 'Comment box around selection', input: '{C}' },
      { action: 'Rename a comment box', input: 'Double-click its title' },
    ],
  },
  {
    title: 'Tabs',
    rows: [
      {
        action: 'Open a file',
        input: 'Click it in Explorer (preview tab, in italics)',
      },
      {
        action: 'Keep a tab open',
        input: 'Double-click the file or the tab, or edit the file',
      },
      { action: 'Close a tab', input: 'Its ×, or a middle click' },
      { action: 'Reorder tabs', input: 'Drag a tab' },
      { action: 'More', input: 'Right-click a tab: close others, close all' },
    ],
  },
  {
    title: 'My Script',
    rows: [
      {
        action: 'Show uses / details',
        input: 'Click a function or variable (uses are highlighted)',
      },
      { action: 'Show in graph', input: 'Double-click it, or {Enter}' },
      {
        action: 'Call a function',
        input: 'Drag it into a function of the graph',
      },
      {
        action: 'Get / set a variable',
        input:
          'Drag it into the graph and pick; {Mod} + drag gets, {Alt} + drag sets',
      },
      {
        action: 'Add a function, variable, local or signal',
        input: 'The {+} of its section or class',
      },
      {
        action: 'Edit inputs and output',
        input: 'Select a function; Details lists its inputs and output',
      },
      { action: 'Rename', input: '{F2}, or right-click → Rename' },
      { action: 'Delete', input: '{Delete}, or right-click → Delete' },
    ],
  },
  {
    title: 'Panels',
    rows: [
      { action: 'Problems panel', input: '{Mod}{Shift}{M}' },
      { action: 'Keyboard shortcuts', input: '{?}' },
    ],
  },
];

const KEY_LABELS: Record<string, string> = isMac
  ? { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' }
  : { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Ctrl: 'Ctrl' };

/** Splits an input into text and keys (`{Key}`). */
function parts(input: string): Array<{ key: boolean; text: string }> {
  return input
    .split(/\{([^}]+)\}/)
    .map((text, i) => ({
      key: i % 2 === 1,
      text: i % 2 === 1 ? (KEY_LABELS[text] ?? text) : text,
    }))
    .filter((part) => part.text !== '');
}

const open = useShortcutsDialog();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');

watch(open, (value) => {
  if (value && !dialog.value?.open) {
    dialog.value?.showModal();
  } else if (!value && dialog.value?.open) {
    dialog.value.close();
  }
});

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (
    event.key === '?' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isTyping(event.target)
  ) {
    event.preventDefault();
    open.value = !open.value;
  }
});
</script>

<template>
  <dialog
    ref="dialog"
    data-ui="shortcuts-dialog"
    class="m-auto w-[min(640px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 p-0 text-sm text-zinc-200 shadow-2xl backdrop:bg-black/50"
    aria-labelledby="shortcuts-title"
    @close="open = false"
    @click.self="open = false"
  >
    <div class="flex max-h-[min(720px,calc(100vh-4rem))] flex-col">
      <header
        class="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 py-3"
      >
        <span class="i-mdi-keyboard-outline text-zinc-400" />
        <h2 id="shortcuts-title" class="flex-1 font-semibold text-zinc-100">
          Keyboard shortcuts
        </h2>
        <button
          type="button"
          class="btn-ghost px-2"
          aria-label="Close"
          @click="open = false"
        >
          <span class="i-mdi-close" />
        </button>
      </header>
      <div class="min-h-0 overflow-y-auto px-4 pb-4">
        <section v-for="group in GROUPS" :key="group.title">
          <h3
            class="pt-4 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase"
          >
            {{ group.title }}
          </h3>
          <dl class="divide-y divide-zinc-800">
            <div
              v-for="row in group.rows"
              :key="row.action"
              class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 py-1.5"
            >
              <dt class="text-zinc-300">{{ row.action }}</dt>
              <dd class="text-zinc-400">
                <template v-for="(part, i) in parts(row.input)" :key="i">
                  <kbd
                    v-if="part.key"
                    class="mx-0.5 inline-block min-w-5 rounded border border-zinc-700 border-b-2 bg-zinc-800 px-1 text-center font-sans text-xs text-zinc-200"
                    >{{ part.text }}</kbd
                  >
                  <template v-else>{{ part.text }}</template>
                </template>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  </dialog>
</template>
