/**
 * Which repository branch or folder (`github/o/r@main`, `local/<id>`) the
 * kept editor model of a path belongs to, with its saved view state.
 * Models are named by path alone (the TypeScript worker resolves imports
 * between them), so a path of another scope must get a fresh model, not
 * the old one with its text, undo history and cursor.
 */
export class ModelScopes<ViewState> {
  private readonly owners = new Map<string, string>();
  private readonly views = new Map<string, ViewState>();

  /** Whether the kept model of `path` belongs to `scope` (reuse it). */
  public owns(path: string, scope: string): boolean {
    return this.owners.get(path) === scope;
  }

  /** `path`'s model now belongs to `scope`; another scope's state goes. */
  public claim(path: string, scope: string): void {
    if (this.owners.get(path) !== scope) {
      this.views.delete(path);
    }

    this.owners.set(path, scope);
  }

  public saveView(path: string, scope: string, state: ViewState): void {
    if (this.owns(path, scope)) {
      this.views.set(path, state);
    }
  }

  public viewOf(path: string, scope: string): ViewState | undefined {
    return this.owns(path, scope) ? this.views.get(path) : undefined;
  }

  /**
   * Forgets `path` if it belongs to `scope` (any scope without one);
   * returns whether its model should be disposed.
   */
  public release(path: string, scope?: string): boolean {
    if (
      scope !== undefined &&
      this.owners.has(path) &&
      !this.owns(path, scope)
    ) {
      return false;
    }

    this.owners.delete(path);
    this.views.delete(path);
    return true;
  }
}
