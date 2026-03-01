# Minesweeper

Minimal no-guess Minesweeper clone in TypeScript. No frameworks, no build tools beyond `tsc`.

## Build & Run

```
/opt/homebrew/bin/tsc
open index.html
```

## Project Structure

- `minesweeper.ts` — all game logic (single file)
- `index.html` — loads compiled JS, inline CSS
- `tsconfig.json` — minimal config (ES2020, DOM, strict)

## Current State

Basic playable Minesweeper: 16 rows, 30 columns, 99 mines. Click to reveal, first click is safe. No flagging — win by revealing all non-mine cells. No auto-reveal of zero-neighbor cells. No timer, no mine counter. No image assets (text only).

## No-Guess Board Generation (Planned)

The goal is to generate boards that are always solvable through pure logical deduction, using a generate-and-test approach: place mines randomly, run a solver, keep the board if solvable, otherwise regenerate.

### Solver Hierarchy

Four solver layers, each strictly more powerful than the last:

1. **Simple constraint propagation** — "cell says N with N unrevealed neighbors → all mines" and "cell says N with N flagged neighbors → rest are safe"
2. **Set/subset reasoning** — if cells {A,B,C} contain 2 mines and subset {A,B} contains 1 mine, then {C} contains 1 mine
3. **Gaussian elimination** — model boundary constraints as linear equations, row-reduce to find forced cells. Strictly more powerful than set/subset reasoning (subsumes it, but can also combine constraints from many cells simultaneously in ways pairwise subset comparisons miss)
4. **Exhaustive enumeration** — enumerate all valid mine configurations for ambiguous regions, identify cells that are mines or safe in every configuration

### Difficulty Tiers (Planned)

Four difficulty levels orthogonal to grid size/mine density. Each tier guarantees the board requires that level of reasoning:

1. **Easy** — solvable by simple constraint propagation alone
2. **Medium** — simple propagation alone fails; set/subset reasoning + propagation succeeds
3. **Hard** — set/subset reasoning fails; Gaussian elimination succeeds
4. **Expert** — Gaussian elimination fails; exhaustive enumeration succeeds

To validate a board for tier N: run the tier N-1 solver (must fail) and the tier N solver (must succeed).
