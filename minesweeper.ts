import type { Difficulty, GenerateRequest, GenerateResult, RescueRequest } from "./generator-worker.ts";
import { analyzeLoss, findLayout } from "./loss-analysis.ts";
import { type Board, boardFromMines } from "./solver.ts";

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
let colorblindGame = false;
let safeCellsRemaining = 0;
let prevVisible: boolean[] = [];
// colorOf[n] is the circle color shown for count n.
let colorOf = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function difficulty(): Difficulty {
  return (document.getElementById("difficulty") as HTMLSelectElement).value as Difficulty;
}

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
    tier: difficulty(), colorblind,
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
      kind: "rescue", board, revealed, clicked: i, tier: difficulty(), colorblind: colorblindGame,
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
    render();
    document.getElementById("message")!.textContent = "You win!";
    return;
  }

  render();
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

  for (let i = 0; i < ROWS * COLS; i++) {
    const mine = board !== null && board.mines[i] === 1;
    const showMine = mine && gameOver && adjacentToRevealed(i);
    const isRevealed = revealed[i] === 1 || showMine;
    const visible = !board || isRevealed || adjacentToRevealed(i);
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
      div.textContent = "🌺";
    } else if (showMine) {
      div.textContent = "💣";
      div.classList.add(i !== clickedMine ? "mine" : clickedMineForced ? "mine-clicked" : "mine-unlucky");
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
  document.getElementById("message")!.textContent = "";
  board = null;
  revealed = new Uint8Array(ROWS * COLS);
  gameOver = false;
  clickedMine = -1;
  safeCellsRemaining = 0;
  prevVisible = new Array(ROWS * COLS).fill(true);
  render();
}

document.getElementById("new-game")!.addEventListener("click", newGame);
document.getElementById("difficulty")!.addEventListener("change", newGame);
document.getElementById("randomize-colors")!.addEventListener("change", newGame);
newGame();
