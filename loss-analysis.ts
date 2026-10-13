// Searches for mine layouts consistent with everything the player could see:
// the revealed cells (as colors, when colors are randomized) and, via the
// safe-cell counter, the total number of mines.
//
// After a mine click, a layout with the clicked cell safe means the click was
// a guess; exhausting the search proves the cell was forced. Hitting the node
// budget is treated as "no layout" but unproven.

import { type Board, neighborsFor } from "./solver.ts";

export interface LayoutSearch {
  found: boolean;
  // False when the search gave up at its node budget.
  proven: boolean;
  nodes: number;
  // The full layout (mine flags per cell), if found.
  layout?: Uint8Array;
  // values[k]: the number that cells currently labeled k show under layout
  // (differs from k only when colors are randomized).
  values?: Int32Array;
}

export interface LossAnalysis {
  forced: boolean;
  proven: boolean;
  nodes: number;
  // A consistent layout with the clicked cell safe, if found.
  witness?: Uint8Array;
}

export function analyzeLoss(
  board: Board,
  revealed: Uint8Array,
  clicked: number,
  colorblind: boolean,
  budget = 2_000_000,
): LossAnalysis {
  const r = findLayout(board, revealed, clicked, false, colorblind, { budget });
  return { forced: !r.found, proven: r.proven, nodes: r.nodes, witness: r.layout };
}

// Splits the frontier into cells that are mines in no consistent layout (the
// cells an Always-punished click would still leave safe) and cells that are
// mines in every one (forced), as far as the budget can tell; the rest could
// go either way. Every layout found rules out a value for all of its cells at
// once, starting with the board itself, so most cells never need a search of
// their own. A search that hits the budget counts as "no layout", matching
// analyzeLoss and Always mode.
export function classifyFrontier(
  board: Board,
  revealed: Uint8Array,
  colorblind: boolean,
  budget = 2_000_000,
): { safe: number[]; mines: number[] } {
  const { rows, cols, mines } = board;
  const size = rows * cols;
  const neighbors = neighborsFor(rows, cols);
  const possibleMine = Uint8Array.from(mines);
  const possibleSafe = mines.map((m) => 1 - m);
  const safe: number[] = [];
  const forced: number[] = [];
  for (let i = 0; i < size; i++) {
    if (revealed[i] || !neighbors[i].some((n) => revealed[n])) continue;
    for (const mine of [true, false]) {
      if (mine ? possibleMine[i] : possibleSafe[i]) continue;
      const found = findLayout(board, revealed, i, mine, colorblind, { budget });
      if (!found.found) (mine ? safe : forced).push(i);
      else {
        found.layout!.forEach((m, j) => {
          possibleMine[j] |= m;
          possibleSafe[j] |= 1 - m;
        });
      }
    }
  }
  return { safe, mines: forced };
}

class BudgetExceeded extends Error {}

