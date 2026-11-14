import type { ColorScheme } from '@vizscript/core';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { registerGDScript } from './gdscript';
import TsWorker from './ts-worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'typescript' || label === 'javascript') {
      return new TsWorker();
    }

    return new EditorWorker();
  },
};

/**
 * Node.js globals in short (`@types/node` is not loaded in the browser):
 * known names, so callbacks like `process.on('exit', (code) => …)` don't
 * report implicit `any` parameters.
 */
const NODE_GLOBALS = `
interface VizNodeProcess {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  platform: string;
  cwd(): string;
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): VizNodeProcess;
  once(event: string, listener: (...args: any[]) => void): VizNodeProcess;
  [key: string]: any;
}
declare var process: VizNodeProcess;
declare var __dirname: string;
declare var __filename: string;
declare var require: (id: string) => any;
declare var module: { exports: any; [key: string]: any };
declare var Buffer: any;
`;

const ts = monaco.typescript;
/** TypeScript's `ModuleResolutionKind.Bundler`. */
const BUNDLER = 100;
const MODULE_RESOLUTION: string = 'moduleResolution';
for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
  defaults.addExtraLib(NODE_GLOBALS, 'file:///vizscript/node-globals.d.ts');
  defaults.setCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    // Bundler: `exports` maps of npm packages and `.js` imports of `.ts`
    // files, like Vite and tsdown. Monaco's enum stops at NodeJs.
    [MODULE_RESOLUTION]: BUNDLER,
    allowNonTsExtensions: true,
    allowJs: true,
    strict: true,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
  });
  defaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // Imports of other repository files cannot be resolved in the browser,
    // and type definitions of Node.js and test runners are not loaded.
    diagnosticCodesToIgnore: [2307, 2580, 2582, 2591, 2592, 2593, 2792, 7016],
  });
}

registerGDScript(monaco);

monaco.editor.defineTheme('vizscript-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'annotation', foreground: 'ffb373' },
    { token: 'comment.doc', foreground: '6a9955', fontStyle: 'italic' },
    { token: 'entity.name.function', foreground: 'dcdcaa' },
    { token: 'variable.predefined', foreground: '63c259' },
  ],
  colors: {
    'editor.background': '#161618',
    'editor.lineHighlightBackground': '#1f1f23',
    'editorGutter.background': '#161618',
  },
});

monaco.editor.defineTheme('vizscript-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'annotation', foreground: 'b05a00' },
    { token: 'comment.doc', foreground: '008000', fontStyle: 'italic' },
    { token: 'entity.name.function', foreground: '795e26' },
    { token: 'variable.predefined', foreground: '267f2f' },
  ],
  colors: {
    'editor.background': '#fafafa',
    'editor.lineHighlightBackground': '#f0f0f2',
    'editorGutter.background': '#fafafa',
  },
});

/** The Monaco theme of a color scheme. */
export function monacoTheme(scheme: ColorScheme): string {
  return scheme === 'light' ? 'vizscript-light' : 'vizscript-dark';
}

export { monaco };
