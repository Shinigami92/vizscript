<script setup lang="ts">
import type { Diagnostic, SourceRange, TextEdit } from '@vizscript/core';
import {
  onBeforeUnmount,
  onMounted,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue';
import { useTheme } from '../composables/use-theme';
import { monacoLanguage } from '../graph/languages';
import type { Problem, ProblemSeverity } from '../graph/problems';
import type { FileLinkSource } from '../monaco/file-links';
import { registerFileLinks } from '../monaco/file-links';
import { modelUri, saveViewState, viewStateOf } from '../monaco/models';
import { monaco, monacoTheme } from '../monaco/setup';

const props = defineProps<{
  path: string;
  value: string;
  readOnly?: boolean;
  /** Referenced files that open on Ctrl/Cmd+click. */
  links?: FileLinkSource;
  /** Parser problems to show as markers (languages without a checker). */
  diagnostics?: ReadonlyArray<Diagnostic>;
  /**
   * Keep the model (and its undo history) and the view state when the
   * editor goes away, for files open in tabs.
   */
  keepModel?: boolean;
}>();

export interface EditorHistory {
  canUndo: boolean;
  canRedo: boolean;
  /** Monaco's alternative version id: undo/redo return to earlier values. */
  version: number;
}

const emit = defineEmits<{
  change: [value: string];
  cursor: [offset: number];
  history: [history: EditorHistory];
  /** First visible line (fractional) while scrolling, for scroll sync. */
  scrollLine: [line: number];
  /** All markers of the file (type checker, parser), as problems. */
  problems: [problems: Problem[]];
}>();

const MARKER_OWNER = 'vizscript';

function severityOf(severity: monaco.MarkerSeverity): ProblemSeverity {
  if (severity === monaco.MarkerSeverity.Error) {
    return 'error';
  }

  return severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info';
}

function emitProblems(): void {
  const m = model;
  if (!m || m.isDisposed()) {
    return;
  }

  const markers = monaco.editor
    .getModelMarkers({ resource: m.uri })
    .filter((marker) => marker.severity !== monaco.MarkerSeverity.Hint);
  emit(
    'problems',
    markers.map((marker) => ({
      message: marker.message,
      severity: severityOf(marker.severity),
      range: {
        start: m.getOffsetAt({
          lineNumber: marker.startLineNumber,
          column: marker.startColumn,
        }),
        end: m.getOffsetAt({
          lineNumber: marker.endLineNumber,
          column: marker.endColumn,
        }),
      },
      line: marker.startLineNumber,
      column: marker.startColumn,
      source:
        marker.owner === MARKER_OWNER
          ? 'parser'
          : (marker.source ?? marker.owner),
      code: typeof marker.code === 'string' ? marker.code : marker.code?.value,
    }))
  );
}

function setParserMarkers(diagnostics: ReadonlyArray<Diagnostic>): void {
  const m = model;
  if (!m || m.isDisposed()) {
    return;
  }

  monaco.editor.setModelMarkers(
    m,
    MARKER_OWNER,
    diagnostics.map((d) => {
      const start = m.getPositionAt(d.range.start);
      const end = m.getPositionAt(Math.max(d.range.end, d.range.start + 1));
      return {
        message: d.message,
        severity:
          d.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : monaco.MarkerSeverity.Warning,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
    })
  );
}

const container = useTemplateRef<HTMLDivElement>('container');
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>();
let model: monaco.editor.ITextModel | undefined;
let selected: monaco.editor.IEditorDecorationsCollection | undefined;
let hovered: monaco.editor.IEditorDecorationsCollection | undefined;
let suppressChange = false;
let unregisterLinks: (() => void) | undefined;
let markerListener: monaco.IDisposable | undefined;

function toRange(range: SourceRange): monaco.Range {
  const m = model as monaco.editor.ITextModel;
  const start = m.getPositionAt(range.start);
  const end = m.getPositionAt(range.end);
  return new monaco.Range(
    start.lineNumber,
    start.column,
    end.lineNumber,
    end.column
  );
}

const { scheme } = useTheme();
// Monaco has one theme for all editors.
watch(scheme, (value) => monaco.editor.setTheme(monacoTheme(value)));

onMounted(() => {
  const uri = modelUri(props.path);
  const existing = monaco.editor.getModel(uri);
  if (props.keepModel && existing) {
    // A tab shown again: same model, same undo history.
    model = existing;
    if (model.getValue() !== props.value) {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: props.value }],
        () => null
      );
    }
  } else {
    existing?.dispose();
    model = monaco.editor.createModel(
      props.value,
      monacoLanguage(props.path),
      uri
    );
  }

  unregisterLinks = registerFileLinks(model, {
    links: (text) => props.links?.links(text) ?? Promise.resolve([]),
    open: (path, symbol) => props.links?.open(path, symbol),
  });
  editor.value = monaco.editor.create(container.value as HTMLDivElement, {
    model,
    theme: monacoTheme(scheme.value),
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
    minimap: { enabled: true, renderCharacters: false },
    scrollBeyondLastLine: false,
    readOnly: props.readOnly,
    smoothScrolling: true,
    tabSize: 2,
  });
  markerListener = monaco.editor.onDidChangeMarkers((changed) => {
    if (
      model &&
      changed.some((resource) => resource.toString() === model?.uri.toString())
    ) {
      emitProblems();
    }
  });
  const viewState = props.keepModel ? viewStateOf(props.path) : undefined;
  if (viewState) {
    editor.value.restoreViewState(viewState);
  }

  setParserMarkers(props.diagnostics ?? []);
  emitProblems();
  selected = editor.value.createDecorationsCollection();
  hovered = editor.value.createDecorationsCollection();

  const emitHistory = (): void => {
    if (model) {
      emit('history', {
        canUndo: model.canUndo(),
        canRedo: model.canRedo(),
        version: model.getAlternativeVersionId(),
      });
    }
  };

  emitHistory();
  model.onDidChangeContent(() => {
    if (!suppressChange) {
      emit('change', model?.getValue() ?? '');
    }

    // The undo stack is updated after the content event.
    queueMicrotask(emitHistory);
  });
  editor.value.onDidScrollChange((event) => {
    const ed = editor.value;
    if (!ed || !event.scrollTopChanged) {
      return;
    }

    const first = ed.getVisibleRanges()[0]?.startLineNumber ?? 1;
    const lineTop = ed.getTopForLineNumber(first);
    const lineHeight = ed.getOption(monaco.editor.EditorOption.lineHeight);
    emit('scrollLine', first + (event.scrollTop - lineTop) / lineHeight);
  });
  editor.value.onDidChangeCursorPosition((event) => {
    if (event.source === 'api' || event.source === 'modelChange') {
      return;
    }

    emit('cursor', model?.getOffsetAt(event.position) ?? 0);
  });
});

