import type { LanguageVersion, ProjectFile } from '@vizscript/core';
import { configValue } from '@vizscript/core';

export const GDSCRIPT_VERSION_FILES: ReadonlyArray<string> = ['project.godot'];

/** Godot of a `config_version` (the project file format). */
const MAJOR: Record<string, string> = { '3': '3', '4': '3', '5': '4' };

/**
 * The Godot version of the nearest `project.godot`: its feature tag
 * (`config/features=PackedStringArray("4.3", …)`), or the major version of
 * its file format.
 */
export function gdscriptVersion(
  files: ReadonlyArray<ProjectFile>
): LanguageVersion | undefined {
  for (const file of files) {
    const features = configValue(file.text, 'application', 'config/features');
    const tag = features
      ? /"(\d+\.\d+(?:\.\d+)?)"/.exec(features)?.[1]
      : undefined;
    if (tag) {
      return {
        text: `Godot ${tag}`,
        detail: `feature ${tag} in config/features`,
        path: file.path,
      };
    }

    const format = configValue(file.text, '', 'config_version');
    const major = format === undefined ? undefined : MAJOR[format];
    if (major) {
      return {
        text: `Godot ${major}`,
        detail: `config_version=${format}`,
        path: file.path,
      };
    }
  }

  return undefined;
}
