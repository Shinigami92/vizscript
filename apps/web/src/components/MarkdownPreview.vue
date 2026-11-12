<script setup lang="ts">
import { refDebounced } from '@vueuse/core';
import { computed, nextTick, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTheme } from '../composables/use-theme';
import { monacoLanguage } from '../graph/languages';
import type { RepoLocation } from '../markdown/links';
import { resolveImage, resolveLink } from '../markdown/links';
import { renderMarkdown } from '../markdown/render';
import { monaco, monacoTheme } from '../monaco/setup';

const props = defineProps<{
  text: string;
  path: string;
  /** First visible line of the code editor (fractional), for scroll sync. */
  syncLine?: number | null;
}>();

const emit = defineEmits<{
  /** Double-click in the preview: show this source line in the editor. */
  revealLine: [line: number];
}>();

const route = useRoute();
const router = useRouter();
const { scheme } = useTheme();
const root = useTemplateRef<HTMLDivElement>('root');

const repo = computed<RepoLocation | undefined>(() => {
  const { provider, owner, repo: name, ref } = route.params;
  return typeof provider === 'string' &&
    typeof owner === 'string' &&
    typeof name === 'string' &&
    typeof ref === 'string'
    ? { provider, owner, repo: name, ref }
    : undefined;
});

// Typing in the editor re-renders at most a few times per second.
const source = refDebounced(
  computed(() => props.text),
  150
);
const html = computed(() =>
  renderMarkdown(source.value, {
    resolveLink: (href) => resolveLink(props.path, href, repo.value),
    resolveImage: (src) => resolveImage(props.path, src, repo.value),
  })
);

/** Highlights fenced code blocks with Monaco (same colors as the editor). */
async function colorize(): Promise<void> {
  await nextTick();
  const blocks = root.value?.querySelectorAll<HTMLElement>(
    'pre > code[class*="language-"]'
  );
  for (const code of blocks ?? []) {
    const lang = code.className.match(/language-([\w+#-]+)/)?.[1] ?? '';
    const id = monacoLanguage(`file.${lang}`);
    const known = monaco.languages.getLanguages().some((l) => l.id === lang);
    const language = known ? lang : id;
    if (language === 'plaintext') {
      continue;
    }

    // The fence's trailing newline would become an empty last line.
    code.textContent = (code.textContent ?? '').replace(/\n$/, '');
    code.dataset.lang = language;
    // Without an explicit theme Monaco switches every editor to the default.
    await monaco.editor.colorizeElement(code, {
      tabSize: 2,
      theme: monacoTheme(scheme.value),
    });
  }
}

watch(html, () => void colorize(), { immediate: true });

function scrollToAnchor(id: string): void {
  const target = root.value?.querySelector(`[id="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function onClick(event: MouseEvent): void {
  const link = (event.target as HTMLElement).closest('a');
  const href = link?.getAttribute('href');
  if (!link || !href) {
    return;
  }

  if (href.startsWith('#')) {
    event.preventDefault();
    scrollToAnchor(decodeURIComponent(href.slice(1)));
  } else if (link.dataset.internal === 'true') {
    event.preventDefault();
    void router.push(href);
  }
}

function onDoubleClick(event: MouseEvent): void {
  const block = (event.target as HTMLElement).closest<HTMLElement>(
    '[data-line]'
  );
  const line = Number(block?.dataset.line);
  if (Number.isFinite(line) && line > 0) {
    emit('revealLine', line);
  }
}

// Scroll sync (editor → preview), interpolating between source blocks.
watch(
  () => props.syncLine,
  (line) => {
    const container = root.value;
    if (!container || line === null || line === undefined) {
      return;
    }

    const blocks = [
      ...container.querySelectorAll<HTMLElement>('[data-line]'),
    ].filter((el) => el.offsetParent !== null);
    let before: HTMLElement | undefined;
    let after: HTMLElement | undefined;
    for (const block of blocks) {
      if (Number(block.dataset.line) <= line) {
        before = block;
      } else {
        after = block;
        break;
      }
    }

    if (line <= 1 || !before) {
      container.scrollTop = 0;
      return;
    }

    const top = (el: HTMLElement): number =>
      el.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    const startLine = Number(before.dataset.line);
    const endLine = after ? Number(after.dataset.line) : startLine + 1;
    const fraction = Math.min(
      1,
      Math.max(0, (line - startLine) / Math.max(1, endLine - startLine))
    );
    const from = top(before);
    const to = after ? top(after) : from + before.offsetHeight;
    container.scrollTop = from + (to - from) * fraction - 8;
  }
);
</script>

<template>
  <div
    ref="root"
    class="markdown-preview h-full overflow-y-auto bg-zinc-950"
    @click="onClick"
    @dblclick="onDoubleClick"
  >
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized by DOMPurify -->
    <article class="markdown-body mx-auto max-w-3xl px-8 py-6" v-html="html" />
  </div>
</template>

<style>
.markdown-body {
  color: var(--colors-zinc-300);
  font-size: 15px;
  line-height: 1.65;
  overflow-wrap: break-word;
}

.markdown-body > :first-child {
  margin-top: 0;
}

.markdown-body :is(h1, h2, h3, h4, h5, h6) {
  color: var(--colors-zinc-100);
  font-weight: 600;
  line-height: 1.25;
  margin: 1.6em 0 0.6em;
  scroll-margin-top: 1rem;
}

.markdown-body h1 {
  font-size: 2em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--colors-zinc-800);
}

.markdown-body h2 {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--colors-zinc-800);
}

.markdown-body h3 {
  font-size: 1.25em;
}

.markdown-body :is(p, ul, ol, blockquote, pre, table, details) {
  margin: 0 0 1em;
}

.markdown-body :is(ul, ol) {
  padding-left: 2em;
}

.markdown-body ul {
  list-style: disc;
}

.markdown-body ol {
  list-style: decimal;
}

.markdown-body li + li {
  margin-top: 0.25em;
}

.markdown-body li.task-list-item {
  list-style: none;
}

.markdown-body li.task-list-item input {
  margin: 0 0.4em 0.2em -1.4em;
  vertical-align: middle;
}

.markdown-body a {
  color: var(--colors-sky-300);
  text-decoration: none;
}

.markdown-body a:hover {
  text-decoration: underline;
}

.markdown-body code {
  font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace;
  font-size: 0.85em;
  background: var(--colors-zinc-800);
  border-radius: 4px;
  padding: 0.15em 0.4em;
}

.markdown-body pre {
  background: var(--colors-zinc-900);
  border: 1px solid var(--colors-zinc-800);
  border-radius: 6px;
  padding: 0.9em 1em;
  overflow-x: auto;
  line-height: 1.45;
}

.markdown-body pre code {
  background: none;
  padding: 0;
  font-size: 0.85em;
}

.markdown-body blockquote {
  border-left: 4px solid var(--colors-zinc-700);
  color: var(--colors-zinc-400);
  padding: 0 1em;
}

.markdown-body hr {
  border: 0;
  border-top: 1px solid var(--colors-zinc-700);
  margin: 1.5em 0;
}

.markdown-body table {
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}

.markdown-body :is(th, td) {
  border: 1px solid var(--colors-zinc-700);
  padding: 0.4em 0.8em;
}

.markdown-body th {
  background: var(--colors-zinc-900);
  font-weight: 600;
}

.markdown-body img {
  max-width: 100%;
  display: inline-block;
}

.markdown-body kbd {
  border: 1px solid var(--colors-zinc-600);
  border-bottom-width: 2px;
  border-radius: 4px;
  font-size: 0.85em;
  padding: 0.05em 0.35em;
}
</style>
