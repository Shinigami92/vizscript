import type { SourceRange } from '@vizscript/core';
import { monaco } from './setup';

/** A repository file referenced from the code (e.g. an import path). */
export interface FileLink {
  range: SourceRange;
  /** Repository path of the referenced file. */
  path: string;
  /** Definition to show in that file. */
  symbol?: string;
}

/** Provides the file links of one editor model and opens them. */
export interface FileLinkSource {
  links(text: string): Promise<ReadonlyArray<FileLink>>;
  open(path: string, symbol?: string): void;
}

const SCHEME = 'vizscript-file';
const sources = new Map<string, FileLinkSource>();
let installed = false;

function install(): void {
  installed = true;
  monaco.languages.registerLinkProvider('*', {
    async provideLinks(model) {
      const source = sources.get(model.uri.toString());
      if (!source) {
        return undefined;
      }

      const version = model.getVersionId();
      const links = await source.links(model.getValue());
      // Offsets of an older text would point at the wrong code.
      if (model.isDisposed() || model.getVersionId() !== version) {
        return { links: [] };
      }

      return {
        links: links.map((link) => {
          const start = model.getPositionAt(link.range.start);
          const end = model.getPositionAt(link.range.end);
          return {
            range: new monaco.Range(
              start.lineNumber,
              start.column,
              end.lineNumber,
              end.column
            ),
            url: monaco.Uri.from({
              scheme: SCHEME,
              path: `/${link.path}`,
              query: model.uri.toString(),
              fragment: link.symbol ?? '',
            }),
            tooltip: link.symbol
              ? `Go to ${link.symbol} in ${link.path}`
              : `Open ${link.path}`,
          };
        }),
      };
    },
  });
  monaco.editor.registerLinkOpener({
    open(resource) {
      if (resource.scheme !== SCHEME) {
        return false;
      }

      sources
        .get(resource.query)
        ?.open(
          resource.path.replace(/^\//, ''),
          resource.fragment || undefined
        );
      return true;
    },
  });
}

/**
 * Makes referenced files of a model Ctrl/Cmd+clickable, like VS Code's
 * document links. Returns a function that removes the links again.
 */
export function registerFileLinks(
  model: monaco.editor.ITextModel,
  source: FileLinkSource
): () => void {
  if (!installed) {
    install();
  }

  const key = model.uri.toString();
  sources.set(key, source);
  return () => {
    if (sources.get(key) === source) {
      sources.delete(key);
    }
  };
}
