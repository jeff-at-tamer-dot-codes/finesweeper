// Finds boards where a solver's verdict depends on arbitrary ordering choices:
// each seeded board is solved several times with different solver seeds (see
// SolveOptions.random), and any board solved by some runs but not others is
// reported. Run with: node bench-consistency.ts [boards] [runsPerBoard] [mines]

import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { generateBoard, seededRandom, solveHard, solveSimple, type SolveOptions } from "./solver.ts";

const ROWS = 20;
const COLS = 30;
const START_ROW = Math.floor(ROWS / 2);
const START_COL = Math.floor(COLS / 2);
const CHUNK = 2000;
const EXAMPLES = 10;

const SOLVERS = {
  simple: (b, o) => solveSimple(b, START_ROW, START_COL, o),
  "simple/colorblind": (b, o) => solveSimple(b, START_ROW, START_COL, { ...o, colorblind: true }),
  hard: (b, o) => solveHard(b, START_ROW, START_COL, o),
  "hard/colorblind": (b, o) => solveHard(b, START_ROW, START_COL, { ...o, colorblind: true }),
} satisfies Record<string, (board: ReturnType<typeof generateBoard>, options: SolveOptions) => boolean>;
type SolverName = keyof typeof SOLVERS;

interface Tally {
  solvedAll: number;
  solvedSome: number;
  // Board seeds of inconsistent boards, with the per-run verdicts.
  examples: { boardSeed: number; verdicts: boolean[] }[];
}

interface Chunk {
  firstSeed: number;
  count: number;
  runs: number;
  mines: number;
}

// Solver seed for run k on a board; distinct from the board's own seed stream.
function solverSeed(boardSeed: number, run: number): number {
  return Math.imul(boardSeed, 0x9e3779b1) ^ Math.imul(run + 1, 0x85ebca6b);
}

function runChunk({ firstSeed, count, runs, mines }: Chunk): Record<SolverName, Tally> {
  const tallies = {} as Record<SolverName, Tally>;
  for (const name of Object.keys(SOLVERS) as SolverName[]) {
    tallies[name] = { solvedAll: 0, solvedSome: 0, examples: [] };
  }
  for (let boardSeed = firstSeed; boardSeed < firstSeed + count; boardSeed++) {
    const board = generateBoard(ROWS, COLS, mines, START_ROW, START_COL, seededRandom(boardSeed));
    for (const name of Object.keys(SOLVERS) as SolverName[]) {
      const verdicts: boolean[] = [];
      for (let run = 0; run < runs; run++) {
        verdicts.push(SOLVERS[name](board, { random: seededRandom(solverSeed(boardSeed, run)) }));
      }
      const solved = verdicts.filter(Boolean).length;
      const t = tallies[name];
      if (solved === runs) t.solvedAll++;
      else if (solved > 0) {
        t.solvedSome++;
        if (t.examples.length < EXAMPLES) t.examples.push({ boardSeed, verdicts });
      }
    }
  }
  return tallies;
}

if (isMainThread) {
  const boards = Number(process.argv[2] ?? 200_000);
  const runs = Number(process.argv[3] ?? 4);
  const mines = Number(process.argv[4] ?? 130);
  const chunks: Chunk[] = [];
  for (let s = 1; s <= boards; s += CHUNK) chunks.push({ firstSeed: s, count: Math.min(CHUNK, boards - s + 1), runs, mines });

  const total = {} as Record<SolverName, Tally>;
  for (const name of Object.keys(SOLVERS) as SolverName[]) total[name] = { solvedAll: 0, solvedSome: 0, examples: [] };
  const start = Date.now();
  let next = 0;
  const workers = Math.min(availableParallelism(), chunks.length);
  await new Promise<void>((resolve) => {
    let active = 0;
    const dispatch = (w: Worker): void => {
      if (next >= chunks.length) {
        w.terminate();
        if (--active === 0) resolve();
        return;
      }
      w.postMessage(chunks[next++]);
    };
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL(import.meta.url));
      active++;
      w.on("message", (part: Record<SolverName, Tally>) => {
        for (const name of Object.keys(part) as SolverName[]) {
          total[name].solvedAll += part[name].solvedAll;
          total[name].solvedSome += part[name].solvedSome;
          total[name].examples.push(...part[name].examples);
        }
        dispatch(w);
      });
      dispatch(w);
    }
  });

  console.log(`${boards} boards (${ROWS}x${COLS}, ${mines} mines, center click), ${runs} seeded runs each, ` +
    `${((Date.now() - start) / 1000).toFixed(0)}s on ${workers} workers`);
  for (const name of Object.keys(total) as SolverName[]) {
    const t = total[name];
    const examples = t.examples.sort((a, b) => a.boardSeed - b.boardSeed).slice(0, EXAMPLES);
    console.log(
      `${name.padEnd(20)} solved by every run: ${String(t.solvedAll).padStart(7)}   ` +
        `solved by only some runs: ${String(t.solvedSome).padStart(5)}` +
        (t.solvedAll + t.solvedSome > 0
          ? ` (${((100 * t.solvedSome) / (t.solvedAll + t.solvedSome)).toFixed(3)}% of solvable)`
          : ""),
    );
    for (const e of examples) {
      console.log(`    board seed ${e.boardSeed}: ${e.verdicts.map((v) => (v ? "solved" : "stuck")).join(", ")}`);
    }
  }
} else {
  parentPort!.on("message", (chunk: Chunk) => parentPort!.postMessage(runChunk(chunk)));
}
