/**
 * Complots (Rikki Tahta, Ferti) — the rules engine for the coffee break.
 *
 * Each player has 2 characters face down ("lives") and gold. On their turn a
 * player takes one action: income (1), foreign aid (2, blocked by the
 * Perceptrices), a coup (7 gold: a life lost, never blocked; required from 10
 * gold), or a character's power — announced, maybe a bluff. Others may call
 * the bluff (the one wrong loses a life; a true claim is shown, shuffled back
 * into the Court and replaced) or block it with the right character (which
 * may be called too). The last one with a hidden character wins.
 *
 * Five characters per game, one per clan. From Complots: Duchesse, Assassin,
 * Comtesse, Capitaine, Ambassadeur / Inquisiteur. From Complots 2 (its rules
 * give their power): Bourreau (Assassins) and Justicier (Voleurs).
 *
 * Pure functions on a JSON state (kept in the database); `rng` is injectable
 * for the tests. Timeouts are applied by `tick()` when the game is read.
 */

export type CharKey = "duchesse" | "assassin" | "comtesse" | "capitaine" | "ambassadeur" | "inquisiteur" | "bourreau" | "justicier";
export type Clan = "perceptrices" | "assassins" | "intouchables" | "voleurs" | "negociateurs";

export const CHARS: Record<CharKey, { clan: Clan; from: 1 | 2 }> = {
  duchesse: { clan: "perceptrices", from: 1 },
  assassin: { clan: "assassins", from: 1 },
  bourreau: { clan: "assassins", from: 2 },
  comtesse: { clan: "intouchables", from: 1 },
  capitaine: { clan: "voleurs", from: 1 },
  justicier: { clan: "voleurs", from: 2 },
  ambassadeur: { clan: "negociateurs", from: 1 },
  inquisiteur: { clan: "negociateurs", from: 1 },
};
export const CLANS: Clan[] = ["perceptrices", "assassins", "intouchables", "voleurs", "negociateurs"];
/** The characters each clan may bring to a game */
export const CLAN_CHARS: Record<Clan, CharKey[]> = {
  perceptrices: ["duchesse"],
  assassins: ["assassin", "bourreau"],
  intouchables: ["comtesse"],
  voleurs: ["capitaine", "justicier"],
  negociateurs: ["ambassadeur", "inquisiteur"],
};
export const DEFAULT_CHARS: CharKey[] = ["duchesse", "assassin", "comtesse", "capitaine", "ambassadeur"];

export type ActionKind = "income" | "aid" | "coup" | "tax" | "assassinate" | "steal" | "exchange" | "inquire" | "execute" | "justice";
/** The character an action announces */
const CLAIM: Partial<Record<ActionKind, CharKey[]>> = {
  tax: ["duchesse"],
  assassinate: ["assassin"],
  steal: ["capitaine"],
  exchange: ["ambassadeur", "inquisiteur"],
  inquire: ["inquisiteur"],
  execute: ["bourreau"],
  justice: ["justicier"],
};
const TARGETED: ActionKind[] = ["coup", "assassinate", "steal", "inquire", "execute", "justice"];
const COST: Partial<Record<ActionKind, number>> = { coup: 7, assassinate: 3, execute: 3 };
/** Who may block an action: the clans, and whether only its target may */
const BLOCK: Partial<Record<ActionKind, { clans: Clan[]; targetOnly: boolean }>> = {
  aid: { clans: ["perceptrices"], targetOnly: false },
  assassinate: { clans: ["intouchables"], targetOnly: true },
  execute: { clans: ["intouchables"], targetOnly: true },
  steal: { clans: ["voleurs", "negociateurs"], targetOnly: true },
  justice: { clans: ["voleurs", "negociateurs"], targetOnly: true },
};

export const TIMEOUT = { turn: 90_000, respond: 15_000, choice: 30_000, exchange: 45_000 } as const;

