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
let prevVisible: boolean[][] = [];

function createBoard(): void {
  gameOver = false;
  firstClick = true;
  clickedMineRow = -1;
  clickedMineCol = -1;
  board = [];
  prevVisible = [];
  for (let r = 0; r < ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < COLS; c++) {
      row.push({ mine: false, revealed: false, neighborCount: 0 });
    }
    board.push(row);
    prevVisible.push(new Array(COLS).fill(true));
  }
}

function fixEdgeFiftyFifties(): void {
  function fixRow(thirdRow: number, edgeRow1: number, edgeRow2: number): void {
    for (let c = 0; c < COLS; c++) {
      if (!board[thirdRow][c].mine) continue;
      const isLeft = c === 0;
      const isRight = c === COLS - 1;
      if (isLeft) {
        if (!board[thirdRow][1].mine) continue;
      } else if (isRight) {
        if (!board[thirdRow][COLS - 2].mine) continue;
      } else {
        if (!board[thirdRow][c - 1].mine || !board[thirdRow][c + 1].mine) continue;
      }
      const e1 = board[edgeRow1][c].mine;
      const e2 = board[edgeRow2][c].mine;
      if (e1 === e2) continue;
      const targetRow = e1 ? edgeRow2 : edgeRow1;
      board[thirdRow][c].mine = false;
      board[targetRow][c].mine = true;
    }
  }

  function fixCol(thirdCol: number, edgeCol1: number, edgeCol2: number): void {
    for (let r = 0; r < ROWS; r++) {
      if (!board[r][thirdCol].mine) continue;
      const isTop = r === 0;
      const isBottom = r === ROWS - 1;
      if (isTop) {
        if (!board[1][thirdCol].mine) continue;
      } else if (isBottom) {
        if (!board[ROWS - 2][thirdCol].mine) continue;
      } else {
        if (!board[r - 1][thirdCol].mine || !board[r + 1][thirdCol].mine) continue;
      }
      const e1 = board[r][edgeCol1].mine;
      const e2 = board[r][edgeCol2].mine;
      if (e1 === e2) continue;
      const targetCol = e1 ? edgeCol2 : edgeCol1;
      board[r][thirdCol].mine = false;
      board[r][targetCol].mine = true;
    }
  }

  function fixRowDiag(thirdRow: number, outerRow: number, innerRow: number): void {
    for (let c = 0; c <= COLS - 4; c++) {
      if (!board[thirdRow][c].mine || !board[thirdRow][c + 3].mine) continue;
      const group: [number, number][] = [
        [outerRow, c + 1], [outerRow, c + 2],
        [innerRow, c + 1], [innerRow, c + 2]
      ];
      const mines = group.filter(([r, cc]) => board[r][cc].mine);
      if (mines.length !== 2) continue;
      if (mines[0][0] === mines[1][0] || mines[0][1] === mines[1][1]) continue;
      board[thirdRow][c].mine = false;
      board[thirdRow][c + 3].mine = false;
      for (const [r, cc] of group) board[r][cc].mine = true;
    }

    if (board[thirdRow][2].mine) {
      const group: [number, number][] = [
        [outerRow, 0], [outerRow, 1],
        [innerRow, 0], [innerRow, 1]
      ];
      const mines = group.filter(([r, c]) => board[r][c].mine);
      if (mines.length === 2 && mines[0][0] !== mines[1][0] && mines[0][1] !== mines[1][1]) {
        board[outerRow][0].mine = true;
        board[outerRow][1].mine = true;
        board[innerRow][0].mine = true;
        board[innerRow][1].mine = false;
        board[thirdRow][2].mine = false;
      }
    }

    if (board[thirdRow][COLS - 3].mine) {
      const group: [number, number][] = [
        [outerRow, COLS - 2], [outerRow, COLS - 1],
        [innerRow, COLS - 2], [innerRow, COLS - 1]
      ];
      const mines = group.filter(([r, c]) => board[r][c].mine);
      if (mines.length === 2 && mines[0][0] !== mines[1][0] && mines[0][1] !== mines[1][1]) {
        board[outerRow][COLS - 1].mine = true;
        board[outerRow][COLS - 2].mine = true;
        board[innerRow][COLS - 1].mine = true;
        board[innerRow][COLS - 2].mine = false;
        board[thirdRow][COLS - 3].mine = false;
      }
    }
  }

  function fixColDiag(thirdCol: number, outerCol: number, innerCol: number): void {
    for (let r = 0; r <= ROWS - 4; r++) {
      if (!board[r][thirdCol].mine || !board[r + 3][thirdCol].mine) continue;
      const group: [number, number][] = [
        [r + 1, outerCol], [r + 1, innerCol],
        [r + 2, outerCol], [r + 2, innerCol]
      ];
      const mines = group.filter(([rr, c]) => board[rr][c].mine);
      if (mines.length !== 2) continue;
      if (mines[0][0] === mines[1][0] || mines[0][1] === mines[1][1]) continue;
      board[r][thirdCol].mine = false;
      board[r + 3][thirdCol].mine = false;
      for (const [rr, c] of group) board[rr][c].mine = true;
    }
  }

  fixRow(2, 0, 1);
  fixRow(ROWS - 3, ROWS - 2, ROWS - 1);
  fixCol(2, 0, 1);
  fixCol(COLS - 3, COLS - 2, COLS - 1);

  fixRowDiag(2, 0, 1);
  fixRowDiag(ROWS - 3, ROWS - 1, ROWS - 2);
  fixColDiag(2, 0, 1);
  fixColDiag(COLS - 3, COLS - 1, COLS - 2);
}

