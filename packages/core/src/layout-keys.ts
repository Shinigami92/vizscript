import type { GraphDocument, Positions } from './ir';
import { isLooseKey } from './loose-overlay';
import type { TextChange } from './reconcile';
import { reconcilePositions } from './reconcile';
import { isBoxColorKey, isRerouteKey, reconcileReroutes } from './reroute';
import { isViaKey, reconcileVias } from './via-wires';

/**
 * A kind of layout entry besides node positions (its keys start with `~`).
 * One that names nodes or wires of the code follows them through a
 * re-parse; the others stay as they are.
 */
interface LayoutFamily {
  is: (key: string) => boolean;
  reconcile?: (
    previous: GraphDocument | undefined,
    next: GraphDocument,
    positions: Positions,
    change?: TextChange
  ) => Positions;
}

const FAMILIES: ReadonlyArray<LayoutFamily> = [
  // Reroute points of wires (edge ids name their nodes).
  { is: isRerouteKey, reconcile: reconcileReroutes },
  // Gets drawn as wires from their SET, joins of Gets and pure nodes.
  { is: isViaKey, reconcile: reconcileVias },
  // Comment box colors (boxes come from the code's regions).
  { is: isBoxColorKey },
  // Loose graph-only nodes: their code, and wires from the code into them
  // (`storeLoose` writes those again when the overlay follows the code).
  { is: isLooseKey },
];

/** Layout entries that are not node positions. */
export function isExtraLayoutKey(key: string): boolean {
  return FAMILIES.some((family) => family.is(key));
}

/**
 * The layout after a re-parse: node positions follow their nodes
 * (`reconcilePositions`), and every other kind of entry is followed or
 * kept, so none is lost.
 */
export function reconcileLayout(
  previous: GraphDocument | undefined,
  next: GraphDocument,
  positions: Positions,
  change?: TextChange,
  memory?: Positions
): Positions {
  const result = reconcilePositions(previous, next, positions, change, memory);
  for (const family of FAMILIES) {
    Object.assign(
      result,
      family.reconcile
        ? family.reconcile(previous, next, positions, change)
        : Object.fromEntries(
            Object.entries(positions).filter(([key]) => family.is(key))
          )
    );
  }

  return result;
}
