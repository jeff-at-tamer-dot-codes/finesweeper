import type { Difficulty, GenerateRequest, GenerateResult, RescueRequest } from "./generator-worker.ts";
import { analyzeLoss, classifyFrontier, findLayout } from "./loss-analysis.ts";
import { type Board, boardFromMines, eightCell } from "./solver.ts";

const ROWS = 20;
const COLS = 30;
const MINES = 130;

let board: Board | null = null;
let revealed = new Uint8Array(ROWS * COLS);
let gameOver = false;
let generator: Worker | null = null;
let clickedMine = -1;
// Whether the clicked mine was certain given what the player could see.
let clickedMineForced = false;
// After a loss: frontier cells that were certainly safe, or certainly mines,
// given what the player could see.
let certainlySafe = new Set<number>();
let certainMines = new Set<number>();
let colorblindGame = false;
let safeCellsRemaining = 0;
let prevVisible: boolean[] = [];
// colorOf[n] is the circle color shown for count n.
let colorOf = [0, 1, 2, 3, 4, 5, 6, 7, 8];

// After a win every mine shows the same flower, which changes every few
// seconds in a diagonal sweep from the top-left corner.
const FLOWERS = ["🌺", "🌹", "🌸", "💐", "🌷", "🌻", "🌼", "🪻"];
const FLOWER_SWAP_MS = 4000;
const FLOWER_SWEEP_STEP_MS = 20; // delay per diagonal
let flower = "";
let flowerTimer: number | undefined;

// Easy is still supported by the worker, but not offered for now.
const TIER: Difficulty = "hard";

type Punishment = "always" | "sometimes" | "never";

function punishment(): Punishment {
  return (document.getElementById("punish") as HTMLSelectElement).value as Punishment;
}

function randomizeColors(): boolean {
  return (document.getElementById("randomize-colors") as HTMLInputElement).checked;
}

function shuffledColors(): number[] {
  const colors = [1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = colors.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  return [0, ...colors];
}

function neighbors(i: number): number[] {
  const r = Math.floor(i / COLS);
  const c = i % COLS;
  const result: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) result.push(nr * COLS + nc);
    }
  }
  return result;
}

function revealCell(start: number): void {
  const stack = [start];
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (revealed[i] || board!.mines[i]) continue;
    revealed[i] = 1;
    safeCellsRemaining--;
    if (board!.counts[i] === 0) stack.push(...neighbors(i));
  }
}

// Runs one job on a fresh background worker; clicks are ignored until it answers.
function runWorker(message: string, request: GenerateRequest | RescueRequest, done: (result: GenerateResult) => void): void {
  document.getElementById("message")!.textContent = message;
  const worker = new Worker(new URL("./generator-worker.js", import.meta.url), { type: "module" });
  generator = worker;
  worker.addEventListener("message", (event: MessageEvent<GenerateResult>) => {
    worker.terminate();
    generator = null;
    document.getElementById("message")!.textContent = "";
    done(event.data);
  });
  worker.postMessage(request);
}