export type Card = { c: CharKey; up: boolean };
export type Player = { id: string; name: string; coins: number; cards: Card[] };
export type Act = { kind: ActionKind; actor: string; target?: string; claim?: CharKey };
export type Block = { by: string; claim: CharKey };
type Stage = "action" | "blockOnly" | "block";
type Step = { k: "window"; stage: Stage } | { k: "apply" } | { k: "blockResolved" } | { k: "lose"; who: string } | { k: "next" };
export type Phase =
  | { k: "draft"; options: Record<string, CharKey[]>; picked: Record<string, CharKey | null>; deadline: number }
  | { k: "turn"; deadline: number }
  | { k: "respond"; stage: Stage; waiting: string[]; deadline: number }
  | { k: "lose"; who: string; deadline: number }
  | { k: "exchange"; who: string; options: CharKey[]; keep: number; deadline: number }
  | { k: "show"; who: string; deadline: number }
  | { k: "judge"; who: string; target: string; index: number; deadline: number }
  | { k: "over" }
  /** between two choices, while the queue runs (never kept) */
  | { k: "busy" };
export type LogEntry = { k: string; p?: string; t?: string; c?: CharKey; n?: number; at: number };
export type State = {
  chars: CharKey[];
  court: CharKey[];
  players: Player[];
  turn: number;
  act: Act | null;
  block: Block | null;
  phase: Phase;
  queue: Step[];
  log: LogEntry[];
  winner: string | null;
};

export type Input =
  | { t: "action"; kind: ActionKind; target?: string; claim?: CharKey }
  | { t: "pass" }
  | { t: "challenge" }
  | { t: "block"; claim: CharKey }
  | { t: "lose"; index: number }
  | { t: "exchange"; keep: number[] }
  | { t: "show"; index: number }
  | { t: "judge"; replace: boolean }
  | { t: "draft"; char: CharKey };

export class ComplotsError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new ComplotsError(code);
};

type Rng = () => number;
function shuffle<T>(list: T[], rng: Rng): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const alive = (p: Player) => p.cards.some((c) => !c.up);
const hidden = (p: Player) => p.cards.filter((c) => !c.up);
const player = (s: State, id: string) => s.players.find((p) => p.id === id) ?? fail("not_in_game");
const current = (s: State) => s.players[s.turn];
const log = (s: State, e: Omit<LogEntry, "at">, now: number) => {
  s.log.push({ ...e, at: now });
  if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
};

/** A new game: 2 cards and 2 gold each (2 players: a draft, and the first one has 1 gold) */
export function newGame(people: { id: string; name: string }[], chars: CharKey[], rng: Rng = Math.random, now = Date.now()): State {
  if (people.length < 2 || people.length > 6) fail("players");
  validChars(chars);
  const order = shuffle(people, rng);
  const players: Player[] = order.map((p) => ({ id: p.id, name: p.name, coins: 2, cards: [] }));
  const s: State = { chars, court: [], players, turn: 0, act: null, block: null, phase: { k: "turn", deadline: now + TIMEOUT.turn }, queue: [], log: [], winner: null };
  if (players.length === 2) {
    // each one picks a card from a full set, and gets one at random from a third set; its other 3 are the Court
    players[0].coins = 1;
    const third = shuffle(chars, rng);
    players[0].cards.push({ c: third[0], up: false });
    players[1].cards.push({ c: third[1], up: false });
    s.court = shuffle(third.slice(2), rng);
    s.phase = { k: "draft", options: Object.fromEntries(players.map((p) => [p.id, [...chars]])), picked: Object.fromEntries(players.map((p) => [p.id, null])), deadline: now + TIMEOUT.exchange };
  } else {
    const deck = shuffle(chars.flatMap((c) => [c, c, c]), rng);
    for (const p of players) p.cards = [deck.pop()!, deck.pop()!].map((c) => ({ c, up: false }));
    s.court = deck;
  }
  log(s, { k: "start", p: players[0].id }, now);
  return s;
}

