import { describe, expect, it } from "vitest";
import { leave, newGame, play, tick, viewFor, type CharKey, type State } from "../server/lib/complots.ts";

/** Same draws every time */
const seeded = (seed = 7) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Joueur ${i + 1}` }));
const NOW = 1_000_000;

/** A game with these hands, in this order, player 1 to play */
function rigged(hands: CharKey[][], chars: CharKey[] = ["duchesse", "assassin", "comtesse", "capitaine", "ambassadeur"], coins?: number[]): State {
  const s = newGame(people(hands.length), chars, seeded(), NOW);
  s.players.sort((a, b) => a.id.localeCompare(b.id));
  s.players.forEach((p, i) => {
    p.cards = hands[i].map((c) => ({ c, up: false }));
    p.coins = coins?.[i] ?? 2;
  });
  s.turn = 0;
  s.court = chars.flatMap((c) => [c, c]);
  s.phase = { k: "turn", deadline: NOW + 90_000 };
  return s;
}
const P = (s: State, id: string) => s.players.find((p) => p.id === id)!;
const lost = (s: State, id: string) => P(s, id).cards.filter((c) => c.up).length;
const rng = seeded(3);
const go = (s: State, id: string, input: Parameters<typeof play>[2]) => play(s, id, input, rng, NOW);

describe("Complots rules", () => {
  it("sets up 3 to 6 players with 2 cards and 2 gold; 2 players draft, the first with 1 gold", () => {
    const s = newGame(people(4), ["duchesse", "assassin", "comtesse", "capitaine", "ambassadeur"], seeded(), NOW);
    expect(s.players.every((p) => p.cards.length === 2 && p.coins === 2)).toBe(true);
    expect(s.court).toHaveLength(15 - 8);
    expect(() => newGame(people(4), ["duchesse", "assassin", "bourreau", "capitaine", "ambassadeur"], seeded(), NOW)).toThrow("chars");

    let d = newGame(people(2), ["duchesse", "assassin", "comtesse", "capitaine", "ambassadeur"], seeded(), NOW);
    expect(d.phase.k).toBe("draft");
    expect(d.players.map((p) => p.coins)).toEqual([1, 2]);
    expect(d.court).toHaveLength(3);
    d = play(d, d.players[0].id, { t: "draft", char: "duchesse" }, rng, NOW);
    d = play(d, d.players[1].id, { t: "draft", char: "assassin" }, rng, NOW);
    expect(d.phase.k).toBe("turn");
    expect(d.players.every((p) => p.cards.length === 2)).toBe(true);
  });

  it("income at once; foreign aid blocked by a Duchesse, and a bluffed block called", () => {
    let s = rigged([["capitaine", "comtesse"], ["assassin", "ambassadeur"], ["duchesse", "capitaine"]]);
    s = go(s, "p1", { t: "action", kind: "income" });
    expect(P(s, "p1").coins).toBe(3);
    expect(s.players[s.turn].id).toBe("p2");
    // p2 asks for foreign aid; p3 blocks (true Duchesse), nobody calls: no gold
    s = go(s, "p2", { t: "action", kind: "aid" });
    expect(s.phase).toMatchObject({ k: "respond", stage: "action" });
    s = go(s, "p3", { t: "block", claim: "duchesse" });
    s = go(s, "p1", { t: "pass" });
    s = go(s, "p2", { t: "pass" });
    expect(P(s, "p2").coins).toBe(2);
    expect(s.players[s.turn].id).toBe("p3");
    // p3 asks; p1 blocks with a Duchesse he does not have; p3 calls it: p1 loses a life, p3 gets 2
    s = go(s, "p3", { t: "action", kind: "aid" });
    s = go(s, "p1", { t: "block", claim: "duchesse" });
    s = go(s, "p3", { t: "challenge" });
    expect(s.phase).toMatchObject({ k: "lose", who: "p1" });
    s = go(s, "p1", { t: "lose", index: 1 });
    expect(P(s, "p1").cards[1]).toEqual({ c: "comtesse", up: true });
    expect(P(s, "p3").coins).toBe(4);
  });

  it("a true claim called: the caller loses a life, the card is replaced, the power applies; a bluff called: the liar loses", () => {
    let s = rigged([["duchesse", "comtesse"], ["assassin", "ambassadeur"], ["capitaine", "capitaine"]]);
    s = go(s, "p1", { t: "action", kind: "tax" });
    s = go(s, "p2", { t: "challenge" });
    s = go(s, "p2", { t: "lose", index: 0 });
    expect(lost(s, "p2")).toBe(1);
    expect(P(s, "p1").coins).toBe(5);
    expect(P(s, "p1").cards.filter((c) => !c.up)).toHaveLength(2);
    expect(s.log.some((e) => e.k === "truth")).toBe(true);
    // p2 bluffs the Duchesse, p3 calls it
    s = go(s, "p2", { t: "action", kind: "tax" });
    s = go(s, "p3", { t: "challenge" });
    // his last life: out, his gold goes back to the Treasury (no Duchesse gold either)
    expect(P(s, "p2").cards.every((c) => c.up)).toBe(true);
    expect(P(s, "p2").coins).toBe(0);
    expect(s.players[s.turn].id).toBe("p3");
  });

  it("the Assassin: 3 gold; the Comtesse blocks (gold still paid); calling a true Assassin can cost both lives", () => {
    let s = rigged([["assassin", "duchesse"], ["comtesse", "ambassadeur"], ["capitaine", "duchesse"]], undefined, [5, 2, 2]);
    s = go(s, "p1", { t: "action", kind: "assassinate", target: "p2" });
    s = go(s, "p2", { t: "block", claim: "comtesse" });
    s = go(s, "p1", { t: "pass" });
    s = go(s, "p3", { t: "pass" });
    expect(P(s, "p1").coins).toBe(2);
    expect(lost(s, "p2")).toBe(0);
    // later: p1 again, p3 calls the Assassin and loses one life, then the assassination takes the other
    s.turn = 0;
    s.phase = { k: "turn", deadline: NOW + 90_000 };
    P(s, "p1").coins = 3;
    P(s, "p1").cards = [{ c: "assassin", up: false }, { c: "duchesse", up: false }];
    s = go(s, "p1", { t: "action", kind: "assassinate", target: "p3" });
    s = go(s, "p3", { t: "challenge" });
    s = go(s, "p3", { t: "lose", index: 0 });
    // he may still block (he does not)
    expect(s.phase).toMatchObject({ k: "respond", stage: "blockOnly", waiting: ["p3"] });
    s = go(s, "p3", { t: "pass" });
    expect(P(s, "p3").cards.every((c) => c.up)).toBe(true);
    expect(P(s, "p3").coins).toBe(0);
  });

  it("the Capitaine steals 2 (blocked by a Capitaine or the Ambassadeur); at 10 gold a coup is the only move", () => {
    let s = rigged([["capitaine", "duchesse"], ["ambassadeur", "comtesse"]], undefined, [2, 3]);
    s.phase = { k: "turn", deadline: NOW + 90_000 };
    s = go(s, "p1", { t: "action", kind: "steal", target: "p2" });
    s = go(s, "p2", { t: "pass" });
    expect([P(s, "p1").coins, P(s, "p2").coins]).toEqual([4, 1]);
    s = go(s, "p2", { t: "action", kind: "steal", target: "p1" });
    s = go(s, "p1", { t: "block", claim: "capitaine" });
    s = go(s, "p2", { t: "pass" });
    expect([P(s, "p1").coins, P(s, "p2").coins]).toEqual([4, 1]);
    P(s, "p1").coins = 10;
    expect(() => go(s, "p1", { t: "action", kind: "income" })).toThrow("must_coup");
    s = go(s, "p1", { t: "action", kind: "coup", target: "p2" });
    expect(s.phase).toMatchObject({ k: "lose", who: "p2" });
    s = go(s, "p2", { t: "lose", index: 0 });
    expect(P(s, "p1").coins).toBe(3);
  });

  it("the Ambassadeur exchanges with the Court; the Inquisiteur looks at a card and may replace it", () => {
    let s = rigged([["ambassadeur", "comtesse"], ["duchesse", "capitaine"]]);
    s = go(s, "p1", { t: "action", kind: "exchange" });
    s = go(s, "p2", { t: "pass" });
    expect(s.phase).toMatchObject({ k: "exchange", who: "p1", keep: 2 });
    const options = (s.phase as { options: CharKey[] }).options;
    expect(options).toHaveLength(4);
    // what p2 sees: no options of the other one
    expect(viewFor(s, "p2").phase.options).toBeNull();
    s = go(s, "p1", { t: "exchange", keep: [2, 3] });
    expect(P(s, "p1").cards.map((c) => c.c)).toEqual([options[2], options[3]]);
    expect(s.court).toHaveLength(10);

    let q = rigged([["inquisiteur", "comtesse"], ["duchesse", "capitaine"], ["assassin", "duchesse"]], ["duchesse", "assassin", "comtesse", "capitaine", "inquisiteur"]);
    q = go(q, "p1", { t: "action", kind: "inquire", target: "p2" });
    q = go(q, "p2", { t: "pass" });
    q = go(q, "p3", { t: "pass" });
    expect(q.phase).toMatchObject({ k: "show", who: "p2" });
    q = go(q, "p2", { t: "show", index: 1 });
    expect(viewFor(q, "p1").phase.shown).toEqual({ target: "p2", c: "capitaine" });
    expect(viewFor(q, "p3").phase.shown).toBeNull();
    q = go(q, "p1", { t: "judge", replace: true });
    expect(P(q, "p2").cards[0].c).toBe("duchesse");
    expect(q.players[q.turn].id).toBe("p2");
  });

  it("Complots 2: the Bourreau pays his 3 gold to the target, even when blocked; the Justicier takes 3, keeps 1, gives 2 to the poorest", () => {
    const v2: CharKey[] = ["duchesse", "bourreau", "comtesse", "justicier", "ambassadeur"];
    let s = rigged([["bourreau", "justicier"], ["comtesse", "duchesse"], ["ambassadeur", "duchesse"]], v2, [4, 2, 0]);
    s = go(s, "p1", { t: "action", kind: "execute", target: "p2" });
    s = go(s, "p2", { t: "block", claim: "comtesse" });
    s = go(s, "p1", { t: "pass" });
    s = go(s, "p3", { t: "pass" });
    expect([P(s, "p1").coins, P(s, "p2").coins]).toEqual([1, 5]);
    expect(lost(s, "p2")).toBe(0);
    // p2 bluffs nothing: p2 passes the turn with income; p3 too; then p1 uses the Justicier on p2
    s = go(s, "p2", { t: "action", kind: "income" });
    s = go(s, "p3", { t: "action", kind: "income" });
    s = go(s, "p1", { t: "action", kind: "justice", target: "p2" });
    s = go(s, "p2", { t: "pass" });
    s = go(s, "p3", { t: "pass" });
    expect([P(s, "p1").coins, P(s, "p2").coins, P(s, "p3").coins]).toEqual([2, 3, 3]);
  });

  it("time runs out: an answer is a pass, a turn is income, a lost life is the first card", () => {
    let s = rigged([["duchesse", "comtesse"], ["assassin", "capitaine"]]);
    s = go(s, "p1", { t: "action", kind: "tax" });
    s = tick(s, rng, NOW + 16_000);
    expect(P(s, "p1").coins).toBe(5);
    s = tick(s, rng, NOW + 16_000 + 91_000);
    expect(P(s, "p2").coins).toBe(3);
    expect(s.players[s.turn].id).toBe("p1");
  });

  it("a player who leaves is out; the last one left wins; others never see hidden cards", () => {
    let s = rigged([["duchesse", "comtesse"], ["assassin", "capitaine"], ["ambassadeur", "duchesse"]]);
    const v = viewFor(s, "p2");
    expect(v.players.find((p) => p.id === "p1")!.cards).toEqual([{ c: null, up: false }, { c: null, up: false }]);
    expect(v.players.find((p) => p.id === "p2")!.cards.map((c) => c.c)).toEqual(["assassin", "capitaine"]);
    s = leave(s, "p1", rng, NOW);
    expect(P(s, "p1").cards.every((c) => c.up)).toBe(true);
    expect(s.players[s.turn].id).toBe("p2");
    s = leave(s, "p3", rng, NOW);
    expect(s.winner).toBe("p2");
    expect(s.phase.k).toBe("over");
    expect(() => go(s, "p2", { t: "action", kind: "income" })).toThrow("game_over");
  });
});
