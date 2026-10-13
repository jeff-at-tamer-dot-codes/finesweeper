// Measures how many random boards must be generated, on average, before one is
// solvable by each solver. Run with: node bench-solvable.ts [out.csv]
// (Node >= 23.6 runs .ts directly by stripping types.)

import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { writeFileSync } from "node:fs";
import { generateBoard, seededRandom, solveHard, solveSimple } from "./solver.ts";

const SOLVERS = { simple: solveSimple, hard: solveHard };
type SolverName = keyof typeof SOLVERS;

interface Job {
  solver: SolverName;
  rows: number;
  cols: number;
  mines: number;
  density: number;
  maxTrials: number;
}

interface Result extends Job {
  trials: number;
  successes: number;
  ms: number;
}

// Stop a datapoint once it has this many solvable boards (≈ ±10% CI on the
// mean) or has spent its trial budget without getting there.
const TARGET_SUCCESSES = 400;
const MAX_TRIALS = 3_000_000;
const HIGHLIGHT_MAX_TRIALS = 10_000_000;
// A datapoint with fewer solvable boards than this is too rare to estimate
// well; once one occurs, higher densities for that board size are skipped.
const MIN_SUCCESSES = 20;

function runJob(job: Job): Result {
  const { rows, cols, mines } = job;
  const solve = SOLVERS[job.solver];
  const start = performance.now();
  // First click in the center (for even dimensions, the lower/right of the middle two).
  const r = Math.floor(rows / 2);
  const c = Math.floor(cols / 2);
  // Seeded by mine count, so every solver sees the same board sequence.
  const random = seededRandom(mines);
  let trials = 0;
  let successes = 0;
  while (successes < TARGET_SUCCESSES && trials < job.maxTrials) {
    const board = generateBoard(rows, cols, mines, r, c, random);
    trials++;
    if (solve(board, r, c)) successes++;
  }
  return { ...job, trials, successes, ms: performance.now() - start };
}

// 95% Wilson interval on the success probability, inverted to expected boards.
function expectedBoards(res: Result): { mean: number; lo: number; hi: number } {
  const n = res.trials;
  const p = res.successes / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { mean: 1 / p, lo: 1 / (center + half), hi: 1 / Math.max(center - half, 0) };
}

if (isMainThread) {
  const [rows, cols, highlight] = [20, 30, 130];
  const size = rows * cols;
  const jobs: Job[] = [];
  for (const solver of Object.keys(SOLVERS) as SolverName[]) {
    const mineSet = new Set<number>();
    for (let k = 0; k <= 80; k++) {
      mineSet.add(Math.min(Math.round((k / 80) * size), size - 9));
    }
    mineSet.add(highlight);
    for (const mines of mineSet) {
      const maxTrials = mines === highlight ? HIGHLIGHT_MAX_TRIALS : MAX_TRIALS;
      jobs.push({ solver, rows, cols, mines, density: mines / size, maxTrials });
    }
  }
  // Interleave solvers in density order so the cutoff below kicks in for both early.
  jobs.sort((a, b) => a.density - b.density);
  const cutoff = new Map<SolverName, number>();
  const isCut = (job: Job): boolean =>
    job.maxTrials === MAX_TRIALS && job.mines > (cutoff.get(job.solver) ?? Infinity);

  const results: Result[] = [];
  let next = 0;
  const workers = Math.min(availableParallelism(), jobs.length);
  const start = Date.now();
  await new Promise<void>((resolve) => {
    let active = 0;
    const dispatch = (w: Worker): void => {
      while (next < jobs.length && isCut(jobs[next])) next++;
      if (next >= jobs.length) {
        w.terminate();
        if (--active === 0) resolve();
        return;
      }
      w.postMessage(jobs[next++]);
    };
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL(import.meta.url));
      active++;
      w.on("message", (res: Result) => {
        results.push(res);
        if (res.successes < MIN_SUCCESSES && res.mines < (cutoff.get(res.solver) ?? Infinity)) {
          cutoff.set(res.solver, res.mines);
        }
        const e = expectedBoards(res);
        console.error(
          `${res.solver} ${res.rows}x${res.cols} mines=${res.mines} density=${res.density.toFixed(4)} ` +
            `trials=${res.trials} solvable=${res.successes} E[boards]=${e.mean.toFixed(2)} ` +
            `(${((Date.now() - start) / 1000).toFixed(0)}s)`,
        );
        dispatch(w);
      });
      dispatch(w);
    }
  });

  results.sort((a, b) => a.solver.localeCompare(b.solver) || a.mines - b.mines);
  const lines = [
    "solver,rows,cols,mines,density,trials,solvable,p_solvable,expected_boards,ci95_lo,ci95_hi,us_per_board",
  ];
  for (const res of results) {
    const e = expectedBoards(res);
    lines.push(
      [res.solver, res.rows, res.cols, res.mines, res.density.toFixed(5), res.trials, res.successes,
        (res.successes / res.trials).toPrecision(5), e.mean.toPrecision(5),
        e.lo.toPrecision(5), e.hi.toPrecision(5), ((res.ms * 1000) / res.trials).toPrecision(4)].join(","),
    );
  }
  const out = process.argv[2] ?? "bench-solvable.csv";
  writeFileSync(out, lines.join("\n") + "\n");
  console.error(`wrote ${out} in ${((Date.now() - start) / 1000).toFixed(0)}s using ${workers} workers`);
} else {
  parentPort!.on("message", (job: Job) => parentPort!.postMessage(runJob(job)));
}
