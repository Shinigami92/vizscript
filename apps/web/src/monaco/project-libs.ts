import * as monaco from 'monaco-editor';
import { modelUri } from './models';

/**
 * Files TypeScript's checker sees next to the open models: other files of
 * the repository and declarations of npm packages. Monaco's extra libs are
 * global, so each workspace (`owner`) adds its files, and a file stays as
 * long as one workspace still uses it.
 */
interface Lib {
  text: string;
  owners: Set<symbol>;
  disposables: monaco.IDisposable[];
}

const libs = new Map<string, Lib>();

function add(uri: string, text: string): monaco.IDisposable[] {
  const ts = monaco.typescript;
  return [
    ts.typescriptDefaults.addExtraLib(text, uri),
    ts.javascriptDefaults.addExtraLib(text, uri),
  ];
}

function release(uri: string, lib: Lib, owner: symbol): void {
  if (lib.owners.delete(owner) && lib.owners.size === 0) {
    for (const disposable of lib.disposables) {
      disposable.dispose();
    }

    libs.delete(uri);
  }
}

/**
 * Sets the files of `owner` (repository paths → text). Files it no longer
 * lists are dropped once no other owner uses them.
 */
export function setProjectLibs(
  owner: symbol,
  files: ReadonlyMap<string, string>
): void {
  const uris = new Map<string, string>();
  for (const [path, text] of files) {
    // Unencoded (`@types`), as TypeScript asks for the files it resolves.
    uris.set(modelUri(path).toString(true), text);
  }

  for (const [uri, text] of uris) {
    const lib = libs.get(uri);
    if (lib?.text === text) {
      lib.owners.add(owner);
      continue;
    }

    for (const disposable of lib?.disposables ?? []) {
      disposable.dispose();
    }

    libs.set(uri, {
      text,
      owners: new Set([...(lib?.owners ?? []), owner]),
      disposables: add(uri, text),
    });
  }

  for (const [uri, lib] of libs) {
    if (!uris.has(uri)) {
      release(uri, lib, owner);
    }
  }
}

/** Drops all files of `owner` (its workspace closed). */
export function clearProjectLibs(owner: symbol): void {
  setProjectLibs(owner, new Map());
}