export function validChars(chars: CharKey[]) {
  if (chars.length !== 5 || new Set(chars).size !== 5) fail("chars");
  for (const clan of CLANS) if (chars.filter((c) => CHARS[c]?.clan === clan).length !== 1) fail("chars");
}

/** The characters of these clans in this game */
const inGame = (s: State, clans: Clan[]) => s.chars.filter((c) => clans.includes(CHARS[c].clan));

/** Who may block this action now, and with what */
export function blockersOf(s: State, a: Act): { ids: string[]; claims: CharKey[] } {
  const b = BLOCK[a.kind];
  if (!b) return { ids: [], claims: [] };
  const claims = inGame(s, b.clans);
  if (!claims.length) return { ids: [], claims: [] };
  const ids = b.targetOnly ? (a.target && alive(player(s, a.target)) ? [a.target] : []) : s.players.filter((p) => p.id !== a.actor && alive(p)).map((p) => p.id);
  return { ids, claims };
}

/** One of the actor's hidden characters goes back to the Court, a new one is drawn */
function swap(s: State, p: Player, c: CharKey, rng: Rng) {
  const i = p.cards.findIndex((x) => !x.up && x.c === c);
  if (i < 0) return;
  s.court = shuffle([...s.court, c], rng);
  p.cards[i] = { c: s.court.pop()!, up: false };
}

function reveal(s: State, p: Player, index: number, now: number) {
  const card = p.cards[index];
  if (!card || card.up) fail("invalid_card");
  card.up = true;
  log(s, { k: "lost", p: p.id, c: card.c }, now);
  if (!alive(p)) {
    p.coins = 0;
    log(s, { k: "out", p: p.id }, now);
  }
  const left = s.players.filter(alive);
  if (left.length === 1) {
    s.winner = left[0].id;
    s.phase = { k: "over" };
    s.queue = [];
    log(s, { k: "won", p: left[0].id }, now);
  }
}

/** Apply the action (after nobody stopped it) */
function apply(s: State, _rng: Rng, now: number) {
  const a = s.act!;
  const me = player(s, a.actor);
  const target = a.target ? player(s, a.target) : null;
  switch (a.kind) {
    case "income":
      me.coins += 1;
      break;
    case "aid":
      me.coins += 2;
      break;
    case "tax":
      me.coins += 3;
      break;
    case "coup":
      me.coins -= 7;
      if (target && alive(target)) s.queue.unshift({ k: "lose", who: target.id });
      break;
    case "assassinate":
      me.coins -= 3;
      if (target && alive(target)) s.queue.unshift({ k: "lose", who: target.id });
      break;
    case "execute":
      // the Bourreau's 3 gold go to the one he aims at
      me.coins -= 3;
      if (target) target.coins += 3;
      if (target && alive(target)) s.queue.unshift({ k: "lose", who: target.id });
      break;
    case "steal": {
      const n = Math.min(2, target!.coins);
      target!.coins -= n;
      me.coins += n;
      log(s, { k: "stole", p: me.id, t: target!.id, n }, now);
      break;
    }
    case "justice": {
      // takes 3, keeps 1, gives the rest to the poorest player (the first one after him, on a tie)
      const n = Math.min(3, target!.coins);
      target!.coins -= n;
      const keep = Math.min(1, n);
      me.coins += keep;
      const others = orderFrom(s, me.id).filter((p) => p.id !== me.id && alive(p));
      const poorest = others.reduce((x, y) => (y.coins < x.coins ? y : x), others[0]);
      if (poorest && n - keep > 0) poorest.coins += n - keep;
      log(s, { k: "justice", p: me.id, t: target!.id, n }, now);
      if (poorest && n - keep > 0) log(s, { k: "gave", p: me.id, t: poorest.id, n: n - keep }, now);
      break;
    }
    case "exchange": {
      const draw = a.claim === "inquisiteur" ? 1 : 2;
      const drawn = s.court.splice(Math.max(0, s.court.length - draw), draw);
      const mine = hidden(me).map((c) => c.c);
      s.phase = { k: "exchange", who: me.id, options: [...mine, ...drawn], keep: mine.length, deadline: now + TIMEOUT.exchange };
      return;
    }
    case "inquire":
      if (target && alive(target)) s.phase = { k: "show", who: target.id, deadline: now + TIMEOUT.choice };
      return;
  }
}

