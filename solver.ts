import { type LinearRow, variableRanges } from "./lp.ts";

// No-guess solvers. Boards are flat arrays indexed by r * cols + c.

export interface Board {
  rows: number;
  cols: number;
  mines: Uint8Array;
  counts: Uint8Array;
}

// Deterministic PRNG (mulberry32) for reproducible experiments.
export function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = items[i];
    items[i] = items[j];
    items[j] = t;
  }
}

// Places mines uniformly at random, keeping the 3x3 around the first click clear.
export function generateBoard(
  rows: number,
  cols: number,
  mineCount: number,
  safeRow: number,
  safeCol: number,
  random: () => number = Math.random,
): Board {
  const size = rows * cols;
  const candidates: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.abs(r - safeRow) <= 1 && Math.abs(c - safeCol) <= 1) continue;
      candidates.push(r * cols + c);
    }
  }
  if (mineCount > candidates.length) {
    throw new Error(`cannot place ${mineCount} mines; only ${candidates.length} cells available`);
  }
  // Partial Fisher-Yates: the first mineCount candidates become mines.
  const mines = new Uint8Array(size);
  for (let i = 0; i < mineCount; i++) {
    const j = i + Math.floor(random() * (candidates.length - i));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
    mines[candidates[i]] = 1;
  }
  return boardFromMines(rows, cols, mines);
}

export function boardFromMines(rows: number, cols: number, mines: Uint8Array): Board {
  const counts = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) n += mines[nr * cols + nc];
        }
      }
      counts[r * cols + c] = n;
    }
  }
  return { rows, cols, mines, counts };
}

function neighborTable(rows: number, cols: number): Int32Array[] {
  const table: Int32Array[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ns: number[] = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) ns.push(nr * cols + nc);
        }
      }
      table.push(Int32Array.from(ns));
    }
  }
  return table;
}

const neighborCache = new Map<string, Int32Array[]>();

export function neighborsFor(rows: number, cols: number): Int32Array[] {
  const key = `${rows}x${cols}`;
  let table = neighborCache.get(key);
  if (!table) {
    table = neighborTable(rows, cols);
    neighborCache.set(key, table);
  }
  return table;
}

const UNKNOWN = 0;
const REVEALED = 1;
const FLAGGED = 2;

// Color domains: bit v of dom[k] is set while color k could still mean v.
// Color k is the label shown for a cell whose true count is k; the solver only
// ever compares it for equality, never reads it as a number (blank = 0 is known).
const ALL_VALUES = 0x1fe;

function isSingleton(mask: number): boolean {
  return mask !== 0 && (mask & (mask - 1)) === 0;
}

function rangeMask(lo: number, hi: number): number {
  return ((1 << (hi + 1)) - 1) & ~((1 << lo) - 1);
}

function minValue(mask: number): number {
  return 31 - Math.clz32(mask & -mask);
}

function maxValue(mask: number): number {
  return 31 - Math.clz32(mask);
}

export interface SolveOptions {
  // Number colors are shuffled: the solver starts out not knowing which
  // color means which number.
  colorblind?: boolean;
  // When set, every choice whose order shouldn't matter (worklist order,
  // elimination column and row order) is randomized with it. A result that
  // changes with the seed exposes order-dependent reasoning.
  random?: () => number;
  // Cells already revealed before the click at (startRow, startCol), to solve
  // from a game in progress.
  revealed?: Uint8Array;
}

// Knowledge state shared by the solvers: which cells have been revealed or
// flagged, what each color could mean, plus the propagation worklist.
class Solver {
  readonly board: Board;
  readonly neighbors: Int32Array[];
  readonly state: Uint8Array;
  readonly dom = new Uint16Array(9);
  safeRemaining = 0;
  private readonly colorCells: number[][] = [];
  private readonly queued: Uint8Array;
  private readonly queue: number[] = [];
  private readonly stack: number[] = [];
  private readonly random: (() => number) | undefined;

  constructor(board: Board, startRow: number, startCol: number, options: SolveOptions) {
    const size = board.rows * board.cols;
    this.board = board;
    this.random = options.random;
    this.neighbors = neighborsFor(board.rows, board.cols);
    this.state = new Uint8Array(size);
    this.queued = new Uint8Array(size);
    for (let k = 0; k <= 8; k++) {
      this.dom[k] = k === 0 ? 1 : options.colorblind ? ALL_VALUES : 1 << k;
      this.colorCells.push([]);
    }
    for (let i = 0; i < size; i++) if (!board.mines[i]) this.safeRemaining++;
    if (options.revealed) for (let i = 0; i < size; i++) if (options.revealed[i]) this.reveal(i);
    this.reveal(startRow * board.cols + startCol);
  }

  private enqueue(i: number): void {
    if (this.state[i] === REVEALED && !this.queued[i]) {
      this.queued[i] = 1;
      this.queue.push(i);
    }
  }

