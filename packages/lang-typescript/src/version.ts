import type { LanguageVersion, ProjectFile } from '@vizscript/core';
import { shortVersion } from '@vizscript/core';

export const TS_VERSION_FILES: ReadonlyArray<string> = [
  'package.json',
  'pnpm-workspace.yaml',
];

const FIELDS = ['devDependencies', 'dependencies', 'peerDependencies'];

/** `typescript` of a pnpm catalog (`catalog:` or `catalog:<name>`). */
function catalogRange(yaml: string, catalog: string): string | undefined {
  const lines = yaml.split(/\r?\n/);
  const named = catalog !== '' && catalog !== 'default';
  let inside = false;
  let depth = -1;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (content === '' || content.startsWith('#')) {
      continue;
    }

    if (!inside) {
      if (named) {
        if (indent > 0 && depth === 0 && content === `${catalog}:`) {
          inside = true;
          depth = indent;
        } else if (indent === 0) {
          depth = content === 'catalogs:' ? 0 : -1;
        }
      } else if (indent === 0 && content === 'catalog:') {
        inside = true;
        depth = 0;
      }

      continue;
    }

    if (indent <= depth) {
      return undefined;
    }

    const entry = /^["']?typescript["']?\s*:\s*["']?([^"'#\s]+)/.exec(content);
    if (entry) {
      return entry[1];
    }
  }

  return undefined;
}

/**
 * The TypeScript version of the nearest `package.json` that depends on it
 * (pnpm catalogs are looked up in `pnpm-workspace.yaml`).
 */
export function typescriptVersion(
  files: ReadonlyArray<ProjectFile>
): LanguageVersion | undefined {
  for (const file of files) {
    if (!file.path.endsWith('package.json')) {
      continue;
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(file.text) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const field of FIELDS) {
      const deps = json[field];
      const range =
        typeof deps === 'object' && deps !== null
          ? (deps as Record<string, unknown>).typescript
          : undefined;
      if (typeof range !== 'string') {
        continue;
      }

      const catalog = /^catalog:(.*)$/.exec(range);
      if (catalog) {
        const name = catalog[1] ?? '';
        for (const workspace of files) {
          const value = workspace.path.endsWith('pnpm-workspace.yaml')
            ? catalogRange(workspace.text, name)
            : undefined;
          if (value !== undefined) {
            return {
              text: shortVersion(value),
              detail: `typescript ${value} in the ${name || 'default'} catalog`,
              path: workspace.path,
            };
          }
        }

        continue;
      }

      if (/^(?:workspace|file|link|portal|git|github|https?):/.test(range)) {
        continue;
      }

      const plain = range.replace(/^npm:typescript@/, '');
      return {
        text: shortVersion(plain),
        detail: `typescript ${plain} in ${field}`,
        path: file.path,
      };
    }
  }

  return undefined;
}