watch(
  () => props.value,
  (value) => {
    if (model && value !== model.getValue()) {
      suppressChange = true;
      // Keep undo history: replace through an edit operation.
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: value }],
        () => null
      );
      suppressChange = false;
    }
  }
);

watch(
  () => props.diagnostics,
  (diagnostics) => setParserMarkers(diagnostics ?? [])
);

watch(
  () => props.readOnly,
  (readOnly) => editor.value?.updateOptions({ readOnly })
);

onBeforeUnmount(() => {
  unregisterLinks?.();
  markerListener?.dispose();
  if (props.keepModel) {
    saveViewState(props.path, editor.value?.saveViewState() ?? null);
  }

  editor.value?.dispose();
  if (!props.keepModel) {
    model?.dispose();
  }
});

defineExpose({
  /** Applies graph edits as one undoable step. */
  applyEdits(edits: ReadonlyArray<TextEdit>): void {
    if (!model || !editor.value) {
      return;
    }

    editor.value.pushUndoStop();
    model.pushEditOperations(
      [],
      edits.map((e) => ({ range: toRange(e), text: e.text })),
      () => null
    );
    editor.value.pushUndoStop();
  },
  setSelectedRanges(ranges: ReadonlyArray<SourceRange>): void {
    if (!model) {
      return;
    }

    selected?.set(
      ranges.map((r) => ({
        range: toRange(r),
        options: {
          className: 'vz-code-selected',
          isWholeLine: false,
          overviewRuler: {
            color: '#f5a623',
            position: monaco.editor.OverviewRulerLane.Center,
          },
        },
      }))
    );
  },
  setHoveredRanges(ranges: ReadonlyArray<SourceRange>): void {
    if (!model) {
      return;
    }

    hovered?.set(
      ranges.map((r) => ({
        range: toRange(r),
        options: { className: 'vz-code-hover' },
      }))
    );
  },
  reveal(range: SourceRange, focus = false): void {
    if (!model || !editor.value) {
      return;
    }

    // Jumps (focus) are immediate, so they also end a running smooth scroll.
    editor.value.revealRangeInCenterIfOutsideViewport(
      toRange(range),
      focus
        ? monaco.editor.ScrollType.Immediate
        : monaco.editor.ScrollType.Smooth
    );
    if (focus) {
      editor.value.setSelection(
        toRange({ start: range.start, end: range.start })
      );
      editor.value.focus();
    }
  },
  /**
   * Scrolls to and focuses a 1-based line. `immediate` also stops a running
   * smooth scroll (e.g. one started by selecting nodes).
   */
  revealLine(line: number, immediate = false): void {
    if (!editor.value) {
      return;
    }

    if (immediate) {
      // A fixed gap of a few lines: "near top" depends on the editor height,
      // which a freshly shown editor may not know yet.
      const lineHeight = editor.value.getOption(
        monaco.editor.EditorOption.lineHeight
      );
      editor.value.setScrollTop(
        Math.max(0, editor.value.getTopForLineNumber(line) - 3 * lineHeight),
        monaco.editor.ScrollType.Immediate
      );
    } else {
      editor.value.revealLineNearTop(line, monaco.editor.ScrollType.Smooth);
    }

    editor.value.setPosition({ lineNumber: line, column: 1 });
    editor.value.focus();
  },
  undo(): void {
    editor.value?.trigger('vizscript', 'undo', null);
  },
  redo(): void {
    editor.value?.trigger('vizscript', 'redo', null);
  },
  layout(): void {
    editor.value?.layout();
  },
});
</script>

<template>
  <div ref="container" class="h-full w-full" />
</template>

<style>
.vz-code-selected {
  background: rgba(245, 166, 35, 0.22);
  border-radius: 2px;
}

/* Like VS Code: links are only underlined while Ctrl/Cmd is held. */
.monaco-editor .detected-link {
  text-decoration: none;
}

.monaco-editor .detected-link-active {
  text-decoration: underline;
}

.vz-code-hover {
  background: rgba(56, 189, 248, 0.16);
  border-radius: 2px;
}
</style>
