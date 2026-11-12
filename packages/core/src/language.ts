import type { LanguageBackend } from './ops';

/**
 * Registry of language backends. Apps register the backends they ship and
 * look them up by file name.
 */
export class LanguageRegistry {
  private readonly backends = new Map<string, LanguageBackend>();

  public register(backend: LanguageBackend): this {
    this.backends.set(backend.id, backend);
    return this;
  }

  public get(id: string): LanguageBackend | undefined {
    return this.backends.get(id);
  }

  public forFile(fileName: string): LanguageBackend | undefined {
    const lower = fileName.toLowerCase();
    for (const backend of this.backends.values()) {
      if (backend.extensions.some((ext) => lower.endsWith(ext))) {
        return backend;
      }
    }

    return undefined;
  }

  public all(): LanguageBackend[] {
    return [...this.backends.values()];
  }
}