function placeMines(safeRow: number, safeCol: number): void {
  let placed = 0;
  while (placed < MINES) {
    const r = Math.floor(Math.random() * ROWS);
    const c = Math.floor(Math.random() * COLS);
    if (Math.abs(r - safeRow) <= 1 && Math.abs(c - safeCol) <= 1) continue;
    if (board[r][c].mine) continue;
    board[r][c].mine = true;
    placed++;
  }
  fixEdgeFiftyFifties();
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

function revealCell(row: number, col: number): void {
  const cell = board[row][col];
  if (cell.revealed || cell.mine) return;
  cell.revealed = true;
  safeCellsRemaining--;
  if (cell.neighborCount === 0) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
          revealCell(nr, nc);
        }
      }
    }
  }
}

function reveal(row: number, col: number): void {
  if (gameOver) return;
  const cell = board[row][col];
  if (cell.revealed) return;

  if (firstClick) {
    firstClick = false;
    placeMines(row, col);
  }

  revealCell(row, col);

  if (cell.mine) {
    gameOver = true;
    clickedMineRow = row;
    clickedMineCol = col;
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
  if (safeCellsRemaining === 0) {
    gameOver = true;
    return true;
  }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!board[r][c].revealed && !board[r][c].mine && adjacentToRevealed(r, c)) {
        return false;
      }
    }
  }
  gameOver = true;
  return true;
}

function adjacentToRevealed(row: number, col: number): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && board[nr][nc].revealed) {
        return true;
      }
    }
  }
  return false;
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
      const showMine = cell.mine && gameOver && adjacentToRevealed(r, c);
      const isRevealed = cell.revealed || showMine;
      const visible = firstClick || isRevealed || adjacentToRevealed(r, c);
      const wasVisible = prevVisible[r][c];
      const div = document.createElement("div");
      div.className = "cell" + (isRevealed ? " revealed" : "");
      if (!visible) {
        div.classList.add(wasVisible ? "pop-out" : "hidden");
      } else if (!wasVisible) {
        div.classList.add("pop-in");
      }
      prevVisible[r][c] = visible;

      if (showMine) {
        div.textContent = clickedMineRow === -1 ? "🌺" : "💣";
        div.classList.add(r === clickedMineRow && c === clickedMineCol ? "mine-clicked" : "mine");
      } else if (cell.revealed && cell.neighborCount > 0) {
        const circle = document.createElement("span");
        circle.className = `circle circle-${cell.neighborCount}`;
        div.appendChild(circle);
      }

      if (!gameOver && !isRevealed && visible) {
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