/** The action was blocked: what it still costs */
function blocked(s: State, now: number) {
  const a = s.act!;
  const me = player(s, a.actor);
  if (a.kind === "assassinate") me.coins -= 3;
  if (a.kind === "execute") {
    me.coins -= 3;
    player(s, a.target!).coins += 3;
  }
  log(s, { k: "blocked", p: s.block!.by, t: a.actor, c: s.block!.claim }, now);
}

/** Players from this one, in turn order */
function orderFrom(s: State, id: string) {
  const i = s.players.findIndex((p) => p.id === id);
  return [...s.players.slice(i), ...s.players.slice(0, i)];
}

function nextTurn(s: State, now: number) {
  s.act = null;
  s.block = null;
  for (let k = 1; k <= s.players.length; k++) {
    const i = (s.turn + k) % s.players.length;
    if (alive(s.players[i])) {
      s.turn = i;
      break;
    }
  }
  s.phase = { k: "turn", deadline: now + TIMEOUT.turn };
}

/** Run the queue until someone has to choose */
function run(s: State, rng: Rng, now: number) {
  while (s.phase.k === "busy" && s.queue.length) {
    const step = s.queue.shift()!;
    switch (step.k) {
      case "window": {
        const a = s.act!;
        let waiting: string[] = [];
        if (step.stage === "action") waiting = s.players.filter((p) => p.id !== a.actor && alive(p)).map((p) => p.id);
        if (step.stage === "blockOnly") waiting = blockersOf(s, a).ids;
        if (step.stage === "block") waiting = s.players.filter((p) => p.id !== s.block!.by && alive(p)).map((p) => p.id);
        // nobody can do anything here (no claim and no blocker): on with it
        if (step.stage === "action" && !a.claim && !blockersOf(s, a).ids.length) waiting = [];
        if (waiting.length) s.phase = { k: "respond", stage: step.stage, waiting, deadline: now + TIMEOUT.respond };
        break;
      }
      case "apply":
        if (alive(player(s, s.act!.actor))) apply(s, rng, now);
        break;
      case "blockResolved":
        if (s.block) blocked(s, now);
        else if (alive(player(s, s.act!.actor))) apply(s, rng, now);
        break;
      case "lose": {
        const p = player(s, step.who);
        const h = p.cards.map((c, i) => (c.up ? -1 : i)).filter((i) => i >= 0);
        if (h.length === 1) reveal(s, p, h[0], now);
        else if (h.length > 1) s.phase = { k: "lose", who: p.id, deadline: now + TIMEOUT.choice };
        break;
      }
      case "next":
        nextTurn(s, now);
        break;
    }
  }
  // nothing left to do (should not happen): the next player
  if (s.phase.k === "busy") nextTurn(s, now);
}

/** The current choice is made: the queue may go on */
const done = (s: State) => {
  s.phase = { k: "busy" };
};

