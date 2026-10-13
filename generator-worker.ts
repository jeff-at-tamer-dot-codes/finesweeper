// Background thread for no-guess board generation, so a long generate-and-test
// run doesn't freeze the page.

import { findLayout } from "./loss-analysis.ts";
import {
  type Board, boardFromMines, generateBoardWithEight, hasEveryNumber, neighborsFor, solveHard, solveSimple,
} from "./solver.ts";

export type Difficulty = "easy" | "hard";

export interface GenerateRequest {
  kind: "generate";
  rows: number;
  cols: number;
  mines: number;
  row: number;
  col: number;
  tier: Difficulty;
  // The player can't see which color means which number, so neither can the solver.
  colorblind: boolean;
}

// The player clicked a mine that could have been safe; find a layout,
// consistent with what they've seen, in which it is.
export interface RescueRequest {
  kind: "rescue";
  board: Board;
  revealed: Uint8Array;
  clicked: number;
  tier: Difficulty;
  colorblind: boolean;
}

export interface GenerateResult {
  board: Board;
  // For a rescue: values[k] is the number shown by cells currently labeled k.
  values?: Int32Array;
  // For a rescue: whether the rest of the board is still no-guess.
  noGuess?: boolean;
}

const RESCUE_TIME_MS = 3000;

// Generate-and-test: draw random boards, each with an 8 built in, until one
// shows every number (see hasEveryNumber) and needs exactly the chosen tier of
// reasoning. Easy must be
// solvable by simple propagation; Hard must not be, but must be solvable with
// linear-programming bounds.
function generateNoGuess({ rows, cols, mines, row, col, tier, colorblind }: GenerateRequest): Board {
  for (;;) {
    const candidate = generateBoardWithEight(rows, cols, mines, row, col);
    if (!hasEveryNumber(candidate)) continue;
    const simple = solveSimple(candidate, row, col, { colorblind });
    if (tier === "easy" ? simple : !simple && solveHard(candidate, row, col, { colorblind })) return candidate;
  }
}

// Draws random consistent layouts with the clicked cell safe until one shows
// every number and the chosen tier's solver can finish the game from the
// current position. Each try builds its 8 around a random cell the player
// can't see yet (off the edges, not walling in the clicked cell). Falls back
// to any consistent layout if none is found in time.
export function rescue({ board, revealed, clicked, tier, colorblind }: RescueRequest): GenerateResult {
  const { rows, cols } = board;
  const row = Math.floor(clicked / cols);
  const col = clicked % cols;
  const solve = tier === "easy" ? solveSimple : solveHard;
  const neighbors = neighborsFor(rows, cols);
  const centers: number[] = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      if (revealed[i] || neighbors[i].some((n) => revealed[n] || n === clicked)) continue;
      centers.push(i);
    }
  }
  const deadline = performance.now() + RESCUE_TIME_MS;
  let fallback: GenerateResult | null = null;
  do {
    const fixed = new Map<number, number>();
    if (centers.length > 0) {
      const center = centers[Math.floor(Math.random() * centers.length)];
      fixed.set(center, 0);
      for (const n of neighbors[center]) fixed.set(n, 1);
    }
    const found = findLayout(board, revealed, clicked, false, colorblind, { random: Math.random, fixed });
    if (!found.found) continue;
    const candidate = boardFromMines(rows, cols, found.layout!);
    fallback ??= { board: candidate, values: found.values, noGuess: false };
    if (hasEveryNumber(candidate) && solve(candidate, row, col, { colorblind, revealed })) {
      return { board: candidate, values: found.values, noGuess: true };
    }
  } while (performance.now() < deadline);
  if (fallback) return fallback;
  const found = findLayout(board, revealed, clicked, false, colorblind, { random: Math.random });
  if (!found.found) throw new Error("rescue: no layout with the clicked cell safe");
  return { board: boardFromMines(rows, cols, found.layout!), values: found.values, noGuess: false };
}

addEventListener("message", (event: MessageEvent<GenerateRequest | RescueRequest>) => {
  const result = event.data.kind === "generate" ? { board: generateNoGuess(event.data) } : rescue(event.data);
  postMessage(result);
});
