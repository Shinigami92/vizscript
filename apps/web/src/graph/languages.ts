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