/** One player's move. Throws ComplotsError when not allowed. */
export function play(s0: State, me: string, input: Input, rng: Rng = Math.random, now = Date.now()): State {
  const s: State = structuredClone(s0);
  const p = player(s, me);
  const ph = s.phase;
  if (ph.k === "over") fail("game_over");
  if (input.t !== "draft" && !alive(p)) fail("eliminated");

  switch (input.t) {
    case "draft": {
      if (ph.k !== "draft" || !ph.options[me] || ph.picked[me]) fail("not_now");
      const d = ph as Extract<Phase, { k: "draft" }>;
      if (!d.options[me].includes(input.char)) fail("invalid_card");
      d.picked[me] = input.char;
      if (Object.values(d.picked).every(Boolean)) finishDraft(s, now);
      return s;
    }
    case "action": {
      if (ph.k !== "turn" || current(s).id !== me) fail("not_your_turn");
      const a: Act = { kind: input.kind, actor: me };
      if (TARGETED.includes(input.kind)) {
        const t = s.players.find((x) => x.id === input.target);
        if (!t || t.id === me || !alive(t)) fail("invalid_target");
        a.target = t!.id;
      }
      if (p.coins >= 10 && input.kind !== "coup") fail("must_coup");
      if ((COST[input.kind] ?? 0) > p.coins) fail("not_enough_gold");
      const claims = CLAIM[input.kind];
      if (claims) {
        const claim = input.claim && claims.includes(input.claim) ? input.claim : claims.find((c) => s.chars.includes(c));
        if (!claim || !s.chars.includes(claim)) fail("not_in_game");
        a.claim = claim;
      }
      s.act = a;
      s.block = null;
      log(s, { k: `act.${a.kind}`, p: me, t: a.target, c: a.claim }, now);
      done(s);
      if (a.kind === "income" || a.kind === "coup") s.queue = [{ k: "apply" }, { k: "next" }];
      else s.queue = [{ k: "window", stage: "action" }, { k: "apply" }, { k: "next" }];
      run(s, rng, now);
      return s;
    }
    case "pass": {
      if (ph.k !== "respond" || !ph.waiting.includes(me)) fail("not_now");
      const r = ph as Extract<Phase, { k: "respond" }>;
      r.waiting = r.waiting.filter((x) => x !== me);
      if (!r.waiting.length) {
        done(s);
        run(s, rng, now);
      }
      return s;
    }
    case "challenge": {
      if (ph.k !== "respond" || !ph.waiting.includes(me) || ph.stage === "blockOnly") fail("not_now");
      const stage = (ph as Extract<Phase, { k: "respond" }>).stage;
      if (stage === "action") {
        const a = s.act!;
        if (!a.claim) fail("nothing_to_challenge");
        const actor = player(s, a.actor);
        log(s, { k: "challenge", p: me, t: actor.id, c: a.claim }, now);
        done(s);
        if (hidden(actor).some((c) => c.c === a.claim)) {
          log(s, { k: "truth", p: actor.id, c: a.claim }, now);
          swap(s, actor, a.claim!, rng);
          // the challenger loses a life; the action goes on, and may still be blocked
          const canBlock = blockersOf(s, a).ids.length > 0;
          s.queue = [{ k: "lose", who: me }, ...(canBlock ? [{ k: "window", stage: "blockOnly" } as Step] : []), { k: "apply" }, { k: "next" }];
        } else {
          log(s, { k: "bluff", p: actor.id, c: a.claim }, now);
          s.queue = [{ k: "lose", who: actor.id }, { k: "next" }];
        }
      } else {
        const b = s.block!;
        const blocker = player(s, b.by);
        log(s, { k: "challenge", p: me, t: blocker.id, c: b.claim }, now);
        done(s);
        if (hidden(blocker).some((c) => c.c === b.claim)) {
          log(s, { k: "truth", p: blocker.id, c: b.claim }, now);
          swap(s, blocker, b.claim, rng);
          s.queue = [{ k: "lose", who: me }, { k: "blockResolved" }, { k: "next" }];
        } else {
          log(s, { k: "bluff", p: blocker.id, c: b.claim }, now);
          s.block = null;
          s.queue = [{ k: "lose", who: blocker.id }, { k: "blockResolved" }, { k: "next" }];
        }
      }
      run(s, rng, now);
      return s;
    }
    case "block": {
      if (ph.k !== "respond" || !ph.waiting.includes(me) || ph.stage === "block") fail("not_now");
      const a = s.act!;
      const b = blockersOf(s, a);
      if (!b.ids.includes(me) || !b.claims.includes(input.claim)) fail("cannot_block");
      s.block = { by: me, claim: input.claim };
      log(s, { k: "block", p: me, t: a.actor, c: input.claim }, now);
      done(s);
      s.queue = [{ k: "window", stage: "block" }, { k: "blockResolved" }, { k: "next" }];
      run(s, rng, now);
      return s;
    }
    case "lose": {
      if (ph.k !== "lose" || ph.who !== me) fail("not_now");
      reveal(s, p, input.index, now);
      if (s.phase.k !== "over") {
        done(s);
        run(s, rng, now);
      }
      return s;
    }
    case "exchange": {
      if (ph.k !== "exchange" || ph.who !== me) fail("not_now");
      const x = ph as Extract<Phase, { k: "exchange" }>;
      const keep = [...new Set(input.keep)];
      if (keep.length !== x.keep || keep.some((i) => i < 0 || i >= x.options.length)) fail("invalid_card");
      const kept = keep.map((i) => x.options[i]);
      const back = x.options.filter((_, i) => !keep.includes(i));
      // the hidden cards become the ones kept; lost (face up) ones stay
      let k = 0;
      p.cards = p.cards.map((c) => (c.up ? c : { c: kept[k++], up: false }));
      s.court = shuffle([...s.court, ...back], rng);
      log(s, { k: "exchanged", p: me, n: x.options.length - x.keep }, now);
      done(s);
      run(s, rng, now);
      return s;
    }
    case "show": {
      if (ph.k !== "show" || ph.who !== me) fail("not_now");
      if (!p.cards[input.index] || p.cards[input.index].up) fail("invalid_card");
      s.phase = { k: "judge", who: s.act!.actor, target: me, index: input.index, deadline: now + TIMEOUT.choice };
      log(s, { k: "shown", p: me, t: s.act!.actor }, now);
      return s;
    }
    case "judge": {
      if (ph.k !== "judge" || ph.who !== me) fail("not_now");
      const j = ph as Extract<Phase, { k: "judge" }>;
      const t = player(s, j.target);
      if (input.replace) {
        const c = t.cards[j.index];
        s.court = shuffle([...s.court, c.c], rng);
        t.cards[j.index] = { c: s.court.pop()!, up: false };
      }
      log(s, { k: input.replace ? "replaced" : "returned", p: me, t: t.id }, now);
      done(s);
      run(s, rng, now);
      return s;
    }
  }
}