  // The known count shown on revealed cell i, or -1 if its color is still ambiguous.
  value(i: number): number {
    const d = this.dom[this.board.counts[i]];
    return isSingleton(d) ? minValue(d) : -1;
  }

  // Reveals a known-safe cell, flood-filling zeros like the game does, and
  // queues every revealed cell whose unknown-neighbor set just shrank.
  reveal(start: number): void {
    const { state, neighbors, stack } = this;
    const { mines, counts } = this.board;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (state[i] !== UNKNOWN) continue;
      if (mines[i]) throw new Error("solver revealed a mine; deduction is unsound");
      state[i] = REVEALED;
      this.safeRemaining--;
      this.colorCells[counts[i]].push(i);
      this.enqueue(i);
      for (const n of neighbors[i]) {
        if (counts[i] === 0 && state[n] === UNKNOWN) stack.push(n);
        else this.enqueue(n);
      }
    }
  }

  flag(i: number): void {
    if (this.state[i] !== UNKNOWN) return;
    if (!this.board.mines[i]) throw new Error("solver flagged a safe cell; deduction is unsound");
    this.state[i] = FLAGGED;
    for (const n of this.neighbors[i]) this.enqueue(n);
  }

  // Narrows color k to the values in mask, then applies the all-different rules
  // (a settled color's value is taken; a value only one color can mean is that
  // color's) until nothing changes.
  restrict(k: number, mask: number): void {
    if (!this.setDomain(k, this.dom[k] & mask)) return;
    const { dom } = this;
    let changed = true;
    while (changed) {
      changed = false;
      for (let a = 1; a <= 8; a++) {
        if (!isSingleton(dom[a])) continue;
        for (let b = 1; b <= 8; b++) {
          if (b !== a && dom[b] & dom[a]) changed = this.setDomain(b, dom[b] & ~dom[a]) || changed;
        }
      }
      for (let v = 1; v <= 8; v++) {
        let only = -1;
        for (let a = 1; a <= 8; a++) {
          if (!(dom[a] & (1 << v))) continue;
          only = only === -1 ? a : -2;
        }
        if (only > 0) changed = this.setDomain(only, 1 << v) || changed;
      }
    }
  }

  private setDomain(k: number, d: number): boolean {
    if (d === this.dom[k]) return false;
    if (!(d & (1 << k))) throw new Error("solver ruled out a color's true value; deduction is unsound");
    this.dom[k] = d;
    for (const i of this.colorCells[k]) this.enqueue(i);
    return true;
  }

  // Simple propagation to a fixpoint. For each revealed cell with f flagged and
  // u unknown neighbors, its color must mean a value in [f, f + u]. Once the
  // value is known:
  //   - value = f        → every unknown neighbor is safe
  //   - value = f + u    → every unknown neighbor is a mine
  propagate(): void {
    const { state, neighbors, queue, queued, dom } = this;
    const { counts } = this.board;
    const { random } = this;
    while (queue.length > 0) {
      if (random) {
        const j = Math.floor(random() * queue.length);
        const t = queue[j];
        queue[j] = queue[queue.length - 1];
        queue[queue.length - 1] = t;
      }
      const i = queue.pop()!;
      queued[i] = 0;
      let unknown = 0;
      let flagged = 0;
      for (const n of neighbors[i]) {
        if (state[n] === UNKNOWN) unknown++;
        else if (state[n] === FLAGGED) flagged++;
      }
      const k = counts[i];
      if (!isSingleton(dom[k])) this.restrict(k, rangeMask(flagged, flagged + unknown));
      const v = this.value(i);
      if (unknown === 0 || v < 0) continue;
      if (v === flagged) {
        for (const n of neighbors[i]) if (state[n] === UNKNOWN) this.reveal(n);
      } else if (v === flagged + unknown) {
        for (const n of neighbors[i]) if (state[n] === UNKNOWN) this.flag(n);
      }
    }
  }

  // One round of linear-programming bounds. Unknowns are the frontier cells
  // (x ∈ [0, 1]) and the still-ambiguous colors (v between that color's
  // smallest and largest candidate). Each revealed cell gives
  // Σ x_unknown − v_color = −flagged  (or, with a known value,
  // Σ x_unknown = value − flagged). For each unknown, the LP finds its exact
  // minimum and maximum subject to all of these at once: a cell whose maximum
  // is below 1 is safe, one whose minimum is above 0 is a mine, and a color
  // keeps only the candidates within its range. This catches every deduction
  // that follows from bounds on any linear combination of the constraints,
  // independent of how they're ordered.
  //
  // The frontier is split into independent components (unknowns linked by
  // shared constraints); the step returns after the first component that
  // yields anything, since cheap propagation usually takes it from there.
  // Returns whether anything was deduced.
  lpStep(): boolean {
    const { state, neighbors, dom } = this;
    const { counts } = this.board;
    const size = state.length;

    // Variable ids: 0..7 are colors 1..8; 8 + i is cell i.
    const COLOR_BASE = 8;
    const isUnknownColor = (k: number) => k > 0 && !isSingleton(dom[k]) && this.colorCells[k].length > 0;
    const equations: number[] = [];
    for (let i = 0; i < size; i++) {
      if (state[i] !== REVEALED) continue;
      let hasUnknown = isUnknownColor(counts[i]);
      for (const n of neighbors[i]) if (state[n] === UNKNOWN) hasUnknown = true;
      if (hasUnknown) equations.push(i);
    }
    if (equations.length === 0) return false;

    // Union-find over variable ids to split the frontier into components.
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let root = x;
      while (parent.get(root)! !== root) root = parent.get(root)!;
      while (x !== root) {
        const next = parent.get(x)!;
        parent.set(x, root);
        x = next;
      }
      return root;
    };
    const varsOf = (i: number): number[] => {
      const vars: number[] = [];
      if (isUnknownColor(counts[i])) vars.push(counts[i] - 1);
      for (const n of neighbors[i]) if (state[n] === UNKNOWN) vars.push(COLOR_BASE + n);
      return vars;
    };
    for (const i of equations) {
      const vars = varsOf(i);
      for (const v of vars) if (!parent.has(v)) parent.set(v, v);
      for (let q = 1; q < vars.length; q++) parent.set(find(vars[q]), find(vars[0]));
    }
    const components = new Map<number, number[]>();
    for (const i of equations) {
      const root = find(varsOf(i)[0]);
      let list = components.get(root);
      if (!list) components.set(root, (list = []));
      list.push(i);
    }
    const groups = [...components.values()];
    if (this.random) {
      shuffle(groups, this.random);
      for (const g of groups) shuffle(g, this.random);
    }

    for (const group of groups) {
      // Local column per variable, in first-seen order.
      const column = new Map<number, number>();
      const ids: number[] = [];
      const rows: LinearRow[] = [];
      for (const i of group) {
        const k = counts[i];
        const vars: number[] = [];
        const coefs: number[] = [];
        let rhs = 0;
        const add = (id: number, coef: number): void => {
          let col = column.get(id);
          if (col === undefined) {
            col = ids.length;
            column.set(id, col);
            ids.push(id);
          }
          vars.push(col);
          coefs.push(coef);
        };
        if (isUnknownColor(k)) add(k - 1, -1);
        else rhs = this.value(i);
        for (const n of neighbors[i]) {
          if (state[n] === UNKNOWN) add(COLOR_BASE + n, 1);
          else if (state[n] === FLAGGED) rhs--;
        }
        rows.push({ vars, coefs, rhs });
      }
      const lo = new Float64Array(ids.length);
      const hi = new Float64Array(ids.length).fill(1);
      ids.forEach((id, col) => {
        if (id < COLOR_BASE) {
          lo[col] = minValue(dom[id + 1]);
          hi[col] = maxValue(dom[id + 1]);
        }
      });

      const ranges = variableRanges(ids.length, rows, lo, hi);
      if (!ranges) throw new Error("solver's constraints have no solution; deduction is unsound");
      const TOL = 1e-7;
      let progress = false;
      ids.forEach((id, col) => {
        const { min, max } = ranges;
        if (id < COLOR_BASE) {
          const k = id + 1;
          const mask = rangeMask(Math.ceil(min[col] - TOL), Math.floor(max[col] + TOL));
          if ((dom[k] & mask) !== dom[k]) {
            this.restrict(k, mask);
            progress = true;
          }
        } else if (state[id - COLOR_BASE] === UNKNOWN) {
          if (max[col] < 1 - TOL) {
            this.reveal(id - COLOR_BASE);
            progress = true;
          } else if (min[col] > TOL) {
            this.flag(id - COLOR_BASE);
            progress = true;
          }
        }
      });
      if (progress) return true;
    }
    return false;
  }
}

// Tier 1 (Easy): simple constraint propagation only, starting from a click at
// (startRow, startCol). Never uses the global mine count.
// Returns true if every safe cell gets revealed (the standard win rule).
export function solveSimple(board: Board, startRow: number, startCol: number, options: SolveOptions = {}): boolean {
  const solver = new Solver(board, startRow, startCol, options);
  solver.propagate();
  return solver.safeRemaining === 0;
}

// Tier 2 (Hard): simple propagation, falling back to linear-programming bounds
// over the frontier whenever propagation stalls. Never uses the global mine count.
export function solveHard(board: Board, startRow: number, startCol: number, options: SolveOptions = {}): boolean {
  const solver = new Solver(board, startRow, startCol, options);
  do {
    solver.propagate();
    if (solver.safeRemaining === 0) return true;
  } while (solver.lpStep());
  return false;
}
