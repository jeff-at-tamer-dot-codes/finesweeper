# Minesweeper

Minimal no-guess Minesweeper clone in TypeScript. No frameworks, no build tools beyond `tsc`.

## Build & Run

```
/opt/homebrew/bin/tsc
python3 -m http.server 8000   # then open http://localhost:8000
```

The game is an ES module and generates boards in a module Web Worker, and browsers won't load either from `file://`, so `open index.html` doesn't work.

Solver benchmark and Node-side type check (Node >= 23.6 runs `.ts` directly):

```
node bench-solvable.ts out.csv
node bench-consistency.ts [boards] [runsPerBoard] [mines]   # seed-dependence of each solver's verdict
/opt/homebrew/bin/tsc -p tsconfig.node.json
```

## Project Structure

- `minesweeper.ts` — game UI
- `generator-worker.ts` — Web Worker that runs the generate-and-test loop (and Never-mode rescues) off the main thread
- `solver.ts` — board generator and no-guess solvers (shared by the game and the benchmark)
- `lp.ts` — bounded-variable simplex used by the Hard solver (min/max of each variable over a linear system)
- `loss-analysis.ts` — `findLayout`: searches for a mine layout consistent with what the player has seen, with a chosen cell forced mine or safe; `analyzeLoss` uses it to decide whether a clicked mine was forced
- `bench-solvable.ts` — Node benchmark: boards generated per solvable board vs mine density
- `bench-consistency.ts` — Node benchmark: solves each seeded board several times with different solver seeds (`SolveOptions.random` shuffles every order-irrelevant choice) and counts boards whose verdict depends on the seed
- `index.html` / `minesweeper.css` — page and styles
- `tsconfig.json` — browser build (ES2020 modules, DOM, strict); `tsconfig.node.json` — type-check only for the Node files

## Current State

Playable no-guess Minesweeper: 20 rows, 30 columns, 130 mines, with an Easy/Hard selector, a Randomize Colors checkbox, and a guess-punishment selector (defaults: Hard, colors randomized, always punished). The first click can be anywhere and the board is generated around it. Only cells adjacent to a revealed cell are shown. No flagging — win by revealing all non-mine cells. No timer. No image assets (text only). Solvers never use the global mine count.

On a loss, the clicked mine is red if it was certainly a mine given what the player could see (revealed cells, colors only when colors are randomized, and the total mine count implied by the safe-cell counter) and green if some consistent layout had it safe. `analyzeLoss` finds this with a backtracking search over the frontier (clicked cell fixed safe, interior absorbs leftover mines); if it hits its node budget it reports "forced" (red) without proof.

Guess punishment (applies immediately, no new game):
- **Sometimes** — the board is fixed; clicking a mine loses (red or green as above).
- **Always** — clicking a cell that isn't provably safe switches to a consistent layout where it's a mine (green loss). Provably safe cells stay safe.
- **Never** — clicking a mine that wasn't forced switches (in the worker) to a random consistent layout where it's safe, retrying until the current tier's solver can finish from the current position (falls back to any consistent layout after 3 s).

Layout switches keep every revealed cell's color: with randomized colors a color class may now mean a different number, so `colorOf` is remapped.

## No-Guess Board Generation

The goal is to generate boards that are always solvable through pure logical deduction, using a generate-and-test approach: place mines randomly, run a solver, keep the board if solvable, otherwise regenerate.

### Solver Hierarchy

Three solver layers, each strictly more powerful than the last:

1. **Simple constraint propagation** (`solveSimple`) — "cell says N with N unrevealed neighbors → all mines" and "cell says N with N flagged neighbors → rest are safe"
2. **Linear-programming bounds** (`solveHard`) — runs simple propagation; when it stalls, models the frontier as linear equations (cells in [0, 1], ambiguous colors between their smallest and largest candidate) and computes each unknown's exact minimum and maximum with a simplex LP. Max < 1 → safe, min > 0 → mine; colors keep only candidates in range. This subsumes every bounds deduction from any linear combination of constraints — set/subset reasoning, pairwise overlaps, longer chains — and, unlike the Gaussian elimination + pair checks it replaced, doesn't depend on row/column order (`bench-consistency.ts` reports 0 order-dependent boards).
3. **Exhaustive enumeration** (not implemented) — enumerate all valid mine configurations for ambiguous regions, identify cells that are mines or safe in every configuration

### Randomize Colors

With the "Randomize Colors" checkbox, each new board shuffles which circle color means which number (blank still means 0), and boards are generated with `{ colorblind: true }` so they stay no-guess without knowing the mapping. The solver keeps a set of possible values per color.
- Easy: each cell of a color bounds its value to [known adjacent mines, known mines + unknown neighbors]; all-different singles (a settled color's value is taken from the others; a value only one color can mean is that color's). Cells are only propagated once their color's value is settled.
- Hard: additionally, ambiguous color values are LP variables, so constraints from same-colored numbers anywhere on the board are combined (e.g. two adjacent same-colored numbers force the cells beyond them to match).

### Difficulty Tiers

Three difficulty levels orthogonal to grid size/mine density. Each tier guarantees the board requires that level of reasoning:

1. **Easy** — solvable by simple constraint propagation alone
2. **Hard** — simple propagation fails; linear-programming bounds succeed
3. **Expert** (not implemented) — Hard solver fails; exhaustive enumeration succeeds

To validate a board for tier N: run the tier N-1 solver (must fail) and the tier N solver (must succeed).