function finishDraft(s: State, now: number) {
  const d = s.phase as Extract<Phase, { k: "draft" }>;
  for (const p of s.players) p.cards.push({ c: d.picked[p.id]!, up: false });
  s.phase = { k: "turn", deadline: now + TIMEOUT.turn };
}

/** Time ran out: what happens by itself (pass, the first card, income…) */
export function tick(s0: State, rng: Rng = Math.random, now = Date.now()): State {
  let s = s0;
  for (let guard = 0; guard < 50; guard++) {
    const ph = s.phase;
    if (ph.k === "over" || ph.k === "busy" || ph.deadline > now) return s;
    const at = ph.deadline;
    switch (ph.k) {
      case "draft": {
        s = structuredClone(s);
        const d = s.phase as Extract<Phase, { k: "draft" }>;
        for (const id of Object.keys(d.picked)) if (!d.picked[id]) d.picked[id] = d.options[id][0];
        finishDraft(s, at);
        break;
      }
      case "turn": {
        const p = current(s);
        if (p.coins >= 10) {
          const t = s.players.find((x) => x.id !== p.id && alive(x))!;
          s = play(s, p.id, { t: "action", kind: "coup", target: t.id }, rng, at);
        } else s = play(s, p.id, { t: "action", kind: "income" }, rng, at);
        break;
      }
      case "respond": {
        s = structuredClone(s);
        done(s);
        run(s, rng, at);
        break;
      }
      case "lose": {
        const p = player(s, ph.who);
        s = play(s, p.id, { t: "lose", index: p.cards.findIndex((c) => !c.up) }, rng, at);
        break;
      }
      case "exchange":
        s = play(s, ph.who, { t: "exchange", keep: Array.from({ length: ph.keep }, (_, i) => i) }, rng, at);
        break;
      case "show": {
        const p = player(s, ph.who);
        s = play(s, p.id, { t: "show", index: p.cards.findIndex((c) => !c.up) }, rng, at);
        break;
      }
      case "judge":
        s = play(s, ph.who, { t: "judge", replace: false }, rng, at);
        break;
    }
  }
  return s;
}