// Finds a consistent layout in which frontier cell `cell` is a mine (or safe).
// Without `random`, it tries each cell's current value first, so it returns a
// layout close to the current board. With `random`, values are tried in random
// order and leftover mines are scattered randomly away from the frontier.
// `fixed` pins other unrevealed cells, frontier or not (1 = mine, 0 = safe).
export function findLayout(
  board: Board,
  revealed: Uint8Array,
  cell: number,
  mine: boolean,
  colorblind: boolean,
  { budget = 2_000_000, random, fixed }: { budget?: number; random?: () => number; fixed?: Map<number, number> } = {},
): LayoutSearch {
  const { rows, cols, mines, counts } = board;
  const size = rows * cols;
  const neighbors = neighborsFor(rows, cols);
  let totalMines = 0;
  for (let i = 0; i < size; i++) totalMines += mines[i];

  // Frontier cells are the variables; unrevealed cells elsewhere only absorb
  // whatever mines the frontier leaves over.
  const isFrontier = new Uint8Array(size);
  let interior = 0;
  for (let i = 0; i < size; i++) {
    if (revealed[i]) continue;
    if (neighbors[i].some((n) => revealed[n])) isFrontier[i] = 1;
    else interior++;
  }
  // Fixed interior cells take no part in the search, but their mines count
  // toward the total and they can't absorb leftovers.
  let fixedInteriorMines = 0;
  for (const [i, v] of fixed ?? []) {
    if (revealed[i] || isFrontier[i]) continue;
    interior--;
    fixedInteriorMines += v;
  }

  // One constraint per revealed number: its unrevealed neighbors hold exactly
  // its value (blank cells have no unrevealed neighbors).
  const consCells: number[] = [];
  const consOfCell = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    if (!revealed[i] || counts[i] === 0) continue;
    const c = consCells.length;
    consCells.push(i);
    for (const n of neighbors[i]) {
      if (!isFrontier[n]) continue;
      let list = consOfCell.get(n);
      if (!list) consOfCell.set(n, (list = []));
      list.push(c);
    }
  }

  // Variable order: breadth-first from the clicked cell through shared
  // constraints, then the rest of the frontier the same way, so constraints
  // close (and prune) as early as possible.
  const order: number[] = [];
  const placed = new Uint8Array(size);
  const visit = (start: number): void => {
    placed[start] = 1;
    const queue = [start];
    for (let h = 0; h < queue.length; h++) {
      const cell = queue[h];
      order.push(cell);
      for (const c of consOfCell.get(cell) ?? []) {
        for (const n of neighbors[consCells[c]]) {
          if (isFrontier[n] && !placed[n]) {
            placed[n] = 1;
            queue.push(n);
          }
        }
      }
    }
  };
  if (!isFrontier[cell]) throw new Error("findLayout: cell must be on the frontier");
  visit(cell);
  for (let i = 0; i < size; i++) if (isFrontier[i] && !placed[i]) visit(i);

  const nVars = order.length;
  const nCons = consCells.length;
  const consOfVar = order.map((cell) => consOfCell.get(cell) ?? []);
  const fixedValue = order.map((cell) => fixed?.get(cell) ?? -1);
  const consMines = new Int32Array(nCons);
  const consFree = new Int32Array(nCons);
  for (let c = 0; c < nCons; c++) {
    for (const n of neighbors[consCells[c]]) if (isFrontier[n]) consFree[c]++;
  }
  // colorValue[k]: the number color k stands for, or -1 while undetermined.
  // Colorblind, a color gets a value once one of its cells has every
  // neighbor decided; it's released when the last such cell is undone.
  const colorValue = new Int32Array(9).fill(-1);
  const colorRefs = new Int32Array(9);
  const valueOwner = new Int32Array(9);
  if (!colorblind) for (let k = 1; k <= 8; k++) colorValue[k] = k;

  const assign = new Int8Array(nVars).fill(-1);
  let assignedMines = 0;
  let nodes = 0;

  // Assigns variable d and checks every constraint it touches. On success
  // returns the constraints that pinned a color (for undo); on conflict,
  // undoes itself and returns null.
  const place = (d: number, v: number): number[] | null => {
    assign[d] = v;
    assignedMines += v;
    for (const c of consOfVar[d]) {
      consMines[c] += v;
      consFree[c]--;
    }
    const pinned: number[] = [];
    const settled = assignedMines + fixedInteriorMines;
    let ok = settled <= totalMines && settled + (nVars - d - 1) + interior >= totalMines;
    for (const c of consOfVar[d]) {
      if (!ok) break;
      const k = counts[consCells[c]];
      const m = consMines[c];
      const f = consFree[c];
      const lo = colorValue[k] >= 0 ? colorValue[k] : 1;
      const hi = colorValue[k] >= 0 ? colorValue[k] : 8;
      if (m > hi || m + f < lo) ok = false;
      else if (f === 0 && colorblind) {
        if (colorValue[k] < 0) {
          if (valueOwner[m]) {
            ok = false;
            break;
          }
          colorValue[k] = m;
          valueOwner[m] = k;
        }
        colorRefs[k]++;
        pinned.push(c);
      }
    }
    if (ok) return pinned;
    unplace(d, v, pinned);
    return null;
  };

  const unplace = (d: number, v: number, pinned: number[]): void => {
    for (let q = pinned.length - 1; q >= 0; q--) {
      const k = counts[consCells[pinned[q]]];
      if (--colorRefs[k] === 0) {
        valueOwner[colorValue[k]] = 0;
        colorValue[k] = -1;
      }
    }
    for (const c of consOfVar[d]) {
      consMines[c] -= v;
      consFree[c]++;
    }
    assignedMines -= v;
    assign[d] = -1;
  };

  // The chosen cell is fixed; everywhere else try the real value first (which
  // usually finds a layout quickly when one exists), or a random one.
  const search = (d: number): boolean => {
    if (++nodes > budget) throw new BudgetExceeded();
    if (d === nVars) return true;
    const first = random ? +(random() < 0.5) : mines[order[d]];
    for (const v of d === 0 ? [+mine] : [first, 1 - first]) {
      if (fixedValue[d] >= 0 && v !== fixedValue[d]) continue;
      const pinned = place(d, v);
      if (!pinned) continue;
      if (search(d + 1)) return true;
      unplace(d, v, pinned);
    }
    return false;
  };

  try {
    if (!search(0)) return { found: false, proven: true, nodes };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { found: false, proven: false, nodes };
    throw e;
  }
  const layout = new Uint8Array(size);
  order.forEach((c, d) => (layout[c] = assign[d]));
  const interiorCells: number[] = [];
  for (let i = 0; i < size; i++) {
    if (revealed[i] || isFrontier[i]) continue;
    if (fixed?.has(i)) layout[i] = fixed.get(i)!;
    else interiorCells.push(i);
  }
  if (random) {
    for (let i = interiorCells.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [interiorCells[i], interiorCells[j]] = [interiorCells[j], interiorCells[i]];
    }
  }
  for (let q = 0; q < totalMines - assignedMines - fixedInteriorMines; q++) layout[interiorCells[q]] = 1;
  return { found: true, proven: true, nodes, layout, values: colorValue };
}
