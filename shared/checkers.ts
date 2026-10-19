/**
 * Checkers (8×8, American rules): pieces on dark squares, men move one step
 * diagonally forward, kings both ways; a capture jumps an opponent's piece and
 * is mandatory; a piece that captured goes on capturing in the same turn; a man
 * reaching the far row is crowned (and its turn ends). A player with no piece
 * or no legal move loses. Red starts at the bottom (rows 5–7) and moves first.
 *
 * The board is 64 characters, row by row from the top: "." empty, "r"/"b" men,
 * "R"/"B" kings. The same rules run on the server (every move is checked there)
 * and in the browser (to show the legal moves).
 */
export type Side = "r" | "b";
export type Move = { from: number; to: number; captured: number | null };
export type GameState = { board: string; turn: Side; mustFrom: number | null };

export const START_BOARD = (() => {
  const cells: string[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const dark = (r + c) % 2 === 1;
      cells.push(!dark ? "." : r < 3 ? "b" : r > 4 ? "r" : ".");
    }
  }
  return cells.join("");
})();

export const startState = (): GameState => ({ board: START_BOARD, turn: "r", mustFrom: null });

const side = (cell: string): Side | null => (cell === "r" || cell === "R" ? "r" : cell === "b" || cell === "B" ? "b" : null);
const isKing = (cell: string) => cell === "R" || cell === "B";
const rc = (i: number) => [Math.floor(i / 8), i % 8] as const;
const at = (r: number, c: number) => (r >= 0 && r < 8 && c >= 0 && c < 8 ? r * 8 + c : -1);

/** Directions a piece may go: men forward only (red up, black down), kings both ways */
function directions(cell: string): [number, number][] {
  const up: [number, number][] = [
    [-1, -1],
    [-1, 1],
  ];
  const down: [number, number][] = [
    [1, -1],
    [1, 1],
  ];
  if (isKing(cell)) return [...up, ...down];
  return side(cell) === "r" ? up : down;
}

/** The moves of one piece (captures, then plain steps) */
function pieceMoves(board: string, from: number): { captures: Move[]; steps: Move[] } {
  const cell = board[from];
  const me = side(cell);
  const captures: Move[] = [];
  const steps: Move[] = [];
  if (!me) return { captures, steps };
  const [r, c] = rc(from);
  for (const [dr, dc] of directions(cell)) {
    const next = at(r + dr, c + dc);
    if (next < 0) continue;
    if (board[next] === ".") steps.push({ from, to: next, captured: null });
    else if (side(board[next]) && side(board[next]) !== me) {
      const land = at(r + 2 * dr, c + 2 * dc);
      if (land >= 0 && board[land] === ".") captures.push({ from, to: land, captured: next });
    }
  }
  return { captures, steps };
}

/** Every legal move for the side to play (captures are mandatory; a capture in progress goes on with its piece) */
export function legalMoves(s: GameState): Move[] {
  if (s.mustFrom !== null) return pieceMoves(s.board, s.mustFrom).captures;
  const captures: Move[] = [];
  const steps: Move[] = [];
  for (let i = 0; i < 64; i++) {
    if (side(s.board[i]) !== s.turn) continue;
    const m = pieceMoves(s.board, i);
    captures.push(...m.captures);
    steps.push(...m.steps);
  }
  return captures.length ? captures : steps;
}

/** Play a move (it must be legal); the turn passes unless the same piece can capture again */
export function play(s: GameState, from: number, to: number): GameState | null {
  const move = legalMoves(s).find((m) => m.from === from && m.to === to);
  if (!move) return null;
  const cells = s.board.split("");
  let piece = cells[from];
  cells[from] = ".";
  if (move.captured !== null) cells[move.captured] = ".";
  const [row] = rc(to);
  const crowned = (piece === "r" && row === 0) || (piece === "b" && row === 7);
  if (crowned) piece = piece.toUpperCase();
  cells[to] = piece;
  const board = cells.join("");
  // a capture goes on with the same piece (not after being crowned)
  if (move.captured !== null && !crowned && pieceMoves(board, to).captures.length) return { board, turn: s.turn, mustFrom: to };
  return { board, turn: s.turn === "r" ? "b" : "r", mustFrom: null };
}

/** The winner, when the side to play has no piece or no legal move */
export function winnerOf(s: GameState): Side | null {
  if (legalMoves(s).length) return null;
  return s.turn === "r" ? "b" : "r";
}

export const countPieces = (board: string, who: Side) => board.split("").filter((x) => side(x) === who).length;
