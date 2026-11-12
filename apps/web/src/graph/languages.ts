/** Extensions handled by a language backend (see `registry.ts`). */
const SUPPORTED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.gd',
  '.py',
  '.pyw',
];

export function isVisualizable(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    !lower.endsWith('.d.ts') &&
    SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
  );
}

/** Backend of a file: files of one language can import each other. */
export function languageOf(
  path: string
): 'typescript' | 'python' | 'gdscript' | undefined {
  const lower = path.toLowerCase();
  if (!isVisualizable(path)) {
    return undefined;
  }

  if (lower.endsWith('.gd')) {
    return 'gdscript';
  }

  return lower.endsWith('.py') || lower.endsWith('.pyw')
    ? 'python'
    : 'typescript';
}

/** Monaco language id for a file path. */
export function monacoLanguage(path: string): string {
  const lower = path.toLowerCase();
  if (/\.[cm]?tsx?$/.test(lower)) {
    return 'typescript';
  }

  if (/\.[cm]?jsx?$/.test(lower)) {
    return 'javascript';
  }

  const map: Record<string, string> = {
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    vue: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    gd: 'gdscript',
    py: 'python',
    pyw: 'python',
    pyi: 'python',
    rb: 'ruby',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    java: 'java',
    sh: 'shell',
    sql: 'sql',
    xml: 'xml',
  };
  return map[lower.split('.').pop() ?? ''] ?? 'plaintext';
}

/** Files with a rendered preview (shown next to the code like a graph). */
export function isPreviewable(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

/** Icon classes of a file, by its language. */
export function fileIcon(path: string): string {
  if (/\.tsx?$|\.mts$|\.cts$/.test(path)) {
    return 'i-mdi-language-typescript text-sky-400';
  }

  if (/\.[cm]?jsx?$/.test(path)) {
    return 'i-mdi-language-javascript text-yellow-300';
  }

  if (/\.pyw?$/.test(path)) {
    return 'i-mdi-language-python text-sky-300';
  }

  if (path.endsWith('.gd')) {
    return 'i-mdi-robot-outline text-sky-300';
  }

  if (/\.md$/i.test(path)) {
    return 'i-mdi-language-markdown-outline text-zinc-400';
  }

  return 'i-mdi-file-outline text-zinc-500';
}
