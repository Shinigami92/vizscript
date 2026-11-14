import type { LanguageVersion, ProjectFile } from '@vizscript/core';
import { configValue, shortVersion } from '@vizscript/core';

export const PYTHON_VERSION_FILES: ReadonlyArray<string> = [
  '.python-version',
  'pyproject.toml',
  'setup.cfg',
  'runtime.txt',
];

/** Places that state the version, per file, most telling first. */
const SOURCES: Record<
  string,
  ReadonlyArray<{ section: string; key: string; label: string }>
> = {
  'pyproject.toml': [
    { section: 'tool.pyright', key: 'pythonVersion', label: 'pythonVersion' },
    { section: 'tool.mypy', key: 'python_version', label: 'python_version' },
    { section: 'project', key: 'requires-python', label: 'requires-python' },
    {
      section: 'tool.poetry.dependencies',
      key: 'python',
      label: 'tool.poetry python',
    },
  ],
  'setup.cfg': [
    { section: 'options', key: 'python_requires', label: 'python_requires' },
  ],
};

/**
 * The Python version of the nearest project file that states one: the
 * interpreter of `.python-version`, the type checker's target, or the
 * project's `requires-python`.
 */
export function pythonVersion(
  files: ReadonlyArray<ProjectFile>
): LanguageVersion | undefined {
  for (const file of files) {
    const name = file.path.split('/').at(-1) ?? '';
    if (name === '.python-version' || name === 'runtime.txt') {
      const line = file.text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l !== '' && !l.startsWith('#'));
      if (line) {
        const version = line.replace(/^python-/, '');
        return {
          text: version,
          detail: `${version} in ${name}`,
          path: file.path,
        };
      }

      continue;
    }

    for (const source of SOURCES[name] ?? []) {
      const value = configValue(file.text, source.section, source.key);
      if (value) {
        return {
          text: shortVersion(value),
          detail: `${source.label} ${value}`,
          path: file.path,
        };
      }
    }
  }

  return undefined;
}
