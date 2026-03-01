const ROWS = 16;
const COLS = 30;
const MINES = 99;

interface Cell {
  mine: boolean;
  revealed: boolean;
  neighborCount: number;
}

let board: Cell[][] = [];
let gameOver = false;
let firstClick = true;
let clickedMineRow = -1;
let clickedMineCol = -1;
let safeCellsRemaining = 0;

function createBoard(): void {
  gameOver = false;
  firstClick = true;
  clickedMineRow = -1;
  clickedMineCol = -1;
  board = [];
  for (let r = 0; r < ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < COLS; c++) {
      row.push({ mine: false, revealed: false, neighborCount: 0 });
    }
    board.push(row);
  }
}

function placeMines(safeRow: number, safeCol: number): void {
  let placed = 0;
  while (placed < MINES) {
    const r = Math.floor(Math.random() * ROWS);
    const c = Math.floor(Math.random() * COLS);
    if (r === safeRow && c === safeCol) continue;
    if (board[r][c].mine) continue;
    board[r][c].mine = true;
    placed++;
  }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c].mine) continue;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && board[nr][nc].mine) {
            count++;
          }
        }
      }
      board[r][c].neighborCount = count;
    }
  }
  safeCellsRemaining = ROWS * COLS - MINES;
}

function reveal(row: number, col: number): void {
  if (gameOver) return;
  const cell = board[row][col];
  if (cell.revealed) return;

  if (firstClick) {
    firstClick = false;
    placeMines(row, col);
  }

  cell.revealed = true;
  safeCellsRemaining--;

  if (cell.mine) {
    gameOver = true;
    clickedMineRow = row;
    clickedMineCol = col;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (board[r][c].mine) board[r][c].revealed = true;
      }
    }
    render();
    document.getElementById("message")!.textContent = "Game over! You hit a mine.";
    return;
  }

  if (checkWin()) {
    render();
    document.getElementById("message")!.textContent = "You win!";
    return;
  }

  render();
}

function checkWin(): boolean {
  if (safeCellsRemaining > 0) return false;
  gameOver = true;
  return true;
}

function updateCounter(): void {
  const counter = document.getElementById("counter")!;
  if (firstClick) {
    counter.textContent = "";
  } else {
    counter.textContent = String(safeCellsRemaining);
  }
}

function render(): void {
  const container = document.getElementById("game")!;
  container.innerHTML = "";

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = board[r][c];
      const div = document.createElement("div");
      div.className = "cell" + (cell.revealed ? " revealed" : "");

      if (cell.revealed) {
        if (cell.mine) {
          div.textContent = "💣";
          div.classList.add(r === clickedMineRow && c === clickedMineCol ? "mine-clicked" : "mine");
        } else if (cell.neighborCount > 0) {
          const circle = document.createElement("span");
          circle.className = `circle circle-${cell.neighborCount}`;
          div.appendChild(circle);
        }
      }

      if (!gameOver && !cell.revealed) {
        const row = r, col = c;
        div.addEventListener("click", () => reveal(row, col));
      }

      container.appendChild(div);
    }
  }
  updateCounter();
}

function newGame(): void {
  document.getElementById("message")!.textContent = "";
  createBoard();
  render();
}

newGame();
