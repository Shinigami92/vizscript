type Handler<T> = (payload: T) => void;

/** Minimal typed event emitter. */
export class Emitter<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();

  public on<K extends keyof Events>(
    event: K,
    handler: Handler<Events[K]>
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }

    set.add(handler);
    return () => set.delete(handler);
  }

  public emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as Handler<Events[K]>)(payload);
    }
  }

  public clear(): void {
    this.handlers.clear();
  }
}
