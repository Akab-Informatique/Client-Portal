import { describe, expect, it } from "vitest";
import { countPieces, legalMoves, play, START_BOARD, startState, winnerOf, type GameState } from "../shared/checkers.ts";

/** A board from a picture: 8 rows of 8 characters */
const board = (rows: string[]) => rows.join("");
const sq = (r: number, c: number) => r * 8 + c;

describe("checkers rules", () => {
  it("starts with 12 pieces each, red to play, 7 opening moves", () => {
    expect(countPieces(START_BOARD, "r")).toBe(12);
    expect(countPieces(START_BOARD, "b")).toBe(12);
    const s = startState();
    expect(s.turn).toBe("r");
    expect(legalMoves(s)).toHaveLength(7);
    // a man moves forward only
    expect(play(s, sq(5, 0), sq(4, 1))).not.toBeNull();
    expect(play(s, sq(5, 0), sq(6, 1))).toBeNull();
  });

  it("makes captures mandatory, and a piece that captured goes on", () => {
    const s: GameState = {
      board: board([
        "........",
        "........",
        "...b....",
        "........",
        ".b......",
        "r.......",
        "........",
        "........",
      ]),
      turn: "r",
      mustFrom: null,
    };
    // the only legal move is the capture
    expect(legalMoves(s)).toEqual([{ from: sq(5, 0), to: sq(3, 2), captured: sq(4, 1) }]);
    const after = play(s, sq(5, 0), sq(3, 2))!;
    // same piece, same player: the second capture
    expect(after).toMatchObject({ turn: "r", mustFrom: sq(3, 2) });
    expect(legalMoves(after)).toEqual([{ from: sq(3, 2), to: sq(1, 4), captured: sq(2, 3) }]);
    const done = play(after, sq(3, 2), sq(1, 4))!;
    expect(done).toMatchObject({ turn: "b", mustFrom: null });
    // black has nothing left: red wins
    expect(countPieces(done.board, "b")).toBe(0);
    expect(winnerOf(done)).toBe("r");
  });

  it("crowns a man on the far row; kings move both ways", () => {
    const s: GameState = {
      board: board(["........", "..r.....", "........", "........", "........", "........", ".....b..", "........"]),
      turn: "r",
      mustFrom: null,
    };
    const crowned = play(s, sq(1, 2), sq(0, 1))!;
    expect(crowned.board[sq(0, 1)]).toBe("R");
    expect(crowned.turn).toBe("b");
    const k: GameState = { board: crowned.board, turn: "r", mustFrom: null };
    expect(legalMoves(k).map((m) => m.to).sort()).toEqual([sq(1, 0), sq(1, 2)].sort());
  });
});