/** A player leaves: their characters are all revealed, and the game goes on without them */
export function leave(s0: State, me: string, rng: Rng = Math.random, now = Date.now()): State {
  let s: State = structuredClone(s0);
  const p = player(s, me);
  if (s.phase.k === "over" || !alive(p)) return s;
  // anything waiting on them is answered as on a timeout, then their cards go face up
  const mine = (ph: Phase) =>
    (ph.k === "turn" && current(s).id === me) || ((ph.k === "lose" || ph.k === "exchange" || ph.k === "show" || ph.k === "judge") && ph.who === me);
  if (s.phase.k === "respond") s.phase.waiting = s.phase.waiting.filter((x) => x !== me);
  if (mine(s.phase) && "deadline" in s.phase) {
    (s.phase as { deadline: number }).deadline = now - 1;
    s = tick(s, rng, now);
  }
  const q = player(s, me);
  log(s, { k: "left", p: me }, now);
  for (let i = 0; i < q.cards.length; i++) if (!q.cards[i].up && s.phase.k !== "over") reveal(s, q, i, now);
  if (s.phase.k === "respond" && !s.phase.waiting.length) {
    done(s);
    run(s, rng, now);
  }
  // it was their turn: the next one plays
  if (s.phase.k === "turn" && !alive(current(s))) nextTurn(s, now);
  return s;
}

/** What one player sees: their own cards, the others' revealed ones, and what they may do now */
export function viewFor(s: State, me: string, now = Date.now()) {
  const ph = s.phase;
  const meP = s.players.find((p) => p.id === me);
  const act = s.act;
  const blockInfo = act && ph.k === "respond" && ph.stage !== "block" ? blockersOf(s, act) : { ids: [], claims: [] as CharKey[] };
  const waiting = ph.k === "respond" ? ph.waiting : [];
  return {
    chars: s.chars,
    court: s.court.length,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      coins: p.coins,
      alive: alive(p),
      cards: p.cards.map((c) => (p.id === me || c.up ? { c: c.c, up: c.up } : { c: null, up: false })),
    })),
    turn: s.players[s.turn]?.id ?? null,
    act,
    block: s.block,
    phase: {
      k: ph.k,
      who: "who" in ph ? ph.who : ph.k === "turn" ? (s.players[s.turn]?.id ?? null) : null,
      stage: ph.k === "respond" ? ph.stage : null,
      waiting,
      leftMs: "deadline" in ph ? Math.max(0, ph.deadline - now) : 0,
      // only for the one choosing
      options: ph.k === "exchange" && ph.who === me ? ph.options : ph.k === "draft" ? (ph.options[me] ?? null) : null,
      keep: ph.k === "exchange" && ph.who === me ? ph.keep : null,
      picked: ph.k === "draft" ? Boolean(ph.picked[me]) : null,
      // the card the Inquisiteur looks at: for the two of them
      shown: ph.k === "judge" && (ph.who === me || ph.target === me) ? { target: ph.target, c: player(s, ph.target).cards[ph.index].c } : null,
    },
    you: meP
      ? {
          canAct: ph.k === "turn" && s.players[s.turn]?.id === me && alive(meP),
          mustCoup: meP.coins >= 10,
          canPass: waiting.includes(me),
          canChallenge: waiting.includes(me) && ph.k === "respond" && ph.stage !== "blockOnly" && (ph.stage === "block" || Boolean(act?.claim)),
          blockWith: waiting.includes(me) && blockInfo.ids.includes(me) ? blockInfo.claims : [],
        }
      : null,
    winner: s.winner,
    log: s.log.slice(-40),
  };
}
export type ComplotsView = ReturnType<typeof viewFor>;