function startGame(i: number): void {
  const colorblind = randomizeColors();
  colorblindGame = colorblind;
  colorOf = colorblind ? shuffledColors() : [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const request: GenerateRequest = {
    kind: "generate", rows: ROWS, cols: COLS, mines: MINES, row: Math.floor(i / COLS), col: i % COLS,
    tier: TIER, colorblind,
  };
  runWorker("Generating board…", request, (result) => {
    board = result.board;
    safeCellsRemaining = ROWS * COLS - MINES;
    reveal(i);
  });
}

// Switches to a different layout that agrees with everything the player has
// seen. values[k] is the number now shown by cells currently labeled k; the
// circle colors are remapped so every revealed cell keeps its color.
function adoptLayout(next: Board, values: Int32Array): void {
  const nextColorOf = [0, -1, -1, -1, -1, -1, -1, -1, -1];
  const usedColors = new Set<number>();
  for (let i = 0; i < ROWS * COLS; i++) {
    const k = board!.counts[i];
    if (!revealed[i] || k === 0) continue;
    nextColorOf[values[k]] = colorOf[k];
    usedColors.add(colorOf[k]);
  }
  const spare = shuffledColors().filter((color) => color > 0 && !usedColors.has(color));
  for (let n = 1; n <= 8; n++) if (nextColorOf[n] < 0) nextColorOf[n] = spare.pop()!;
  colorOf = nextColorOf;
  board = next;
}

function lose(i: number, forced: boolean): void {
  gameOver = true;
  clickedMine = i;
  clickedMineForced = forced;
  const { safe, mines } = classifyFrontier(board!, revealed, colorblindGame);
  certainlySafe = new Set(safe);
  certainMines = new Set(mines);
  render();
  document.getElementById("message")!.textContent = "Game over! You hit a mine.";
}

function reveal(i: number): void {
  if (gameOver || generator || revealed[i]) return;
  if (!board) {
    startGame(i);
    return;
  }

  if (board.mines[i]) {
    const forced = analyzeLoss(board, revealed, i, colorblindGame).forced;
    if (forced || punishment() !== "never") {
      lose(i, forced);
      return;
    }
    // Never punished: move the mine elsewhere, keeping the rest no-guess.
    const request: RescueRequest = {
      kind: "rescue", board, revealed, clicked: i, tier: TIER, colorblind: colorblindGame,
    };
    runWorker("", request, (result) => {
      adoptLayout(result.board, result.values!);
      reveal(i);
    });
    return;
  }

  if (punishment() === "always" && adjacentToRevealed(i)) {
    // Always punished: if this cell could have been a mine, it is one.
    const found = findLayout(board, revealed, i, true, colorblindGame);
    if (found.found) {
      adoptLayout(boardFromMines(ROWS, COLS, found.layout!), found.values!);
      lose(i, false);
      return;
    }
  }

  revealCell(i);

  if (safeCellsRemaining === 0) {
    gameOver = true;
    flower = randomFlower();
    flowerTimer = setInterval(swapFlowers, FLOWER_SWAP_MS);
    render();
    document.getElementById("message")!.textContent = "You win!";
    return;
  }

  render();
}

function randomFlower(): string {
  const others = FLOWERS.filter((f) => f !== flower);
  return others[Math.floor(Math.random() * others.length)];
}

function swapFlowers(): void {
  const next = randomFlower();
  flower = next;
  document.querySelectorAll<HTMLElement>(".flower").forEach((span) => {
    span.classList.add("flower-out");
    span.onanimationend = () => {
      if (span.classList.contains("flower-out")) {
        span.textContent = next;
        span.classList.replace("flower-out", "flower-in");
      } else {
        span.classList.remove("flower-in");
      }
    };
  });
}

function adjacentToRevealed(i: number): boolean {
  return neighbors(i).some((n) => revealed[n]);
}

function updateCounter(): void {
  document.getElementById("counter")!.textContent = board ? String(safeCellsRemaining) : "";
}

function render(): void {
  const container = document.getElementById("game")!;
  container.innerHTML = "";
  // The 8 is walled in by mines, so it stays out of sight until it's the last
  // safe cell left; clicking it wins.
  const finalEight = board && !gameOver && safeCellsRemaining === 1 ? eightCell(board) : -1;

  for (let i = 0; i < ROWS * COLS; i++) {
    const mine = board !== null && board.mines[i] === 1;
    const showMine = mine && gameOver && adjacentToRevealed(i);
    const isRevealed = revealed[i] === 1 || showMine;
    const visible = !board || isRevealed || adjacentToRevealed(i) || i === finalEight;
    const wasVisible = prevVisible[i];
    const div = document.createElement("div");
    div.className = "cell" + (isRevealed ? " revealed" : "");
    if (!visible) {
      div.classList.add(wasVisible ? "pop-out" : "hidden");
    } else if (!wasVisible) {
      div.classList.add("pop-in");
    }
    prevVisible[i] = visible;

    if (showMine && clickedMine === -1) {
      const span = document.createElement("span");
      span.className = "flower";
      span.textContent = flower;
      const diagonal = Math.floor(i / COLS) + (i % COLS);
      span.style.setProperty("--sweep-delay", `${diagonal * FLOWER_SWEEP_STEP_MS}ms`);
      div.appendChild(span);
    } else if (showMine) {
      const clicked = i === clickedMine;
      div.textContent = clicked ? "💥" : "💣";
      const forced = clicked ? clickedMineForced : certainMines.has(i);
      div.classList.add(forced ? "mine-forced" : clicked ? "mine-unlucky" : "mine");
    } else if (certainlySafe.has(i)) {
      div.textContent = "👍";
    } else if (revealed[i] && board!.counts[i] > 0) {
      const circle = document.createElement("span");
      circle.className = `circle circle-${colorOf[board!.counts[i]]}`;
      div.appendChild(circle);
    }

    if (!gameOver && !isRevealed && visible) {
      div.addEventListener("click", () => reveal(i));
    }

    container.appendChild(div);
  }
  updateCounter();
}

function newGame(): void {
  // Starting over mid-generation abandons that board.
  generator?.terminate();
  generator = null;
  clearInterval(flowerTimer);
  document.getElementById("message")!.textContent = "";
  board = null;
  revealed = new Uint8Array(ROWS * COLS);
  gameOver = false;
  clickedMine = -1;
  certainlySafe = new Set();
  certainMines = new Set();
  safeCellsRemaining = 0;
  prevVisible = new Array(ROWS * COLS).fill(true);
  render();
}

document.getElementById("new-game")!.addEventListener("click", newGame);
document.getElementById("randomize-colors")!.addEventListener("change", newGame);
newGame();
