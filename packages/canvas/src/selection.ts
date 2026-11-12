export interface SelectionModifiers {
  /** Shift: add to selection. */
  add: boolean;
  /** Ctrl / Cmd: toggle in selection. */
  toggle: boolean;
}

/** New selection after clicking a node. */
export function clickSelection(
  current: ReadonlySet<string>,
  id: string,
  mods: SelectionModifiers
): Set<string> {
  if (mods.toggle) {
    const next = new Set(current);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }

    return next;
  }

  if (mods.add) {
    return new Set([...current, id]);
  }

  // Clicking an already selected node keeps the group (to drag it).
  if (current.has(id)) {
    return new Set(current);
  }

  return new Set([id]);
}

/** New selection after a marquee drag. */
export function marqueeSelection(
  base: ReadonlySet<string>,
  hits: ReadonlyArray<string>,
  mods: SelectionModifiers
): Set<string> {
  if (mods.toggle) {
    const next = new Set(base);
    for (const id of hits) {
      if (base.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
    }

    return next;
  }

  if (mods.add) {
    return new Set([...base, ...hits]);
  }

  return new Set(hits);
}
