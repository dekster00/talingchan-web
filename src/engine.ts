// Rules engine for Battle of Talingchan. Pure data state + functions.
// Card effects live in cards.ts; decisions are delegated to a Brain (bot.ts).
import type { Card, Def, Game, Player, PID, MagicKind, Life, GemColor, LifeSpec } from './types.ts';
import { FX, value, worstN } from './cards.ts';
import type { HandAct } from './cards.ts'; // bugfix1
import './cards2.ts';
import './fx/index.ts';
import { hasSymbol, hasName, viewCost, bindGame, bindCard, originZone, noteOrigin } from './view.ts'; // v14 core-view

// ---------- decisions interface ----------
export interface Act { k: 'summon' | 'cast' | 'hand' | 'field' | 'land' | 'hell' | 'exile' | 'link' | 'deck'; uid: number; opt: number; label: string } // v14 features: 'link' = form คู่หู / [Link] (uid = clicked Avatar, opt = partner uid)
// v14 window kinds (see engine/v14-hooks.md): partner = actor's Avatar entered คู่หู / [Link] (source = that Avatar);
// endTurn = actor is about to end the turn (start of End Phase); lifeHit = actor's attack on LIFE resolved (source = attacker);
// destroyed / left = source was destroyed / left the field and is already in its new zone (ev.leave says how; actor = the
// player who caused it, or the opponent of its controller when nobody did); targeted = an effect of source (actor's card)
// picked ev.target; a React may cancel it (the pick becomes null) or set ev.target to redirect it.
export type EvKind = 'magic' | 'summon' | 'attack' | 'ability' | 'fight' | 'destroy' | 'battleStart'
  | 'partner' | 'endTurn' | 'lifeHit' | 'destroyed' | 'left' | 'targeted';
export interface Ev {
  kind: EvKind; // battleStart: start of actor's Battle Phase
  actor: PID;
  source: Card | null;
  isReact?: boolean;
  target?: Card | null; // attack target (null = LIFE)
  cancelled: boolean;
  depth: number;
  responder?: PID; // v14: who gets this window (default: the opponent of actor)
  noMagic?: boolean; // v14: React Magic can't be used in this window (blockReact)
  leave?: LeaveInfo; // v14: destroyed / left windows
}
export interface Brain {
  main(g: Game, me: PID): void; // play the whole main phase
  battle(g: Game, me: PID): void; // declare all attacks
  respond(g: Game, me: PID, ev: Ev): Card | null; // react card (or คนรวย on field) to use, or null
  oppMain?(g: Game, me: PID): void; // abilities usable in the opponent's Main Phase (ชิโยเมะ)
  offTurn?(g: Game, me: PID, acts: Act[], when: string): Act | null; // v14b: cast a Magic in the opponent's turn (FX.offTurnMagic)
  wantsBattle?(g: Game, me: PID): boolean; // false = this player skips the Battle Phase (no start-of-Battle React window)
}
let BRAINS: [Brain, Brain] | null = null;
export function setBrains(b: [Brain, Brain]) { BRAINS = b; }

// ---------- human choices (play mode) ----------
// Effects pick targets with best()/worst(). In play mode the human is asked instead, but only
// when the human is the player currently deciding (top of DECIDER). Bot thinking runs under the
// bot's id, and list-building (legal moves) runs under -1, so neither ever asks.
const DECIDER: number[] = [];
export function withDecider<T>(p: number, fn: () => T): T { DECIDER.push(p); try { return fn(); } finally { DECIDER.pop(); } }
export const quiet = <T>(fn: () => T): T => withDecider(-1, fn);
// context: all cards revealed by the current สอดแนม (the screen shows them; only xs are choosable); none: nothing to choose
export interface AskOpts { optional?: boolean; title?: string; context?: Card[]; none?: boolean }
type AskFn = (xs: Card[], dflt: Card | null, o: AskOpts) => Card | null;
let ASK: AskFn | null = null, ASK_FOR = -1;
export function setAsk(p: PID, fn: AskFn | null) { ASK_FOR = fn ? p : -1; ASK = fn; HUMANS.clear(); if (fn) HUMANS.add(p); }
// online PvP: both seats are human (the same callbacks are used; askSeat() tells them which seat is being asked)
const HUMANS = new Set<number>();
export function setAskSeats(ps: PID[], fn: AskFn | null) { ASK = fn; ASK_FOR = fn && ps.length ? ps[0] : -1; HUMANS.clear(); if (fn) for (const p of ps) HUMANS.add(p); }
const topDecider = () => (DECIDER.length ? DECIDER[DECIDER.length - 1] : -1);
const humanTop = () => HUMANS.has(topDecider());
/** The human seat a question is for: the nearest human on the decider stack (callbacks run under quiet(), i.e. -1). */
export function askSeat(): number { for (let i = DECIDER.length - 1; i >= 0; i--) if (HUMANS.has(DECIDER[i])) return DECIDER[i]; return ASK_FOR; }
/** True when the human player is the one deciding right now (play mode). */
export function humanDeciding(g: Game) { return !!ASK && !g.sim && humanTop(); }
/** bugfix2 item 4 (user, แอสการ์ด): a Land's canCast is mostly the bot's "is it worth it" check; a human may always place a
 *  Land while they do not already own the one in the Land zone. */
export function humanLand(g: Game, p: number, c: Card) { return c.def.type === 'Magic' && c.def.subtype === 'Land' && humanSeat(g, p); } // bugfix4 (user): also over our own Land
/** bugfix2: p is a human seat in the real game (also inside quiet(), e.g. while the Main menu is listed). */
export function humanSeat(g: Game, p: number) { return !!ASK && !g.sim && HUMANS.has(p); }
// optional: the human may also choose none (returns null); the bot's default is dflt.
/** Run fn with p as the deciding player (the human is asked only in the real game, never in a look-ahead copy). */
export function decide<T>(g: Game, p: number, fn: () => T): T { return withDecider(g.sim ? -1 : p, fn); }
// Mode choice (เลือกปฏิบัติ / "choose one") for the human: labels, answer = index.
type ChooseFn = (title: string, labels: string[], dflt: number) => number;
let CHOOSE: ChooseFn | null = null;
export function setChoose(fn: ChooseFn | null) { CHOOSE = fn; }
export function askChoose(g: Game, title: string, labels: string[], dflt: number): number {
  if (!CHOOSE || !ASK || g.sim || !humanTop() || labels.length < 2) return dflt;
  const r = quiet(() => CHOOSE!(title, labels, dflt));
  return Number.isInteger(r) && r >= 0 && r < labels.length ? r : dflt;
}
// v12: an effect that picks a card on a field emits {ev:'target', who, from, to:[uid]} (target arrows on the screen)
let LIVE: Game | null = null;
function noteTarget(r: any) {
  const g = LIVE, src = SRC[SRC.length - 1];
  if (!g || g.sim || !src || !r || r === src || typeof r.uid !== 'number') return;
  if (!g.p.some((pl) => pl.avatars.includes(r) || pl.mz.includes(r) || pl.avatars.some((a) => a.mods.includes(r)))) return;
  emit(g, { ev: 'target', who: src.ctrl, from: src.uid, to: [r.uid] });
}
export function askPick<T>(xs: T[], dflt: T | null, o: AskOpts = {}): T | null {
  const r = askPick0(xs, dflt, o);
  noteTarget(r);
  return targetWindow(r) as T | null; // v14: 'targeted' React window (cancel / redirect)
}
// bugs7 item 2 (user): choosing a card from a Deck or a Hell always shows the pick, even when only one card qualifies
function fromPile(xs: any[]): boolean {
  const g = LIVE;
  return !!g && xs.length > 0 && xs.every((x) => g.p.some((pl) => pl.deck.includes(x) || pl.hell.includes(x)));
}
/** bugs7: true when the human decides now and every card of xs is in a Deck or a Hell (pickN must not auto-take them). */
export function humanPilePick(xs: any[]): boolean { return !!ASK && humanTop() && !!LIVE && !LIVE.sim && fromPile(xs); }
function askPick0<T>(xs: T[], dflt: T | null, o: AskOpts = {}): T | null {
  if (!ASK || !humanTop()) return dflt;
  // inside a สอดแนม: the human always sees the revealed cards and picks (even with one candidate)
  const sc = SCOUTS[SCOUTS.length - 1];
  if (sc && !o.context && xs.length && xs.every((x: any) => sc.cards.includes(x))) { sc.asked = true; o = { ...o, context: sc.cards, title: o.title || sc.title, optional: o.optional || sc.optional }; }
  else if (o.optional ? xs.length < 1 : (dflt === null || (xs.length < 2 && !fromPile(xs)))) return dflt; // bugs7 item 2: a card from a Deck / Hell is always shown
  if (!xs.every((x: any) => x && typeof x.uid === 'number' && x.def)) return dflt;
  const r = quiet(() => ASK!(xs as any, dflt as any, o)) as any;
  if (r === null && o.optional) return null;
  return xs.includes(r) ? r : dflt;
}
// ---------- the ability being resolved (its card text tells whether a scout pick is optional) ----------
const TEXT = new Map<string, string>();
export function registerText(name: string, effect: string) { if (!TEXT.has(name)) TEXT.set(name, effect || ''); }
export const cardText = (c: Card) => TEXT.get(c.def.name) || '';
const SRC: Card[] = [];
export function withSource<T>(c: Card, fn: () => T): T { SRC.push(c); try { return fn(); } finally { SRC.pop(); tagTemps(c); if (MILLS.length) flushMills(); if (DISCARDS.length) flushDiscards(); } } // v14b: FX.onDiscard; v14d: POWER sources
const MAYRE = /(?<!ความ)(?<!ไม่)(?<!ไม่ )สามารถ|กี่ใบก็ได้|ได้สูงสุด|ได้มากสุด|สูงสุด \d ใบ/;
/** Does the text of the ability being resolved match re? (used to make "สามารถ ..." picks optional) */
export function sourceSays(re: RegExp): boolean { const c = SRC[SRC.length - 1]; return !!c && re.test(cardText(c).replace(/\s+/g, ' ')); }
/** Does the source's สอดแนม sentence say the take is optional ("สามารถนำ ...", "... ได้สูงสุด")? */
function scoutOptional(c: Card | undefined): boolean {
  if (!c) return false;
  const t = cardText(c).replace(/\s+/g, ' ');
  for (let i = t.indexOf('สอดแนม'); i >= 0; i = t.indexOf('สอดแนม', i + 1)) {
    const seg = t.slice(i, i + 160).split(/ที่เหลือ|จากนั้น/)[0];
    if (MAYRE.test(seg)) return true;
  }
  return false;
}
// ---------- สอดแนม (scout) ----------
// Reveal the top n of p's Deck to both players, let pick() take cards (its choices ask the human over the revealed
// cards), then the rest go: 'bottom' in the order the owner picks (order ask), 'shuffle' back, 'top' back in order,
// or 'hell' (one mill event per card).
const SCOUTS: { cards: Card[]; asked: boolean; title: string; optional?: boolean }[] = [];
type OrderFn = (cards: Card[], title: string, where: 'bottom' | 'top') => Card[] | null;
let ORDER: OrderFn | null = null;
export function setOrder(fn: OrderFn | null) { ORDER = fn; }
/** Bottom order for cards going under p's Deck: result[0] ends up at the very bottom. */
export function askOrder(g: Game, p: PID, cards: Card[], title: string, where: 'bottom' | 'top' = 'bottom'): Card[] {
  if (cards.length <= 1 || !ORDER || g.sim || p !== topDecider() || !humanTop()) return cards;
  const r = quiet(() => ORDER!(cards, title, where));
  return r && r.length === cards.length && new Set(r).size === r.length && r.every((c) => cards.includes(c)) ? r : cards;
}
export function putBottom(g: Game, p: PID, cards: Card[], title: string) {
  const r = askOrder(g, p, cards, title);
  P(g, p).deck.push(...[...r].reverse());
}
/** "Put them on top or at the bottom of the Deck in any order": the owner picks which go on top (the bot: botTop), then
 *  orders each group (order asks: 'top' and 'bottom'). */
export function arrangeTopBottom(g: Game, p: PID, cs: Card[], title: string, botTop: (c: Card) => boolean) {
  const pl = P(g, p);
  const human = !!ASK && !g.sim && p === topDecider() && humanTop();
  let top: Card[];
  if (human && cs.length) {
    top = [];
    for (;;) {
      const rest = cs.filter((c) => !top.includes(c));
      if (!rest.length) break;
      const r = quiet(() => ASK!(rest, null, { optional: true, title: `${title}: choose a card to put on TOP of your Deck (Skip: the rest go to the bottom)` }));
      if (!r || !rest.includes(r)) break;
      top.push(r);
    }
  } else top = cs.filter(botTop);
  const bottom = cs.filter((c) => !top.includes(c));
  const r = askOrder(g, p, [...top].reverse(), `${title}: order the cards on top of your Deck`, 'top');
  pl.deck.unshift(...[...r].reverse());
  putBottom(g, p, bottom, `${title}: order the cards under your Deck`);
}
export function scoutDeck(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle', label = '') {
  const pl = P(g, p);
  { // v14: FX.blockMill ('scout') cancels it; FX.scoutBonus adds cards
    const s0 = SRC[SRC.length - 1] || null, b0 = s0 ? s0.ctrl : null;
    if (n > 0 && millBlocked(g, 'scout', p, b0, s0)) { log(g, `สอดแนม${label ? ' (' + label + ')' : ''} is cancelled`); return; }
    if (n > 0) n += bonusOf(g, 'scoutBonus', p, n, b0, s0);
  }
  const s0scout = SRC[SRC.length - 1] || null; // v14c
  const top = pl.deck.splice(0, n);
  const title = `${label ? label + ': ' : ''}สอดแนม ${top.length}`;
  if (top.length) {
    const s = `P${p} reveals the top ${top.length} of their Deck${label ? ` (${label})` : ''}: ${top.map((c) => c.def.name).join(', ')}`;
    log(g, s);
    emit(g, { ev: 'reveal', who: p, cards: top.map((c) => ({ uid: c.uid, print: c.def.print, name: c.def.name })), s });
  }
  const ctx = { cards: [...top], asked: false, title: title + ' · choose a card', optional: scoutOptional(SRC[SRC.length - 1]) };
  SCOUTS.push(ctx);
  try { pick(top); } finally { SCOUTS.pop(); }
  let left = top.filter((c) => !findCard(g, c.uid));
  if (left.length && withHook('onScouted').size) { scoutWatch(g, p, left, s0scout); left = left.filter((c) => !findCard(g, c.uid)); } // v14c: FX.onScouted
  if (top.length && !ctx.asked && ASK && !g.sim && p === topDecider() && humanTop()) {
    const took = top.filter((c) => !left.includes(c));
    quiet(() => ASK!([], null, { none: true, optional: true, context: ctx.cards, title: `${title}: ${took.length ? 'took ' + took.map((c) => c.def.name).join(', ') : 'nothing can be taken'}` }));
  }
  if (rest === 'hell') {
    left.forEach((c, i) => { pl.hell.push(c); emit(g, { ev: 'mill', who: p, uid: c.uid, print: c.def.print, name: c.def.name, i: i + 1, n: left.length }); });
  } else if (rest === 'either') { arrangeTopBottom(g, p, left, title, (c) => keepValue(g, c) >= 3.5);
  } else if (rest === 'top') {
    // back on top in the owner's order: result[0] is the deepest of them, the last one ends on top
    const r = askOrder(g, p, [...left].reverse(), `${title}: order the cards on top of your Deck`, 'top');
    pl.deck.unshift(...[...r].reverse());
  }
  else if (rest === 'bottom') putBottom(g, p, left, `${title}: order the rest under your Deck`);
  else { pl.deck.push(...left); shuffle(g, pl.deck); }
}

// Paying GEM: in play mode the human picks which hand cards to pay with (see choosePayment).
type PayFn = (g: Game, p: PID, cost: number, cands: Card[], dflt: Card[], forCard: Card | null) => Card[] | null;
let PAY: PayFn | null = null;
export function setPay(fn: PayFn | null) { PAY = fn; }
let LOG_HOOK: ((g: Game, s: string) => void) | null = null;
export function setLogHook(fn: ((g: Game, s: string) => void) | null) { LOG_HOOK = fn; }
// Called when a turn enters a new phase (the play table announces it). Not called in look-ahead copies.
let PHASE_HOOK: ((g: Game) => void) | null = null;
export function setPhaseHook(fn: ((g: Game) => void) | null) { PHASE_HOOK = fn; }
function enterPhase(g: Game, ph: Game['phase']) { g.phase = ph; if (PHASE_HOOK && !g.sim) PHASE_HOOK(g); }
// Game events for the play table (draw, summon, pay, attack, hit, destroy, LIFE...). Never fired in look-ahead copies.
export type GameEv = { ev: string; [k: string]: any };
let EV_HOOK: ((g: Game, e: GameEv) => void) | null = null;
export function setEvHook(fn: ((g: Game, e: GameEv) => void) | null) { EV_HOOK = fn; }
export function emit(g: Game, e: GameEv) { if (EV_HOOK && !g.sim) EV_HOOK(g, e); }

// ---------- rng ----------
export function rand(g: Game): number {
  // mulberry32
  let t = (g.rng = (g.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** 2026-10-23 (user): a card's d6 roll, sent to the UI as { ev: 'roll', n, who, by, name } so the duel can show the die. */
export function rollDie(g: Game): number {
  const n = 1 + Math.floor(rand(g) * 6);
  const src = currentSource();
  emit(g, { ev: 'roll', n, who: src ? src.ctrl : g.active, by: src ? src.uid : -1, name: src ? src.def.name : '', s: '' }); // the card's own log line names the roll
  return n;
}
export function shuffle<T>(g: Game, a: T[]) {
  if (!g.sim && g.p && g.p[0]) { const w = g.p.findIndex((pl) => pl && (pl.deck as unknown) === a); if (w >= 0 && a.length > 1) emit(g, { ev: 'shuffle', who: w }); }
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(g) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
export function log(g: Game, s: string) {
  if (g.log && !g.sim) g.log.push(`T${g.turn} P${g.active} ${g.phase}: ${s}`);
  if (LOG_HOOK && !g.sim) LOG_HOOK(g, s);
}

// ---------- cards ----------
export function newCard(g: Game, def: Def, owner: PID, token = false): Card {
  const c: Card = {
    uid: g.nextUid++, def, owner, ctrl: owner, token, asleep: false, mods: [], wearer: -1, temp: [],
    kick: false, bonus: 0, noWakeUntil: 0, magicImmuneUntil: 0, silencedTurn: -1,
    fumaExile: false, goemonGain: false, f: {},
  };
  bindCard(g, c); // v14 view: card -> game (effective symbols / names / cost)
  return c;
}
// rm01: the วานร token is card SD09-026 (picture bottcg-import/images/SD09-026.png); its Symbol is สัตว์ (user sheet 2026-10-18)
export const TOKEN_VANARA: Def = { print: 'SD09-026', name: 'Token วานร', type: 'Token', subtype: '', cost: 1, gem: 0, power: 1, symbol: 'สัตว์', color: 'เขียว', only: false };
// ---------- LIFE cards ----------
// Parse a LIFE card's Thai text into a LifeSpec (all 84 LIFE prints use one of these patterns).
export function lifeSpec(text: string): LifeSpec | null {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (!t.trim()) return null;
  const atkOnly = t.includes('ถูกหงายจากการโจมตี');
  const when: LifeSpec['when'] = t.includes('Battle Phase') ? 'battle' : 'main';
  const base = { when, atkOnly };
  if (/Construct ทุกใบ.*POWER ?\+ ?1/.test(t)) return { ...base, k: 'powerCon' };
  if (/Avatar ทุกใบ.*POWER ?\+ ?1/.test(t)) return { ...base, k: 'powerAv' };
  if (t.includes('Token วานร')) { const m = t.match(/"วานร" (\d+) ใบ/); return { ...base, k: 'vanaraToken', n: m ? Number(m[1]) : 4 }; }
  if (t.includes('สอดแนม')) { const m = t.match(/สอดแนม (\d+)/); return { ...base, k: 'scout', n: m ? Number(m[1]) : 5, sel: t.includes('นำ Construct') ? 'construct' : 'avatar', may: true }; }
  if (/อัญเชิญ Avatar .*จากมือ/.test(t)) {
    const m = t.match(/Avatar สี(\S+) /), c = t.match(/Cost (\d+) หรือต่ำกว่า/);
    return { ...base, k: 'summonHand', color: m ? m[1] : '', maxCost: c ? Number(c[1]) : 4, may: true };
  }
  if (/อัญเชิญ Avatar .*จากนรก/.test(t)) { const c = t.match(/Cost ไม่เกิน (\d+)/); return { ...base, k: 'summonHell', maxCost: c ? Number(c[1]) : 2 }; }
  if (t.includes('ขึ้นมือ') && t.includes('นรก')) {
    const sel = t.includes('Construct') ? 'construct' : t.includes('Normal Magic') ? 'normal' : t.includes('Modification') ? 'mod' : 'gem3';
    return { ...base, k: 'hellToHand', sel, may: true };
  }
  if (t.includes('จั่วการ์ด')) { const m = t.match(/จั่วการ์ด (\d+)/); return { ...base, k: 'draw', n: m ? Number(m[1]) : 1 }; }
  return null;
}
// Decks with no LIFE list get 5 different basic "draw 1" LIFE cards (SD01-021..025).
const BASIC_LIFE: [string, string][] = [['SD01-021', 'ไม่นะ อิศวร !'], ['SD01-022', 'ไม่นะ นนทก !'], ['SD01-023', 'ไม่นะ อัปสร !'], ['SD01-024', 'ไม่นะ ซาร่า !'], ['SD01-025', 'ไม่นะ หลวงพ่อ !']];
export const DEFAULT_LIFE: Def[] = BASIC_LIFE.map(([print, name]) => ({
  print, name, type: 'Life', subtype: '', cost: 0, gem: 0, power: 0, symbol: '', color: '', only: false, gemColor: 'colorless', req: null,
  life: { k: 'draw', n: 1, when: 'main', atkOnly: true },
}));

export function fx(c: Card) { const own = FX[c.def.name] || FX[c.def.print]; return c.f && (c.f as any)['cp:name'] ? withCopy(c, own) : own; } // v14b: copied abilities
// Text deletion (เชาว์ปัญญาลิง etc.): the card loses its ability keywords (✓) and normal text for the turn.
// คำสั่งเสีย, ลูกฮึด and ต่อเนื่อง text stay, unless the deletion is "full" (ตัดเน็ต, กระแสอัปมงคล: c.f.fullSil).
// "#" lines are card stats (Def.aka / syms / colors) and are never removed.
export function silenced(g: Game, c: Card) { return abilitiesOff(g, c, 'ability'); } // v14: + FX.textOff, unaffected
export function fullSilenced(g: Game, c: Card) { return !unaffected(g, c) && ((c.silencedTurn === g.turn && c.f.fullSil === g.turn) || ownTextOff(g, c, 'all') || textOffBy(g, c, 'all')); }
/** Continuous (ต่อเนื่อง) text is off: full deletion, or normal deletion of a card with no ต่อเนื่อง text. */
export function contOff(g: Game, c: Card) { return abilitiesOff(g, c, 'cont'); }
export function silenceFull(g: Game, c: Card) { c.silencedTurn = g.turn; c.f.fullSil = g.turn; }
/** Name check ("ติดชื่อ"): printed name, "#" names, and names gained / changed in play (v14 view.ts namesOf). */
export function nameHas(c: Card, key: string) { return hasName(c, key); }
/** Symbol check that also sees "#" extra symbols, in every zone. */
/** v14: also symbols gained / changed in play (view.ts symbolsOf: symbolsFor hooks, setSymbols, '*' = every symbol). */
export function symIs(c: Card, s: string) { return hasSymbol(c, s); }
export function symAny(c: Card, ss: string[]) { return ss.some((s) => symIs(c, s)); }
/** Colour check (Thai colour name) that also sees "#" extra colours and "every colour". */
export function colorIs(c: Card, col: string) { return c.def.color === col || (!!col && !!c.def.allColors) || !!(c.def.colors && c.def.colors.includes(col)); }
export const COLOR_EN: Record<string, string> = { 'แดง': 'red', 'เขียว': 'green', 'ฟ้า': 'blue', 'ม่วง': 'purple', 'เหลือง': 'yellow' };
/** All colours of a card in English (base colour + "#" extras); [] = no colour. */
export function colorsEn(c: Card): string[] {
  if (c.def.allColors) return ['red', 'green', 'blue', 'purple', 'yellow'];
  const out = new Set<string>();
  for (const t of [c.def.color, ...(c.def.colors || [])]) if (COLOR_EN[t]) out.add(COLOR_EN[t]);
  return [...out];
}
export function isNinja(c: Card) { return c.def.type !== 'Magic' && nameHas(c, 'นินจา'); }
export function isVanara(c: Card) { return c.def.type !== 'Magic' && (nameHas(c, 'วานร') || symIs(c, 'วานร')); }
export function isAvatarDef(d: Def) { return d.type === 'Avatar' || d.type === 'Token'; }
export function opp(p: PID): PID { return (1 - p) as PID; }
export function P(g: Game, p: PID): Player { return g.p[p]; }
export function realAvatars(pl: Player) { return pl.avatars.filter((a) => !a.token); }
// Each player's game, so canPlaceAvatar(pl) can see the Land (registered by newGame / cloneSim).
const GAME_OF = new WeakMap<Player, Game>();
export function registerGame(g: Game) { for (const pl of g.p) GAME_OF.set(pl, g); bindGame(g); }
// พิภพรัททาทุย (BT04-059 / SD08-017): while every Avatar on our Avatar Zone is {symbol รัททาทุย}, we may control
// 6 รัททาทุย Avatars there (the zone normally holds 4 + tokens, max 6 cards).
export function ratSix(g: Game, pl: Player): boolean {
  return !!landIs(g, 'พิภพรัททาทุย', pl.id) && pl.avatars.every((a) => symIs(a, 'รัททาทุย'));
}
// ---------- Lands (v13) ----------
// One shared Land slot (g.land). While แบ่งแยกดินแดน (PRMO-029) is in play, a player who places a Land puts it in their
// own Magic Zone instead (one extra Land each; the old extra Land goes to นรก), and every Land in play works.
// When แบ่งแยกดินแดน leaves, the extra Lands are destroyed too (landCheck, from stateCheck).
export const PARTITION = 'แบ่งแยกดินแดน';
export const isLand = (c: Card) => c.def.type === 'Magic' && c.def.subtype === 'Land';
/** Every Land in play: the shared slot first, then extra Lands in the Magic Zones (แบ่งแยกดินแดน). */
export function lands(g: Game): Card[] {
  const out: Card[] = g.land ? [g.land] : [];
  for (const pl of g.p) for (const c of pl.mz) if (isLand(c) && !c.f.faceDown) out.push(c);
  return out;
}
const landNamed = (l: Card, name: string) => l.def.name === name || !!(l.def.aka && l.def.aka.includes(name)) || !!(fx(l)?.alias || []).includes(name);
/** The Land in play with this name (or "#counts as" name), optionally controlled by ctrl; null when there is none. */
export function landIs(g: Game, name: string, ctrl?: PID): Card | null {
  return lands(g).find((l) => landNamed(l, name) && (ctrl === undefined || l.ctrl === ctrl) && !silenced(g, l)) || null;
}
export const isLandOn = (g: Game, c: Card) => lands(g).includes(c);
export const partitionOn = (g: Game) => lands(g).some((l) => l.def.name === PARTITION);
/** Put a Land into play for p (cast, or "play a Land from Deck"): the shared slot, or p's Magic Zone under แบ่งแยกดินแดน. */
export function placeLand(g: Game, p: PID, c: Card) {
  detach(g, c);
  c.ctrl = p;
  if (partitionOn(g) && c.def.name !== PARTITION) {
    const pl = P(g, p);
    for (const old of pl.mz.filter(isLand)) { detach(g, old); P(g, old.owner).hell.push(old); log(g, `${old.def.name} is replaced (one extra Land each)`); }
    pl.mz.push(c);
    log(g, `${c.def.name} goes to P${p}'s Magic Zone (แบ่งแยกดินแดน: both Lands stay)`);
    enterPlay(g, c); // v14c
    return;
  }
  if (g.land) { const old = g.land; g.land = null; P(g, old.owner).hell.push(old); }
  g.land = c;
  landCheck(g);
  enterPlay(g, c); // v14c: FX.onEnterPlay
}
/** Extra Lands exist only while แบ่งแยกดินแดน is in play: when it is gone, they are destroyed. */
export function landCheck(g: Game) {
  if (partitionOn(g)) return;
  for (const pl of g.p) for (const c of pl.mz.filter(isLand)) {
    detach(g, c); P(g, c.owner).hell.push(c);
    log(g, `${c.def.name} is destroyed (แบ่งแยกดินแดน left play)`);
  }
}
// c: the card about to enter (when known). Without c the พิภพรัททาทุย extra slots are offered; summon() checks the card.
export function canPlaceAvatar(pl: Player, token = false, c: Card | null = null) {
  if (pl.avatars.length >= 6) return false;
  { const g0 = GAME_OF.get(pl); if (g0 && pl.avatars.length >= zoneCap(g0, pl.id)) return false; } // v14: นรกในกรง etc.
  if (token || realAvatars(pl).length < 4) return true;
  const g = GAME_OF.get(pl);
  return !!g && ratSix(g, pl) && (!c || symIs(c, 'รัททาทุย'));
}
export function flippedLife(pl: Player) { return pl.life.filter((l) => l.faceUp).length; }
export function critical(pl: Player) { return flippedLife(pl) >= pl.life.length; }
export function findCard(g: Game, uid: number): Card | null {
  for (const pl of g.p) for (const z of [pl.hand, pl.avatars, pl.hell, pl.deck, pl.exile, pl.mz]) {
    for (const c of z) { if (c.uid === uid) return c; for (const m of c.mods) if (m.uid === uid) return m; }
  }
  if (g.land && g.land.uid === uid) return g.land;
  return null;
}
export function onceUsed(g: Game, pl: Player, key: string) { return pl.once[onceK(key)] === g.turn; }
export function markOnce(g: Game, pl: Player, key: string) { pl.once[onceK(key)] = g.turn; }
// bugfix1 item 11 (user): "เทิร์นละครั้ง" on a field ability is once per COPY (two ซีกรุน may each use theirs), unless the
// text limits the name ("ชื่อนี้"). The fx files key once() by name; while a field ability is checked (learn) or run, the
// keys its can() checks get the card's uid added.
const ONCE_CARD: Card[] = [];
const ONCE_KEYS = new Map<string, Set<string>>();
const PER_COPY = new Map<string, boolean>();
let ONCE_LEARN = false;
function perCopy(c: Card): boolean {
  let v = PER_COPY.get(c.def.name);
  if (v === undefined) { const t = cardText(c).replace(/\s+/g, ' '); v = /เทิร์นละ\s*ครั้ง/.test(t) && !/ชื่อนี้|ชื่อเดียวกัน/.test(t); PER_COPY.set(c.def.name, v); }
  return v;
}
function onceK(key: string): string {
  const c = ONCE_CARD[ONCE_CARD.length - 1];
  if (!c || !perCopy(c)) return key;
  let s = ONCE_KEYS.get(c.def.name);
  if (ONCE_LEARN) { if (!s) ONCE_KEYS.set(c.def.name, (s = new Set())); s.add(key); }
  return s && s.has(key) ? key + '#' + c.uid : key;
}
function withOnceCard<T>(c: Card, learn: boolean, fn: () => T): T {
  const l0 = ONCE_LEARN; ONCE_CARD.push(c); ONCE_LEARN = learn;
  try { return fn(); } finally { ONCE_CARD.pop(); ONCE_LEARN = l0; }
}

// ---------- power ----------
export function power(g: Game, c: Card): number {
  const imm = unaffected(g, c); // v14: unaffected = no temporary changes, auras of other cards or Land bonuses
  let v = c.def.power + c.bonus;
  const shield = withHook('shieldFrom').size > 0; // v14d: POWER changes from sources c ignores (unaffectedBy)
  for (const t of c.temp) if (tempCounts(g, c, t, imm, shield)) v += t.power;
  for (const m of c.mods) { const f = fx(m); if (f && f.modPower) v += f.modPower(g, m, c); }
  const f = fx(c);
  if (f && f.staticPower && !contOff(g, c)) v += f.staticPower(g, c);
  for (const l of lands(g)) { const lf = fx(l); if (lf && lf.landPower && (!(imm || shield) || !unaffectedBy(g, c, l))) v += lf.landPower(g, l, c); }
  for (const q of g.p) for (const s of q.avatars.concat(q.mz)) {
    const sf = fx(s);
    if (sf && sf.aura && !contOff(g, s) && (s === c || !(imm || shield) || !unaffectedBy(g, c, s))) v += sf.aura(g, s, c);
  }
  return Math.max(0, v);
}

// ---------- keywords (v13: one system for own and granted keywords) ----------
// unite สามัคคี, shield โล่มนุษย์, kick เตะไข่, backstab แทงหลัง, tieWin ลูกฮึด, exact พอดี.
// Own keywords: the card's text (fx flags, kwIf / kickIf conditions, Def.backstab / Def.exactKw). They are ✓ ability
// keywords, so text deletion removes them; ลูกฮึด stays unless the deletion is full (ตัดเน็ต / กระแสอัปมงคล).
// Granted keywords ("ได้รับ ..."): grant() hooks of every card in play (Avatars, Magic Zone cards incl. Constructs and
// persistent Magic, extra Lands, attached Modifications, the Land, face-up LIFE cards) plus temporary grants (grantKw:
// until the end of a turn or of the current fight). They are lost only to a full deletion of the receiving card.
// denyKw() hooks take a keyword away ("ฝ่ายตรงข้ามไม่สามารถใช้ สามัคคี"). Every rules check calls hasKw.
export type Kw = 'unite' | 'shield' | 'kick' | 'backstab' | 'tieWin' | 'exact';
export const KW_TH: Record<Kw, string> = { unite: 'สามัคคี', shield: 'โล่มนุษย์', kick: 'เตะไข่', backstab: 'แทงหลัง', tieWin: 'ลูกฮึด', exact: 'พอดี' };
export const KWS = Object.keys(KW_TH) as Kw[];
/** Cards whose text is in play and can grant or deny keywords. */
export function kwSources(g: Game): Card[] {
  const out: Card[] = [];
  for (const q of g.p) {
    for (const a of q.avatars) { out.push(a); out.push(...a.mods); }
    for (const s of q.mz) if (!s.f.faceDown) out.push(s);
    for (const l of q.life) if (l.faceUp) out.push(l.card);
  }
  if (g.land) out.push(g.land);
  return out;
}
/** Temporary grant: until the end of turn `until` (g.turn = this turn, g.turn + 1 = the end of the next turn), or
 *  'battle' = until the end of the current fight. */
export function grantKw(g: Game, c: Card, kw: Kw, until: number | 'battle' = g.turn) {
  if (until === 'battle') c.f['kwb:' + kw] = 1;
  else c.f['kw:' + kw] = Math.max(c.f['kw:' + kw] || 0, until);
}
function tempKw(g: Game, c: Card, kw: Kw) { return (c.f['kw:' + kw] || 0) >= g.turn || !!c.f['kwb:' + kw] || (kw === 'kick' && c.kick); }
/** The card's own keyword (its text). */
export function ownKw(g: Game, c: Card, kw: Kw): boolean {
  const f = fx(c);
  // ลูกฮึด is not an ability keyword: it survives normal text deletion
  const off = abilitiesOff(g, c, kw === 'tieWin' ? 'grit' : 'kw'); // v14: central check
  if (off) return false;
  if (kw === 'backstab' && c.def.backstab) return true;
  if (kw === 'exact') return !!c.def.exactKw;
  if (kw === 'kick') return !!(f && f.kickIf && f.kickIf(g, c));
  if (f && (f as any)[kw] === true) return true;
  return !!(f && f.kwIf && f.kwIf(g, c, kw));
}
/** A keyword given to the card by another card's text or by a temporary effect. */
export function grantedKw(g: Game, c: Card, kw: Kw): boolean {
  if (fullSilenced(g, c) || unaffected(g, c)) return false; // ตัดเน็ต: gained abilities are lost too
  if (tempKw(g, c, kw)) return true;
  for (const s of kwSources(g)) {
    const sf = fx(s);
    if (sf && sf.grant && !contOff(g, s) && sf.grant(g, s, c, kw)) return true;
  }
  return false;
}
export function deniedKw(g: Game, c: Card, kw: Kw): boolean {
  if (unaffected(g, c)) return false;
  for (const s of kwSources(g)) { const sf = fx(s); if (sf && sf.denyKw && !contOff(g, s) && sf.denyKw(g, s, c, kw)) return true; }
  return false;
}
export function hasKw(g: Game, c: Card, kw: Kw): boolean {
  return (ownKw(g, c, kw) || grantedKw(g, c, kw)) && !deniedKw(g, c, kw);
}
/** Keyword badges for the screen: [{k: Thai keyword, granted}] (own keywords first). */
export function kwList(g: Game, c: Card): { k: string; granted: boolean }[] {
  const out: { k: string; granted: boolean }[] = [];
  for (const kw of KWS) {
    if (deniedKw(g, c, kw)) continue;
    if (ownKw(g, c, kw)) out.push({ k: KW_TH[kw], granted: false });
    else if (grantedKw(g, c, kw)) out.push({ k: KW_TH[kw], granted: true });
  }
  return out;
}
// Own awake Avatars that can help an attack: สามัคคี (adds its POWER) or แทงหลัง (+1, colour check after the fight).
// canHelp: "can use สามัคคี only for ธอร์" (โลกิ).
export function helpersFor(g: Game, p: PID, att: Card): Card[] {
  return P(g, p).avatars.filter((u) => u !== att && !u.asleep && (hasKw(g, u, 'unite') || hasKw(g, u, 'backstab'))
    && !(fx(u)?.canHelp && !silenced(g, u) && !fx(u).canHelp!(g, u, att)));
}
// ---------- โล่มนุษย์ (v13) ----------
// When an opposing Avatar declares an attack (on one of p's Avatars or on p's LIFE, เตะไข่ too), an awake โล่มนุษย์ Avatar
// of p may take the attack instead.
export function shieldOptions(g: Game, p: PID, ev: Ev): Card[] {
  // bugs7 item 4: "can't use โล่มนุษย์" comes from a card the attacker wears now (อาลอนไดร์ท: FX.blockShield); it used to be a
  // flag on the attacker that stayed after the sword left
  if (ev.kind !== 'attack' || ev.actor === p || !ev.source || ev.source.mods.some((m) => fx(m)?.blockShield && !contOff(g, m))) return [];
  return P(g, p).avatars.filter((a) => !a.asleep && a !== ev.target && hasKw(g, a, 'shield'));
}
/** a uses โล่มนุษย์: it rests and becomes the attack target. Fires onShieldUsed of every card in play. */
export function useShield(g: Game, ev: Ev, a: Card) {
  a.asleep = true; ev.target = a;
  emit(g, { ev: 'shield', who: a.ctrl, uid: a.uid, from: ev.source ? ev.source.uid : -1, s: `${a.def.name} โล่มนุษย์: takes the attack` } as any); // vd4: the screen turns the attack to it
  log(g, `${a.def.name} โล่มนุษย์: takes the attack of ${ev.source ? ev.source.def.name : '?'} instead`);
  for (const s of kwSources(g)) { const sf = fx(s); if (sf && sf.onShieldUsed && !silenced(g, s)) decide(g, s.ctrl, () => sf.onShieldUsed!(g, s, a, ev.source!)); }
}
// ---------- control changes (v13) ----------
/** May c (an Avatar in play) change controller to `to`? Not while its controller has รูปประจำบ้าน (BT11-073) in play. */
export function canChangeCtrl(g: Game, c: Card, to: PID, by: Card | null = currentSource()): boolean {
  if (c.ctrl === to) return true;
  const pl = P(g, c.ctrl);
  if (!pl.avatars.includes(c) && !pl.mz.includes(c) && !pl.avatars.some((a) => a.mods.includes(c))) return true;
  const f = fx(c) as any; // its own "can't change control" (ไอ้นัท except by อีช่า, สว นาโนแมชชีน, ไมเกรน)
  if (f?.noSteal && !contOff(g, c) && !(f.noStealExcept && by && by.def.name === f.noStealExcept)) return false;
  if (c.mods.some((m) => (fx(m) as any)?.noSteal)) return false; // attached "can't change control" (ปลอกคอซื่อสัตย์)
  return !pl.mz.some((s) => fx(s)?.lockCtrl && !contOff(g, s));
}
/** Take control of Avatar t for p (to p's Avatar Zone, or to p's Magic Zone). false when it is not allowed. */
export function takeControl(g: Game, t: Card, p: PID, where: 'avatars' | 'mz' = 'avatars', by: Card | null = currentSource()): boolean {
  if (!canChangeCtrl(g, t, p, by)) { log(g, `${t.def.name}: its control can't be changed`); return false; }
  detach(g, t); t.ctrl = p;
  (where === 'mz' ? P(g, p).mz : P(g, p).avatars).push(t);
  return true;
}
// ---------- unaffected by opponent Magic ----------
/** c is unaffected by the Magic of player `by` (an effect this turn, or a continuous text: fx.magicImmune). */
export function magicImmune(g: Game, c: Card, by: PID): boolean {
  if (unaffected(g, c)) return true;
  if (by === c.ctrl) return false;
  if (c.magicImmuneUntil >= g.turn) return true;
  const f = fx(c);
  return !!(f && f.magicImmune && !contOff(g, c) && f.magicImmune(g, c));
}
type MillRec = { g: Game; p: PID; cards: Card[]; byVirus: boolean; info: MillInfo; depth: number };
const MILLS: MillRec[] = [];
function runMilled(g: Game, p: PID, cards: Card[], byVirus: boolean, info: MillInfo) {
  const pl = P(g, p);
  for (const c of cards) { if (g.winner !== null) return; const f = fx(c); if (f && f.onMilled && pl.hell.includes(c)) decide(g, p, () => f.onMilled!(g, c, p, byVirus, info)); }
}
function flushMills() {
  while (MILLS.length && MILLS[MILLS.length - 1].depth > SRC.length) { const r = MILLS.pop()!; if (r.g.winner === null) runMilled(r.g, r.p, r.cards, r.byVirus, r.info); }
}
// Mill (ธรณีสูบ): top n cards of p's deck to hell, firing "when milled" effects.
export function mill(g: Game, p: PID, n: number, byVirus = false): Card[] {
  const pl = P(g, p), out: Card[] = [];
  // v14: who milled (current source), FX.blockMill cancels, FX.millBonus adds cards
  const src = currentSource(), by = src ? src.ctrl : null;
  if (n > 0 && millBlocked(g, 'mill', p, by, src)) { log(g, `ธรณีสูบ${src ? ' by ' + src.def.name : ''} is cancelled`); return out; }
  if (n > 0) n += bonusOf(g, 'millBonus', p, n, by, src);
  const k = Math.min(n, pl.deck.length);
  for (let i = 0; i < n && pl.deck.length; i++) {
    const c = pl.deck.shift()!; pl.hell.push(c); out.push(c);
    emit(g, { ev: 'mill', who: p, uid: c.uid, print: c.def.print, name: c.def.name, i: i + 1, n: k });
  }
  const info: MillInfo = { owner: p, cards: out, by, src, duringMagic: (!!src && src.def.type === 'Magic') || g.p.some((q) => (q.resolving || []).length > 0), byVirus };
  if (out.length) { const t = turnLog(g); t.milled[p] += out.length; if (by !== null) t.millBy[by] += out.length; }
  // other-team audit: the card that commands ธรณีสูบ finishes its own effect first, then the milled cards' own abilities
  // (FX.onMilled) run; outside an ability they run at once
  if (out.length) { if (SRC.length) MILLS.push({ g, p, cards: out, byVirus, info, depth: SRC.length }); else runMilled(g, p, out, byVirus, info); }
  // "อัตโนมัติ เมื่อมีการ ธรณีสูบ" (บิฟร็อสต์): cards in play that watch every mill
  if (out.length) for (const s of kwSources(g)) { const sf = fx(s); if (sf && sf.onAnyMill && !contOff(g, s)) decide(g, s.ctrl, () => sf.onAnyMill!(g, s, p, out)); }
  if (out.length) millWatch(g, info); // v14: FX.onMill of cards in play, hands and Hells
  return out;
}
/** The card whose ability is being resolved right now (null outside an ability). */
export function currentSource(): Card | null { return SRC.length ? SRC[SRC.length - 1] : null; }
export function costOf(g: Game, p: PID, c: Card): number {
  const f = fx(c);
  return viewCost(g, p, c, f && f.costOf ? f.costOf(g, p, c) : c.def.cost); // v14: + costMod hooks, setCost overrides
}

// ---------- setup ----------
// deferFirst: the caller picks the first player (dice) and runs mulligans; the first player then
// draws their 2 extra cards in the first Draw Phase.
// lives: each player's 5 LIFE cards (null / missing = DEFAULT_LIFE). They are shuffled and laid face down.
export function newGame(decks: [Def[], Def[]], names: [string, string], seed: number, logOn = false, deferFirst = false, lives?: [Def[] | null, Def[] | null]): Game {
  const g: Game = {
    p: [null as any, null as any], land: null, turn: 1, active: 0, first: 0, phase: 'Draw',
    rng: seed | 0, nextUid: 1, winner: null, stopBattle: false, sim: false, log: logOn ? [] : null,
    stats: { attacks: 0, lifeHits: [0, 0] },
  };
  LIVE = g;
  refreshHooks(); // v14 hook caches
  for (const i of [0, 1] as PID[]) {
    const pl: Player = {
      id: i, deck: [], hand: [], avatars: [], hell: [], exile: [], life: [],
      used: { Normal: false, Modification: false, React: false, Land: false },
      once: {}, onceGame: {}, returnAtMain: [], mz: [], resolving: [], returnAtEnd: [], partner: false, deckName: names[i],
    };
    pl.deck = decks[i].map((d) => newCard(g, d, i));
    shuffle(g, pl.deck);
    const ld = lives && lives[i] && lives[i]!.length ? lives[i]! : DEFAULT_LIFE;
    const lc = ld.map((d) => newCard(g, d, i));
    shuffle(g, lc);
    for (const c of lc.slice(0, 5)) pl.life.push({ card: c, faceUp: false });
    g.p[i] = pl;
  }
  registerGame(g);
  g.first = rand(g) < 0.5 ? 0 : 1; // coin flip
  g.active = g.first;
  for (const i of [0, 1] as PID[]) draw(g, i, 5);
  if (deferFirst) g.firstDraw2 = true;
  else draw(g, g.first, 2); // first player draws 2 extra (hand 7) and can't attack on turn 1
  return g;
}

/** Put the chosen hand cards back, shuffle, and draw the same number. */
export function mulligan(g: Game, p: PID, cards: Card[]) {
  const pl = P(g, p);
  const back = cards.filter((c) => pl.hand.includes(c));
  if (!back.length) { log(g, `P${p} keeps their hand`); emit(g, { ev: 'mulligan', who: p, n: 0 }); return; }
  pl.hand = pl.hand.filter((c) => !back.includes(c));
  pl.deck.push(...back);
  shuffle(g, pl.deck);
  draw(g, p, back.length);
  log(g, `P${p} mulligans ${back.length} card${back.length > 1 ? 's' : ''}`);
  emit(g, { ev: 'mulligan', who: p, n: back.length });
}

// ---------- basic moves ----------
export function lose(g: Game, p: PID, why: string) {
  if (g.winner === null) { g.winner = opp(p); log(g, `P${p} loses: ${why}`); }
}
export function draw(g: Game, p: PID, n: number) {
  const pl = P(g, p);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const c = pl.deck.shift();
    if (!c) { if (k) emit(g, { ev: 'draw', who: p, n: k }); lose(g, p, 'deck out'); return; }
    pl.hand.push(c); k++;
    if (!pl.deck.length) { emit(g, { ev: 'draw', who: p, n: k }); lose(g, p, 'drew the last card of the deck'); return; } // user rule 2026-10-12
  }
  if (k) emit(g, { ev: 'draw', who: p, n: k });
}
function removeFrom(arr: Card[], c: Card) { const i = arr.indexOf(c); if (i >= 0) { arr.splice(i, 1); return true; } return false; }
export function detach(g: Game, c: Card) {
  for (const pl of g.p) {
    if (removeFrom(pl.hand, c) || removeFrom(pl.avatars, c) || removeFrom(pl.hell, c) || removeFrom(pl.deck, c) || removeFrom(pl.exile, c) || removeFrom(pl.mz, c)) return;
    for (const a of pl.avatars) if (removeFrom(a.mods, c)) { c.wearer = -1; return; }
  }
  if (g.land === c) g.land = null;
}
function resetOnLeave(c: Card) {
  c.asleep = false; c.temp = []; c.kick = false; c.bonus = 0; c.noWakeUntil = 0; c.magicImmuneUntil = 0;
  c.silencedTurn = -1; c.fumaExile = false; c.goemonGain = false; c.ctrl = c.owner; c.f = {};
}
function dropMods(g: Game, c: Card) {
  for (const m of c.mods.splice(0)) {
    m.wearer = -1;
    const f = fx(m);
    if (f && f.onWearerLeave && decide(g, m.owner, () => f.onWearerLeave!(g, m, c))) continue; // re-attached elsewhere
    P(g, m.owner).hell.push(m);
  }
}
// v14: a card in play goes through leave-field protection (leaveGuarded) and the after-leave triggers (afterLeft).
// Returns false when it stayed on the field. o.cost = paid as a cost (never stopped); o.by / o.src default to the current source.
export function toHell(g: Game, c: Card, o: LeaveOpts = {}): boolean {
  return leaveTo(g, c, 'hell', o, () => P(g, c.owner).hell.push(c));
}
export function toHand(g: Game, c: Card, p: PID = c.owner, o: LeaveOpts = {}): boolean {
  const ok = leaveTo(g, c, 'hand', o, () => P(g, p).hand.push(c));
  if (ok && P(g, p).hand.includes(c)) handWatch(g, c, 'field', { by: o.by, src: o.src }); // v14b: FX.onToHand
  return ok;
}
export function toExile(g: Game, c: Card, o: LeaveOpts = {}): boolean {
  return leaveTo(g, c, 'exile', o, () => P(g, c.owner).exile.push(c));
}
export function discard(g: Game, p: PID, c: Card) { const w = discardWatched(g, c); detach(g, c); P(g, p).hell.push(c); if (w) noteDiscard(g, c); } // v14b: FX.onDiscard

// Destroy an Avatar (or, v14, a Construct) on the field. `by` = player whose card caused it (null = rules/battle).
// o (v14): cost = เซ่นไหว้ as a cost (no protection); src = the card causing it (default: current source).
export function destroy(g: Game, c: Card, by: PID | null, viaMagic = false, o: LeaveOpts = {}): boolean {
  const pl = P(g, c.ctrl);
  const isCon = (c.def.type === 'Construct' || isAvatarDef(c.def)) && pl.mz.includes(c); // v14d: also Avatars in the Magic Zone
  if (!pl.avatars.includes(c) && !isCon) return false;
  if (viaMagic && by !== null && magicImmune(g, c, by)) return false;
  // พระคุ้มครอง: "our Avatars can't be destroyed in battle this turn"
  const bare = !o.cost && protectionsOff(g, c); // v14c: FX.noProtect (K-BO): built-in protections don't apply
  if (!bare && FIGHT > 0 && pl.once['noBattleDie'] === g.turn) { log(g, `${c.def.name} is not destroyed in battle (พระคุ้มครอง)`); return false; }
  const f = fx(c);
  if (!bare && by !== null && by !== c.ctrl && f && f.preventLeave && !silenced(g, c) && decide(g, c.ctrl, () => f.preventLeave!(g, c))) return false;
  // Cards in hand that can stop a destruction (คาบู ช่วยด้วย)
  if (!bare && by !== c.ctrl) for (const h of [...pl.hand]) {
    const hf = fx(h);
    if (hf && hf.saveFromHand && decide(g, c.ctrl, () => hf.saveFromHand!(g, c.ctrl, h, c))) return false;
  }
  // Attached cards that die instead (โอตะ รุ่นก่อตั้ง) or protect (ดาบศักดิ์สิทธิ์ แกลลาติน)
  for (const m of [...c.mods]) {
    const mf = fx(m);
    if (!bare && mf && mf.protectWearer && decide(g, m.owner, () => mf.protectWearer!(g, m, c, by, viaMagic))) return false;
  }
  if (!bare && f && f.protectSelf && !silenced(g, c) && decide(g, c.ctrl, () => f.protectSelf!(g, c, by, viaMagic))) return false;
  // React window: the controller may stop it (หมอมาแล้วววว)
  if (by !== c.ctrl && !g.sim) {
    const ev: Ev = { kind: 'destroy', actor: opp(c.ctrl), source: c, cancelled: false, depth: 0 };
    respond(g, ev);
    if (ev.cancelled) return false;
    if (!fieldZone(g, c)) return false;
  }
  // v14: leave-field protection (FX.leaveGuard, unaffected), then คำสั่งเสีย and the after-leave triggers
  const info = leaveInfo(g, c, 'destroy', { ...o, by, viaMagic }, isCon ? 'mz' : 'avatars');
  if (!bare && !o.noGuard && LEAVE_DEPTH < 12 && leaveGuarded(g, c, info)) return false;
  if (!fieldZone(g, c)) return false;
  info.noDeathCry = abilitiesOff(g, c, 'deathCry') || deathCryBlocked(g, c, info);
  log(g, `destroy ${c.def.name}`);
  emit(g, { ev: 'destroy', who: c.ctrl, uid: c.uid, print: c.def.print });
  const owner = c.owner, ctrl = c.ctrl;
  const dcExile = !!c.f.dcExile; // granted "คำสั่งเสีย : เนรเทศ การ์ดใบนี้" (ดอกเตอร์เต้ BT12-024)
  detach(g, c); dropMods(g, c); resetOnLeave(c);
  if (!c.token) P(g, owner).hell.push(c);
  if (f && f.deathCry && !c.token && !info.noDeathCry) decide(g, owner, () => withSource(c, () => f.deathCry!(g, c, owner)));
  if (dcExile && !info.noDeathCry && P(g, owner).hell.includes(c)) { detach(g, c); P(g, owner).exile.push(c); log(g, `${c.def.name}: คำสั่งเสีย, exiled`); }
  afterLeft(g, c, info);
  checkPartner(g, ctrl);
  return true;
}

// ---------- LIFE ----------
// Open rules question: the engine makes a player lose on a LIFE hit while all 5 LIFE are already face up
// (not when the 5th one flips). See v5/audit/rule_errors.json.
export function hitLife(g: Game, p: PID, attacker: Card | null) {
  const pl = P(g, p);
  if (critical(pl)) { lose(g, p, 'LIFE attacked while all LIFE are face up'); return; }
  const idx = pl.life.findIndex((x) => !x.faceUp);
  const l = pl.life[idx];
  l.faceUp = true;
  g.stats.lifeHits[p]++;
  log(g, `P${p} LIFE flipped (${flippedLife(pl)}/5)`);
  emit(g, { ev: 'hit', who: p, kind: 'life', lifeIndex: idx });
  noteLifeFlip(g, p, idx, attacker !== null);
  if (attacker) { const f = fx(attacker); if (attacker.goemonGain && f && f.onLifeFlip) decide(g, attacker.ctrl, () => f.onLifeFlip!(g, attacker)); }
}
// A LIFE card turned face up: queue its effect for the owner's next Main (or Battle) Phase.
// "เมื่อการ์ดใบนี้ถูกหงายจากการโจมตี" cards only trigger when flipped by an attack.
function noteLifeFlip(g: Game, p: PID, idx: number, byAttack: boolean) {
  const l = P(g, p).life[idx];
  if (!l || l.seen) return;
  l.seen = true;
  const sp = l.card.def.life;
  const on = !!sp && (!sp.atkOnly || byAttack);
  l.trig = on;
  const s = `P${p} LIFE card: ${l.card.def.name}` + (on ? ` (its effect happens at the start of P${p}'s next ${sp!.when === 'battle' ? 'Battle' : 'Main'} Phase)` : sp ? ' (no effect: not flipped by an attack)' : '');
  log(g, s);
  emit(g, { ev: 'life', who: p, lifeIndex: idx, print: l.card.def.print, name: l.card.def.name, when: on ? sp!.when : 'none', s });
  lifeWatch(g, p, l.card, byAttack); // v14: FX.onLifeFlipped
}
// LIFE flipped directly by card effects (not through hitLife) are registered here; face-down ones reset.
export function scanLife(g: Game, p: PID) {
  P(g, p).life.forEach((l, i) => {
    if (!l.faceUp) { l.seen = false; l.trig = false; } else if (!l.seen) noteLifeFlip(g, p, i, false);
  });
}
// Resolve p's queued LIFE effects that wait for this phase start.
export function lifeTriggers(g: Game, p: PID, when: 'main' | 'battle') {
  scanLife(g, p);
  for (const l of P(g, p).life) {
    if (g.winner !== null) return;
    if (!l.faceUp || !l.trig || !l.card.def.life || l.card.def.life.when !== when) continue;
    l.trig = false;
    const i = P(g, p).life.indexOf(l);
    emit(g, { ev: 'lifefx', who: p, lifeIndex: i, print: l.card.def.print, name: l.card.def.name, s: `P${p}'s LIFE card ${l.card.def.name} activates` });
    decide(g, p, () => resolveLife(g, p, l.card));
    stateCheck(g);
  }
}
const lifeSel: Record<string, (c: Card) => boolean> = {
  construct: (c) => c.def.type === 'Construct',
  avatar: (c) => c.def.type === 'Avatar',
  normal: (c) => c.def.type === 'Magic' && c.def.subtype === 'Normal',
  mod: (c) => c.def.type === 'Magic' && c.def.subtype === 'Modification',
  gem3: (c) => c.def.type === 'Avatar' && c.def.gem >= 3,
};
const lifeSelName: Record<string, string> = { construct: 'Construct', avatar: 'Avatar', normal: 'Normal Magic', mod: 'Modification Magic', gem3: 'Avatar with GEM 3+' };
function pickFor(xs: Card[], score: (c: Card) => number, o: AskOpts): Card | null {
  let b: Card | null = null, bv = -Infinity;
  for (const x of xs) { const v = score(x); if (v > bv) { bv = v; b = x; } }
  return askPick(xs, b, o);
}
const handScore = (g: Game) => (c: Card) => keepValue(g, c) + c.def.power * 0.3;
export function resolveLife(g: Game, p: PID, lc: Card) {
  const sp = lc.def.life!, pl = P(g, p), nm = lc.def.name;
  log(g, `P${p} LIFE effect: ${nm}`);
  switch (sp.k) {
    case 'draw': draw(g, p, sp.n || 1); break;
    case 'powerAv': for (const a of pl.avatars) a.temp.push({ power: 1, until: 'turn' }); log(g, `P${p}'s Avatars get POWER +1 (${nm})`); break;
    case 'powerCon': for (const c of pl.mz) if (c.def.type === 'Construct') c.temp.push({ power: 1, until: 'turn' }); break;
    case 'hellToHand': {
      const c = pickFor(pl.hell.filter((x) => lifeSel[sp.sel!](x) && !hellLocked(x)), handScore(g), { optional: true, title: `${nm}: you may add 1 ${lifeSelName[sp.sel!]} from your Hell to your hand` });
      if (c && addToHand(g, c, p, { from: 'hell', by: p, src: null })) log(g, `P${p} adds ${c.def.name} from hell to hand (${nm})`);
      break;
    }
    case 'scout': {
      scoutDeck(g, p, sp.n || 5, (top) => {
        const c = pickFor(top.filter(lifeSel[sp.sel!]), handScore(g), { optional: true, title: `${nm}: you may add 1 revealed ${lifeSelName[sp.sel!]} to your hand` });
        if (c) { top.splice(top.indexOf(c), 1); pl.hand.push(c); log(g, `P${p} adds ${c.def.name} to hand (${nm})`); handWatch(g, c, 'deck', { by: p, src: null }); }
      }, 'bottom', nm);
      break;
    }
    case 'summonHand': {
      if (!canPlaceAvatar(pl)) break;
      const xs = pl.hand.filter((c) => c.def.type === 'Avatar' && (!sp.color || colorIs(c, sp.color)) && costOf(g, p, c) <= (sp.maxCost ?? 4)
        && !(fx(c) && fx(c).noHandSummon) && !uniqueBlocked(g, p, c) && summonAllowed(g, p, c, 'effect'));
      const c = pickFor(xs, (x) => value(g, x), { optional: true, title: `${nm}: you may summon 1 ${sp.color ? sp.color + ' ' : ''}Avatar with Cost ${sp.maxCost ?? 4} or less from your hand` });
      if (c) summon(g, p, c, 'effect');
      break;
    }
    case 'summonHell': {
      if (!canPlaceAvatar(pl)) break;
      const xs = pl.hell.filter((c) => c.def.type === 'Avatar' && c.def.cost <= (sp.maxCost ?? 2) && !uniqueBlocked(g, p, c) && summonAllowed(g, p, c, 'effect'));
      const c = pickFor(xs, (x) => value(g, x), { title: `${nm}: summon 1 Avatar with Cost ${sp.maxCost ?? 2} or less from your Hell` });
      if (c) summon(g, p, c, 'effect');
      break;
    }
    case 'vanaraToken': {
      if (pl.hell.filter((c) => c.def.type === 'Avatar' && isVanara(c)).length >= (sp.n || 4)) { placeToken(g, p, TOKEN_VANARA, 1); log(g, `P${p} summons a วานร token (${nm})`); }
      break;
    }
  }
}

// ---------- paying costs ----------
export function keepValue(g: Game, c: Card): number {
  // How much we'd rather keep a card than pitch it. Lower = pitch first.
  const f = fx(c);
  if (f && typeof f.keep === 'number') return f.keep;
  if (c.def.type === 'Magic') return 3 + (c.def.subtype === 'React' ? 1.5 : 0);
  return 1.5 + c.def.power * 0.6 + (f ? 1.5 : 0);
}
// Best set of hand cards whose GEM pays `cost`. Rulebook: no card in the payment may be unnecessary.
export function gemOf(g: Game, c: Card, forCard: Card | null): number {
  const f = fx(c);
  if (f && f.costOnlyFor && (!forCard || !f.costOnlyFor(forCard))) return 0;
  if (f && f.gemAs) return f.gemAs(g, c, forCard);
  { const v = gemOverride(g, c, forCard); if (v !== null) return v; } // v14c: RuleDef.pay / FX.gemValue
  return c.def.gem;
}
// ---------- GEM colours ----------
// Each card's GEM pays as one colour (all of its GEM). A cost with a colour requirement {color, n} needs at least
// n GEM from cards of that colour; colorless GEM only counts to the total. Data: Def.gemColor / Def.req
// (engine/data/gem_colors.json overrides the defaults), plus the text overrides below.
const SAFE = (g: Game, c: Card) => !silenced(g, c);
function bankColorless(g: Game, c: Card): boolean {
  // สภาแบงค์ (Land, v14 ruling: both players' hands) / โคลัมแบงค์ (on the field: its controller's hand): GEM of "แบงค์" Avatars becomes colorless
  if (c.def.type !== 'Avatar' || !nameHas(c, 'แบงค์')) return false;
  const pl = P(g, c.owner);
  if (!pl.hand.includes(c)) return false;
  if (landIs(g, 'สภาแบงค์')) return true;
  return pl.avatars.some((a) => a.def.name === 'โคลัมแบงค์' && SAFE(g, a));
}
export function gemColorOf(g: Game, c: Card, forCard: Card | null): GemColor {
  const n = c.def.name, fn = forCard ? forCard.def.name : '';
  if (n === 'อนันตวดี ราชินีแห่งนาค' && fn === 'อนันต์ ราชาแห่งนาค') return 'red'; // "counts as 6 red GEM"
  if (n === 'เพนกวินหิมะ เหลียง' && fn.includes('ราชินีหิมะ')) return 'blue'; // "counts as 4 blue GEM"
  if (n === 'สัตว์ทดลอง #1') return 'colorless'; // "GEM 8 colorless"
  if (/^(กุ่ย|ฮอล|นาย) หน้าตาดี$/.test(n) && /กุ่ย|ฮอล|นาย/.test(fn)) return 'colorless';
  if (n === 'ทำไมถึงเอาแต่ดูละครับ ?!' && forCard && gemOf(g, c, forCard) === 4) return 'colorless'; // "GEM 4 colorless" for Link Avatars
  if (bankColorless(g, c)) return 'colorless';
  return c.def.gemColor || 'colorless';
}
export function reqOf(g: Game, c: Card | null): { color: GemColor; n: number } | null {
  if (!c || !c.def.req || !(c.def.req.n > 0) || c.def.type === 'Magic' || c.def.type === 'Life') return null; // Magic is free
  if (c.def.name === 'โคลัมแบงค์') return null; // "any GEM colour can pay for this card"
  return c.def.req;
}
const gemIs = (gc: string, col: string) => gc === col || gc.split('/').includes(col);
// v6 colour rule (user, 2026-10-12): every card paid as GEM for a card of colour X must have GEM colour X or be
// colorless; a dual GEM ("red/blue") pays as either colour; a card with no colour (and Magic, which is free) takes
// any GEM. "#" extra colours of the paid-for card count. โคลัมแบงค์: any GEM colour may pay for it.
export function gemFits(g: Game, c: Card, forCard: Card | null): boolean {
  if (!forCard || forCard.def.type === 'Magic' || forCard.def.type === 'Life') return true;
  if (forCard.def.name === 'โคลัมแบงค์') return true;
  const need = colorsEn(forCard);
  if (!need.length) return true;
  const gc = gemColorOf(g, c, forCard);
  return gc === 'colorless' || need.some((x) => gemIs(gc, x));
}
// หมู่บ้านพอดี (Land): every payment must be exactly the cost.
// v13 ruling: only Avatar summons; GEM paid must not go over the Cost (paying exactly the Cost is the normal rule anyway).
export const exactLand = (g: Game, forCard: Card | null = null) => !!forCard && isAvatarDef(forCard.def) && !!landIs(g, 'หมู่บ้านพอดี');
// A payment is valid when every card's colour fits, it covers the cost (exactly, under หมู่บ้านพอดี) and the
// optional req colour minimum, and no card in it is unnecessary.
export function payOk(g: Game, cards: Card[], cost: number, forCard: Card | null): boolean {
  const req = reqOf(g, forCard);
  if (!cards.every((c) => gemFits(g, c, forCard))) return false;
  const gm = cards.map((c) => gemOf(g, c, forCard));
  const col = cards.map((c, i) => (req && gemIs(gemColorOf(g, c, forCard), req.color) ? gm[i] : 0));
  const sum = gm.reduce((a, b) => a + b, 0), cs = col.reduce((a, b) => a + b, 0), need = req ? req.n : 0;
  if (!cards.length || sum < cost || cs < need) return cost <= 0 && !cards.length;
  if (exactLand(g, forCard) && sum !== cost) return false;
  for (let i = 0; i < cards.length; i++) if (gm[i] <= 0 || (sum - gm[i] >= cost && cs - col[i] >= need)) return false;
  return true;
}
// linkbot item 2a: เพนกวิ้น ฮัท is paid as GEM only when no other payment works (while its once-per-game ability is unused)
function payKeep(g: Game, p: PID, c: Card): number { return c.def.name === 'เพนกวิ้น ฮัท' && !P(g, p).onceGame['เพนกวิ้น'] ? 1000 : 0; }
export function bestPayment(g: Game, p: PID, cost: number, exclude: Card[] = [], forCard: Card | null = null): Card[] | null {
  const req = reqOf(g, forCard);
  if (cost <= 0 && !req) return [];
  const gem = new Map<Card, number>();
  const hand = P(g, p).hand.filter((c) => !exclude.includes(c) && gemFits(g, c, forCard) && (gem.set(c, gemOf(g, c, forCard)), gem.get(c)! > 0));
  if (hand.reduce((s, c) => s + gem.get(c)!, 0) < cost) return null;
  const isCol = hand.map((c) => !!req && gemIs(gemColorOf(g, c, forCard), req.color));
  const exact = exactLand(g, forCard);
  const need = req ? req.n : 0;
  if (req && hand.reduce((s, c, i) => s + (isCol[i] ? gem.get(c)! : 0), 0) < need) return null;
  const n = Math.min(hand.length, 14);
  let best: Card[] | null = null, bestV = Infinity;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0, cs = 0, v = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { const gm = gem.get(hand[i])!; sum += gm; if (isCol[i]) cs += gm; v += keepValue(g, hand[i]) + payKeep(g, p, hand[i]); }
    if (sum < cost || cs < need || (exact && sum !== cost)) continue; // must cover the cost and the colour requirement
    let extra = false; // no card may be unnecessary
    for (let i = 0; i < n && !extra; i++) if (mask & (1 << i)) { const gm = gem.get(hand[i])!; if (sum - gm >= cost && cs - (isCol[i] ? gm : 0) >= need) extra = true; }
    if (extra) continue;
    if (v < bestV) { bestV = v; best = []; for (let i = 0; i < n; i++) if (mask & (1 << i)) best.push(hand[i]); }
  }
  return best;
}
// Pay event for the play table: the exact cards paid, with a readable line.
export function emitPay(g: Game, p: PID, forCard: Card, cost: number, pay: Card[]) {
  if (g.sim || !EV_HOOK) return;
  const cards = pay.map((c) => ({ uid: c.uid, print: c.def.print, name: c.def.name, gem: gemOf(g, c, forCard), gemColor: gemColorOf(g, c, forCard) }));
  const total = cards.reduce((a, c) => a + c.gem, 0);
  const s = `P${p} paid ${total} GEM for ${forCard.def.name} (cost ${cost}): ` + (cards.length ? cards.map((c) => `${c.name} (${c.gem} ${c.gemColor})`).join(' + ') : 'nothing');
  emit(g, { ev: 'pay', who: p, for: forCard.uid, forName: forCard.def.name, forPrint: forCard.def.print, cost, total, cards, s });
}

// The payment actually used: the human's pick when they are deciding, else bestPayment.
// null means it can't be paid, or the human cancelled.
export function choosePayment(g: Game, p: PID, cost: number, exclude: Card[] = [], forCard: Card | null = null): Card[] | null {
  const dflt = bestPayment(g, p, cost, exclude, forCard);
  if (!dflt || !PAY || g.sim || !dflt.length || p !== topDecider() || !humanTop()) return dflt;
  const cands = P(g, p).hand.filter((c) => !exclude.includes(c) && gemFits(g, c, forCard) && gemOf(g, c, forCard) > 0);
  if (cands.length === dflt.length) return dflt; // only one way to pay
  const r = quiet(() => PAY!(g, p, cost, cands, dflt, forCard));
  if (!r) return null;
  if (!r.every((c) => cands.includes(c)) || !payOk(g, r, cost, forCard)) return dflt;
  return r;
}

// ---------- response windows ----------
// Response chain for the play table: the events waiting on a React window, oldest first (real games only).
export const CHAIN: Ev[] = [];
export function respond(g: Game, ev: Ev) {
  if (g.sim || !BRAINS || ev.depth > 4 || g.winner !== null) return;
  { const blk = reactBlock(g, ev); if (blk === 'all') return; if (blk === 'magic') ev.noMagic = true; } // v14: FX.blockReact
  if (CHAIN.length === 0) CHAIN_LOG.length = 0;
  CHAIN.push(ev); CHAIN_LOG.push(ev);
  try { respondIn(g, ev); } finally {
    const i = CHAIN.lastIndexOf(ev); if (i >= 0) CHAIN.splice(i, 1);
    // v31: the whole chain has resolved; show which links took effect and which were negated
    if (CHAIN.length === 0 && CHAIN_LOG.length >= 2) {
      const links = CHAIN_LOG.filter((e) => e.source).map((e) => ({ uid: e.source!.uid, print: e.source!.def.print, name: e.source!.def.name, who: e.actor, kind: e.kind, depth: e.depth, negated: e.cancelled }));
      CHAIN_LOG.length = 0;
      if (links.length) emit(g, { ev: 'chainDone', who: ev.actor, links });
    }
  }
}
const CHAIN_LOG: Ev[] = []; // v31: every link of the current chain, outermost first
function respondIn(g: Game, ev: Ev) {
  const r = ev.responder ?? opp(ev.actor); // v14: windows for a given player (destroyed / left / targeted)
  const choice = BRAINS[r].respond(g, r, ev);
  if (!choice) return;
  const f = fx(choice);
  if (!f || !f.react) return;
  const pl = P(g, r);
  if (choice.def.type === 'Magic') {
    const pay = decide(g, r, () => choosePayment(g, r, choice.def.cost, [choice], choice));
    if (!pay) return;
    if (pay.length) emitPay(g, r, choice, choice.def.cost, pay);
    for (const c of pay) payCard(g, r, c, null);
    detach(g, choice);
    (pl.resolving ||= []).push(choice);
    // bugfix1 item 6 (user): อย่าให้มีครั้งที่ 2 is only free as the 2nd React; used first it takes this turn's React slot
    if (!f.react.ignoreLimit || !pl.used.React) { if (!f.react.noLimit) useMagicSlot(g, r, choice); else pl.used.React = true; } // simplify1
    if (f.react.onceKey) markOnce(g, pl, f.react.onceKey);
    log(g, `P${r} reacts with ${choice.def.name}`);
    // "when we use a Magic" abilities also see React Magic used in a response window
    for (const s of [...pl.avatars, ...pl.mz]) { const sf = fx(s); if (sf && sf.onOwnMagic && !silenced(g, s)) sf.onOwnMagic(g, s, choice); }
    magicWatch(g, choice, r); // v14: FX.onAnyMagic
    prePay(g, r, choice, (f.react as any).preCost ? () => (f.react as any).preCost(g, r, choice, ev) : null); // other-team audit Q9
    const ev2: Ev = { kind: 'magic', actor: r, source: choice, isReact: true, cancelled: false, depth: ev.depth + 1 };
    respond(g, ev2);
    try { if (!ev2.cancelled) decide(g, r, () => withSource(choice, () => f.react!.resolve(g, r, choice, ev))); } finally { prePaidDone(g, choice); }
    pl.resolving = (pl.resolving || []).filter((x) => x !== choice);
    if (!findCard(g, choice.uid)) pl.hell.push(choice);
  } else {
    // ability-based response from a card on the field (e.g. คนรวย)
    const ev2: Ev = { kind: 'ability', actor: r, source: choice, cancelled: false, depth: ev.depth + 1 };
    if (!f.react.ignoreLimit && !f.react.noLimit) pl.used.React = true;
    if (f.react.onceKey) markOnce(g, pl, f.react.onceKey);
    log(g, `P${r} responds with ability of ${choice.def.name}`);
    respond(g, ev2);
    if (!ev2.cancelled) decide(g, r, () => withSource(choice, () => f.react!.resolve(g, r, choice, ev)));
  }
}
export function canUseReact(g: Game, p: PID, c: Card, ev: Ev): boolean {
  const f = fx(c);
  if (!f || !f.react) return false;
  const pl = P(g, p);
  if (pl.used.React && !f.react.ignoreLimit && !f.react.noLimit && !extraMagicRule(g, p, c)) return false; // simplify1: RuleDef.extraMagic
  if (f.react.onceGameKey && pl.onceGame[f.react.onceGameKey]) return false;
  if (f.react.onceKey && onceUsed(g, pl, f.react.onceKey)) return false;
  const also = c.def.type === 'Magic' && !f.react.on.includes(ev.kind) && reactAlsoOk(g, p, c, ev); // v14b: FX.reactAlso
  if (!f.react.on.includes(ev.kind) && !also) return false;
  if (!also && f.react.reactOnly && !ev.isReact) return false;
  if (c.def.type === 'Magic' && (ev.noMagic || !castAllowed(g, p, c))) return false; // v14: blockReact / cast rules
  if (c.def.type !== 'Magic' && !abilityAllowed(g, p, c)) return false;
  if (!also && f.react.can && !f.react.can(g, p, c, ev)) return false;
  if (c.def.type === 'Magic') return pl.hand.includes(c) && bestPayment(g, p, c.def.cost, [c]) !== null;
  if (f.react.fromHand) return pl.hand.includes(c);
  return fieldZone(g, c) !== null && c.ctrl === p && !silenced(g, c); // v14: Avatars, attached cards, Magic Zone, Land
}

// ---------- summoning ----------
function payCard(g: Game, p: PID, c: Card, summoned: Card | null) {
  PAYING++; try { discard(g, p, c); } finally { PAYING--; } // v14b: GEM payment is not an ability discard
  if (summoned) { const f = fx(c); if (f && f.usedAsCost) withSource(c, () => f.usedAsCost!(g, p, c, summoned)); } // v14c: under withSource
}
export function uniqueBlocked(g: Game, p: PID, c: Card) {
  const f = fx(c);
  return !!(f && f.unique && P(g, p).avatars.some((a) => a.def.name === c.def.name));
}
// how: 'paid' (จุติ applies) | 'jutsu' (summoned by an effect "อัญเชิญ จุติ": จุติ applies)
//      | 'own' (summoned by its own ability) | 'effect' (by another card)
// The cost (payment) is paid first, then the card enters the field, then the opponent's summon React window,
// then its "when summoned" abilities (จุติ etc.). Those abilities triggered on entering, so they still resolve if the
// Avatar was destroyed or removed in that React window (e.g. อุบัติเหตุ!!!), unless the summon itself was negated.
export function summon(g: Game, p: PID, c: Card, how: 'paid' | 'jutsu' | 'own' | 'effect', payment: Card[] = [], cost?: number): boolean {
  const pl = P(g, p);
  if (c.def.type === 'Construct') {
    if (pl.mz.filter((x) => x.def.type === 'Construct').length >= 3) return false;
    if (payment.length) emitPay(g, p, c, cost ?? costOf(g, p, c), payment);
    detach(g, c); for (const pc of payment) payCard(g, p, pc, c); resetOnLeave(c); c.ctrl = p; pl.mz.push(c);
    log(g, `build ${c.def.name}`);
    emit(g, { ev: 'summon', who: p, uid: c.uid, print: c.def.print, how: 'build', jutsu: !!(fx(c)?.jutsu && (how === 'paid' || how === 'jutsu')) }); // v25 UI: jutsu = Advent VFX
    { // v14c: a Construct built by paying (or by an อัญเชิญ จุติ effect) runs its จุติ; FX.onEnterPlay
      const cf = fx(c);
      if (cf && cf.jutsu && (how === 'paid' || how === 'jutsu') && !abilitiesOff(g, c, 'jutsu')) abilityWindow(g, p, c, () => cf.jutsu!(g, c));
      enterPlay(g, c);
    }
    return true;
  }
  if (!canPlaceAvatar(pl, c.token, c) || uniqueBlocked(g, p, c)) return false;
  if (!summonAllowed(g, p, c, how)) { log(g, `${c.def.name} can't be summoned now (restriction)`); return false; } // v14
  if (hellLocked(c)) { log(g, `${c.def.name} can't leave the Hell`); return false; } // v14b: lockInHell
  if (c.def.noHellSummon && P(g, c.owner).hell.includes(c) && !c.f.viaScout) { log(g, `${c.def.name} can't be summoned from Hell`); return false; }
  const from0 = originZone(g, c); // v14 view: origin tag
  delete c.f.viaScout;
  const due = cost ?? costOf(g, p, c);
  // พอดี: paid with GEM exactly equal to its Cost (or summoned by an "อัญเชิญ พอดี จุติ" effect)
  const exact = (how === 'paid' && payment.reduce((a, pc) => a + gemOf(g, pc, c), 0) === due) || (how === 'jutsu' && EXACT_SUMMON > 0);
  if (payment.length) emitPay(g, p, c, due, payment);
  detach(g, c);
  for (const pc of payment) payCard(g, p, pc, null);
  resetOnLeave(c);
  c.ctrl = p;
  if (exact) c.f.exact = 1;
  noteOrigin(c, how, from0);
  pl.avatars.push(c);
  assignSlots(g); // v14 features item 8
  log(g, `summon ${c.def.name} (${how})`);
  emit(g, { ev: 'summon', who: p, uid: c.uid, print: c.def.print, how, jutsu: !!(fx(c)?.jutsu && (how === 'paid' || how === 'jutsu') && (!c.def.exactKw || c.f.exact)) }); // v25 UI: jutsu = Advent VFX
  for (const pc of payment) { const f = fx(pc); if (f && f.usedAsCost) withSource(pc, () => f.usedAsCost!(g, p, pc, c)); } // v14c: under withSource
  pl.once['summoned'] = g.turn; pl.once['summoned:' + c.def.name] = g.turn;
  turnLog(g).summons[p].push(c.def.name); // v14
  const ev: Ev = { kind: 'summon', actor: p, source: c, cancelled: false, depth: 0 };
  respond(g, ev);
  const f = fx(c);
  if (f && !ev.cancelled && g.winner === null) {
    const run = (fn: () => void) => {
      if (pl.avatars.includes(c)) { if (!silenced(g, c)) abilityWindow(g, p, c, fn); }
      else offField(g, p, c, () => abilityWindow(g, p, c, fn));
    };
    const exactOk = !c.def.exactKw || !!c.f.exact;
    if (!exactOk && f.jutsu && (how === 'paid' || how === 'jutsu')) log(g, `${c.def.name}: พอดี not met (GEM paid was not exactly its Cost), no จุติ`);
    if ((how === 'paid' || how === 'jutsu') && f.jutsu && exactOk && !abilitiesOff(g, c, 'jutsu')) run(() => f.jutsu!(g, c));
    if (how === 'own' && f.onOwnSummon) run(() => f.onOwnSummon!(g, c));
    if (f.onSummon) run(() => f.onSummon!(g, c, how));
  }
  checkPartner(g, p);
  stateCheck(g);
  return true;
}
// "อัญเชิญ พอดี จุติ": summons made inside fn count as paid exactly (พอดี abilities work).
let EXACT_SUMMON = 0;
export function summonExact<T>(fn: () => T): T { EXACT_SUMMON++; try { return fn(); } finally { EXACT_SUMMON--; } }
// Resolve a triggered ability of a card that already left the field (last known information): it acts for the player
// who summoned it, and it can't put itself back onto the field.
function offField(g: Game, p: PID, c: Card, fn: () => void) {
  const owner = P(g, c.owner);
  const home = [owner.hell, owner.exile, owner.hand, owner.deck].find((z) => z.includes(c));
  if (!home) return; // gone for good (token) or already somewhere odd
  log(g, `${c.def.name} left the field, but its ability still resolves`);
  const ctrl = c.ctrl; c.ctrl = p;
  try { fn(); } finally {
    if (c.ctrl === p && home.includes(c)) c.ctrl = ctrl;
    const onField = g.p.some((q) => q.avatars.includes(c) || q.mz.includes(c) || q.avatars.some((a) => a.mods.includes(c)));
    if (onField) { detach(g, c); resetOnLeave(c); home.push(c); log(g, `${c.def.name} stays off the field`); }
  }
}
export function placeToken(g: Game, p: PID, def: Def, n: number) {
  for (let i = 0; i < n; i++) {
    const pl = P(g, p);
    if (!canPlaceAvatar(pl, true)) return;
    const t = newCard(g, def, p, true);
    if (!summonAllowed(g, p, t, 'token')) { log(g, `${def.name} can't be summoned now (restriction)`); return; } // v14
    pl.avatars.push(t);
    assignSlots(g); // v14 features item 8
    turnLog(g).summons[p].push(def.name);
    emit(g, { ev: 'summon', who: p, uid: t.uid, print: def.print, how: 'token' });
  }
  checkPartner(g, p);
}
// An Avatar's ability on the field: opponent may answer (เชาว์ปัญญาลิง, คนรวย).
export function abilityWindow(g: Game, p: PID, c: Card, run: () => void) {
  const ev: Ev = { kind: 'ability', actor: p, source: c, cancelled: false, depth: 0 };
  respond(g, ev);
  if (ev.cancelled || silenced(g, c)) return;
  emit(g, { ev: 'ability', who: p, uid: c.uid, print: c.def.print, name: c.def.name }); // v25 UI: the card zooms to the middle
  decide(g, p, () => withSource(c, run));
}
export function checkPartner(g: Game, p: PID) {
  const pl = P(g, p);
  // v14 features item 2: คู่หู is formed only by the Link action (linkPair), not on entry
  const on = pl.avatars.some((a) => a.def.name === 'หนุมาน วานรวายุ' && pl.avatars.some((b) => b.def.name === 'นิลพัท วานรสีกาฬ' && linkActive(a, b)));
  if (on && !pl.partner) {
    pl.partner = true;
    for (const a of [...pl.avatars]) { const f = fx(a); if (f && f.onPartner && !silenced(g, a)) f.onPartner(g, a); }
    const a0 = pl.avatars.find((a) => a.def.name === 'นิลพัท วานรสีกาฬ');
    if (a0) respond(g, { kind: 'partner', actor: p, source: a0, cancelled: false, depth: 0 }); // v14 window
  } else if (!on) pl.partner = false;
  linkCheck(g, p); // v14: generic [Link X]: FX.onLink + 'partner' window
}

// ---------- magic ----------
// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): FX.preCost / FX.react.preCost pay the
// "cost :" part of a Magic before its React window; the card's resolve asks textCost() whether that was paid (and pays
// itself when no pre-payment happened, e.g. in a bot simulation on a cloned game).
const PREPAID = new WeakMap<Game, Map<number, boolean>>();
export function textCost(g: Game, c: Card, pay: () => boolean): boolean {
  const m = PREPAID.get(g);
  if (m && m.has(c.uid)) { const r = m.get(c.uid)!; m.delete(c.uid); return r; }
  return !!pay();
}
function prePay(g: Game, p: PID, c: Card, run: (() => boolean) | null) {
  if (!run) return;
  let m = PREPAID.get(g); if (!m) PREPAID.set(g, (m = new Map()));
  m.set(c.uid, !!decide(g, p, () => withSource(c, run)));
}
function prePaidDone(g: Game, c: Card) { PREPAID.get(g)?.delete(c.uid); }
export function castMagic(g: Game, p: PID, c: Card, opt: number): boolean {
  const f = fx(c);
  const pl = P(g, p);
  const kind = c.def.subtype as MagicKind;
  if (!f || !magicSlotFree(g, p, c) || !castAllowed(g, p, c)) return false; // v14: cast rules; simplify1: RuleDef.extraMagic
  if (f.canCast && !quiet(() => f.canCast!(g, p, c, opt)) && !humanLand(g, p, c)) return false;
  const cost = costOf(g, p, c);
  const pay = choosePayment(g, p, cost, [c], c);
  if (!pay) return false;
  if (pay.length) emitPay(g, p, c, cost, pay);
  for (const pc of pay) payCard(g, p, pc, null);
  detach(g, c);
  useMagicSlot(g, p, c); // = pl.used[kind] = true (simplify1: or uses up an extra-Magic rule)
  (pl.resolving ||= []).push(c);
  try { return castBody(g, p, c, opt, f, pl, kind); } finally { pl.resolving = pl.resolving!.filter((x) => x !== c); }
}
function castBody(g: Game, p: PID, c: Card, opt: number, f: any, pl: Player, kind: MagicKind): boolean {
  for (const s of [...pl.avatars, ...pl.mz]) { const sf = fx(s); if (sf && sf.onOwnMagic && !silenced(g, s)) sf.onOwnMagic(g, s, c); }
  magicWatch(g, c, p); // v14: FX.onAnyMagic
  log(g, `cast ${c.def.name}${opt ? ' opt' + opt : ''}`);
  prePay(g, p, c, f.preCost ? () => f.preCost(g, p, c, opt) : null); // other-team audit Q9
  const ev: Ev = { kind: 'magic', actor: p, source: c, isReact: kind === 'React', cancelled: false, depth: 0 };
  respond(g, ev);
  // simplify1: FX.onCastToHell(g, self): this Magic went to Hell straight from its cast (cancelled, or a Modification
  // with no legal wearer left); a resolved Normal Magic is reported too
  const castToHell = () => { pl.hell.push(c); const hf = fx(c); if (hf && hf.onCastToHell && pl.hell.includes(c)) decide(g, p, () => withSource(c, () => hf.onCastToHell!(g, c))); };
  if (ev.cancelled) { prePaidDone(g, c); castToHell(); return true; }
  try { castResolve(g, p, c, opt, f, pl, kind, castToHell); } finally { prePaidDone(g, c); } // other-team audit Q9
  stateCheck(g);
  return true;
}
function castResolve(g: Game, p: PID, c: Card, opt: number, f: any, pl: Player, kind: MagicKind, castToHell: () => void) {
  if (kind === 'Land') {
    placeLand(g, p, c);
  } else if (kind === 'Modification') {
    const w = f.modTarget ? f.modTarget(g, p, c) : null;
    if (w && findCard(g, w.uid) && canWear(g, c, w)) { c.wearer = w.uid; w.mods.push(c); // v14d: canWear
      if (f.onAttach) f.onAttach(g, c, w); } else castToHell();
  } else {
    if (f.resolve) withSource(c, () => f.resolve!(g, p, c, opt));
    if (!findCard(g, c.uid)) { if (f.stayMz) { pl.mz.push(c); enterPlay(g, c); } else castToHell(); } // v14c: FX.onEnterPlay
  }
}

// ---------- state-based checks ----------
export function stateCheck(g: Game) {
  let again = true, guard = 0;
  landCheck(g);
  while (again && guard++ < 10 && g.winner === null) {
    again = false;
    for (const pl of g.p) for (const a of [...pl.avatars]) {
      if (power(g, a) > 0) continue;
      const landKills = lands(g).some((l) => fx(l)?.zeroKills);
      const modKills = a.mods.some((m) => fx(m)?.zeroKills);
      const selfKills = !!fx(a)?.zeroKills && !silenced(g, a); // v14c: an Avatar's own zeroKills
      if (landKills || modKills || selfKills) { if (destroy(g, a, null)) again = true; }
    }
  }
  zoneTrim(g); // v14c: more than 4 (6) real Avatars
  assignSlots(g); // v14 features item 8: fixed Avatar Zone slots
  restWatch(g); // v14d: FX.onRest / onRestChange
  lifeDownWatch(g); // v14d: FX.blockLifeDown
  actionWatch(g); // v14c: FX.afterAction
}

// ---------- legal main-phase actions ----------
export function mainActs(g: Game, p: PID): Act[] {
  const pl = P(g, p);
  const acts: Act[] = [];
  for (const c of pl.hand) {
    const f = fx(c);
    if (c.def.type === 'Construct') {
      if (pl.mz.filter((x) => x.def.type === 'Construct' && x.def.name === c.def.name).length < (c.def.czMax || 1) && bestPayment(g, p, costOf(g, p, c), [c], c) !== null) acts.push({ k: 'summon', uid: c.uid, opt: 0, label: `build ${c.def.name}` });
    } else if (isAvatarDef(c.def)) {
      if (canPlaceAvatar(pl, false, c) && !(f && f.noHandSummon) && !uniqueBlocked(g, p, c) && summonAllowed(g, p, c, 'paid') && bestPayment(g, p, costOf(g, p, c), [c], c) !== null) acts.push({ k: 'summon', uid: c.uid, opt: 0, label: `summon ${c.def.name}` });
      if (f && f.handActs && abilityAllowed(g, p, c)) f.handActs(g, p, c).forEach((a, i) => { if (a.can(g)) acts.push({ k: 'hand', uid: c.uid, opt: i, label: a.label }); });
    } else if (c.def.type === 'Magic') {
      const kind = c.def.subtype as MagicKind;
      if (!magicSlotFree(g, p, c) || !f || !castAllowed(g, p, c)) continue;
      if (kind === 'React' && !(f.mainUse)) continue;
      if (kind === 'Land' && lands(g).some((l) => fx(l)?.lockLand)) continue;
      if (bestPayment(g, p, costOf(g, p, c), [c], c) === null) continue;
      const n = f.options || 1;
      for (let o = 0; o < n; o++) if (!f.canCast || f.canCast(g, p, c, o) || humanLand(g, p, c)) acts.push({ k: 'cast', uid: c.uid, opt: o, label: `cast ${c.def.name} ${o}` });
    }
  }
  const fieldCards: Card[] = [...pl.avatars];
  for (const a of pl.avatars) fieldCards.push(...a.mods.filter((m) => m.owner === p));
  if (g.land) fieldCards.push(g.land); // bugfix2 item 7 (user): the shared Land's abilities can be used by both players
  fieldCards.push(...pl.mz);
  for (const c of fieldCards) {
    const f = fx(c);
    if (c.def.exactKw && isAvatarDef(c.def) && !c.f.exact) continue; // พอดี abilities need an exact payment
    if (f && f.fieldActs && !silenced(g, c) && abilityAllowed(g, p, c)) f.fieldActs(g, p, c).forEach((a, i) => { if (withOnceCard(c, true, () => a.can(g)) && !(c.f['neg:' + i] === g.turn && actOnce(c, i))) acts.push({ k: 'field', uid: c.uid, opt: i, label: a.label }); });
  }
  acts.push(...linkActs(g, p)); // v14 features item 2: Link action
  const seen = new Set<string>();
  for (const c of pl.hell) {
    const f = fx(c);
    if (!f || !f.hellActs || seen.has(c.def.name) || !abilityAllowed(g, p, c) || hellLocked(c)) continue;
    seen.add(c.def.name);
    f.hellActs(g, p, c).forEach((a, i) => { if (a.can(g)) acts.push({ k: 'hell', uid: c.uid, opt: i, label: a.label }); });
  }
  for (const c of pl.exile) {
    const f = fx(c);
    if (f && f.exileActs && abilityAllowed(g, p, c)) f.exileActs(g, p, c).forEach((a, i) => { if (a.can(g)) acts.push({ k: 'exile', uid: c.uid, opt: i, label: a.label }); });
  }
  const seenD = new Set<string>(); // bugfix3 (จอมมาร BT12-001): "สั่งใช้ จาก Deck", one entry per name
  for (const c of pl.deck) {
    const f = fx(c);
    if (!f || !f.deckActs || seenD.has(c.def.name) || !abilityAllowed(g, p, c)) continue;
    seenD.add(c.def.name);
    f.deckActs(g, p, c).forEach((a, i) => { if (a.can(g)) acts.push({ k: 'deck', uid: c.uid, opt: i, label: a.label }); });
  }
  return acts;
}
/** bugs7 item 6: every usable ability of every card in p's Hell ('hell') or Dark dimension ('exile'), one Act per card and
 *  ability (copies with the same name too, so the human picks WHICH card; mainActs keeps one per name for the bot). */
export function pileActs(g: Game, p: PID, k: 'hell' | 'exile'): Act[] {
  const out: Act[] = [];
  for (const c of k === 'hell' ? P(g, p).hell : P(g, p).exile) {
    const f = fx(c);
    const list = f && (k === 'hell' ? f.hellActs : f.exileActs);
    if (!list || !abilityAllowed(g, p, c) || (k === 'hell' && hellLocked(c))) continue;
    list(g, p, c).forEach((a, i) => { if (a.can(g)) out.push({ k, uid: c.uid, opt: i, label: a.label }); });
  }
  return out;
}
export function doAct(g: Game, p: PID, a: Act): boolean {
  const r = doActBody(g, p, a);
  if (r && !g.sim && p === g.active) offTurnWindow(g, 'act'); // v14b
  return r;
}
function doActBody(g: Game, p: PID, a: Act): boolean {
  const c = findCard(g, a.uid);
  if (!c) return false;
  if (a.k === 'summon') {
    if (c.def.type !== 'Construct' && (!canPlaceAvatar(P(g, p), false, c) || !summonAllowed(g, p, c, 'paid'))) return false;
    const cost = costOf(g, p, c);
    const pay = choosePayment(g, p, cost, [c], c);
    if (!pay) return false;
    return summon(g, p, c, 'paid', pay, cost);
  }
  if (a.k === 'cast') return castMagic(g, p, c, a.opt);
  if (a.k === 'link') { const b = findCard(g, a.opt); return !!b && linkPair(g, p, c, b); } // v14 features item 2
  if (!abilityAllowed(g, p, c)) return false; // v14: ability rules (โรงบาล)
  const f = fx(c);
  const list = a.k === 'hand' ? f.handActs!(g, p, c) : a.k === 'hell' ? f.hellActs!(g, p, c) : a.k === 'exile' ? f.exileActs!(g, p, c) : a.k === 'deck' ? f.deckActs!(g, p, c) : f.fieldActs!(g, p, c);
  const x = list[a.opt];
  if (a.k === 'field') return withOnceCard(c, false, () => runAct(g, p, a, c, x));
  return runAct(g, p, a, c, x);
}
function runAct(g: Game, p: PID, a: Act, c: Card, x: HandAct): boolean {
  if (!(a.k === 'field' ? withOnceCard(c, true, () => quiet(() => x.can(g))) : quiet(() => x.can(g)))) return false;
  log(g, x.label);
  // v13 (สั่งใช้ ruling): an Activate ability of a card in play opens the opponent's React window before it resolves
  if (a.k === 'field' && !g.sim) {
    const ev: Ev = { kind: 'ability', actor: p, source: c, cancelled: false, depth: 0 };
    respond(g, ev);
    if (g.winner !== null) return true;
    if (ev.cancelled || (isAvatarDef(c.def) && silenced(g, c))) {
      log(g, `${c.def.name}: the ability is negated; its cost stays paid`);
      decide(g, p, () => withSource(c, () => payActCost(g, p, c, a.opt)));
      c.f['neg:' + a.opt] = g.turn;
      stateCheck(g);
      return true;
    }
  }
  emit(g, { ev: 'ability', who: p, uid: c.uid, print: c.def.print, name: c.def.name }); // v25 UI: the card zooms to the middle
  withSource(c, () => x.run(g));
  stateCheck(g);
  return true;
}
// The opt-th "สั่งใช้" sentence of a card's text (abilities used from hand / Hell / the dark dimension are skipped).
function actSentence(c: Card, opt: number): { cost: string; once: boolean } {
  const t = cardText(c).replace(/\s+/g, ' ');
  const at: number[] = [];
  for (let i = t.indexOf('สั่งใช้'); i >= 0; i = t.indexOf('สั่งใช้', i + 1)) if (!/^\s*จาก(บนมือ|มือ|นรก|มิติมืด)/.test(t.slice(i + 7, i + 20))) at.push(i);
  if (!at.length) return { cost: '', once: false };
  const i = at[Math.min(opt, at.length - 1)];
  const rest = t.slice(i + 7), colon = rest.indexOf(':');
  return { cost: colon >= 0 && colon < 200 ? rest.slice(0, colon) : '', once: t.slice(Math.max(0, i - 24), i).includes('เทิร์นละครั้ง') };
}
const actOnce = (c: Card, opt: number) => actSentence(c, opt).once;
/** Pay the cost written in an Activate ability's text (before its ":"), for an ability that was negated. */
export function payActCost(g: Game, p: PID, c: Card, opt: number) {
  const cost = actSentence(c, opt).cost, pl = P(g, p);
  if (!cost) return;
  const num = (m: RegExpMatchArray | null) => (m && m[1] ? Number(m[1]) : 1);
  const disc = cost.match(/ทิ้งการ์ด\s*(?:บนมือ|จากบนมือ|ในมือ|จากมือ)?\s*(\d+)\s*ใบ/);
  if (disc) for (const x of worstN(pl.hand.filter((y) => y !== c), num(disc), (y) => keepValue(g, y), { title: `${c.def.name}: discard (cost)` })) discard(g, p, x);
  const ban = cost.match(/เนรเทศ\s*การ์ด\s*(?:ใน|จาก)\s*นรก[^:]*?(\d+)\s*ใบ/);
  if (ban) for (const x of worstN(pl.hell, num(ban), (y) => keepValue(g, y), { title: `${c.def.name}: banish from นรก (cost)` })) { detach(g, x); pl.exile.push(x); }
  if (/เซ่นไหว้\s*(?:Avatar|การ์ด)?\s*ใบนี้/.test(cost)) { if (pl.avatars.includes(c)) destroy(g, c, p, false, { cost: true }); }
  else if (cost.includes('เซ่นไหว้')) {
    const n = num(cost.match(/เซ่นไหว้[^:]*?(\d+)\s*ใบ/));
    for (const x of worstN(pl.avatars.filter((y) => y !== c), n, (y) => value(g, y), { title: `${c.def.name}: เซ่นไหว้ (cost)` })) destroy(g, x, p, false, { cost: true });
  }
  if (/ส่ง\s*(?:Avatar|การ์ด)\s*ใบนี้[^:]*ลงนรก/.test(cost) && findCard(g, c.uid) && !P(g, c.owner).hell.includes(c)) toHell(g, c, { cost: true });
  if (/เปลี่ยน[^:]*ใบนี้[^:]*สภาพนอน/.test(cost)) c.asleep = true;
}

// ---------- battle ----------
export function legalTargets(g: Game, p: PID, att: Card): (Card | null)[] {
  const o = P(g, opp(p));
  let av = o.avatars.filter((a) => { const f = fx(a); return !(f && f.untargetable && !contOff(g, a) && f.untargetable(g, a, att)) && !attackShielded(g, a, att); }); // v14d: FX.noAttackOn
  const taunt = av.filter((a) => { const f = fx(a); return f && f.taunt && !contOff(g, a) && f.taunt(g, a); });
  if (taunt.length) av = taunt;
  const t: (Card | null)[] = [...av];
  if (!taunt.length) t.push(...constructTargets(g, p, att)); // v14: Constructs a card in play makes attackable (FX.canBeAttacked)
  // An Avatar with 0 POWER can't declare an attack on the opponent's LIFE.
  // เตะไข่ (an ability keyword: lost to text deletion; a granted เตะไข่ is lost only to a full deletion)
  // v14c ruling (แบงค์ ตัวแดง): when the opponent has Avatars but none can be chosen by this attacker, LIFE can be attacked
  // v14 features: Constructs are extra targets; they never block LIFE (LIFE is open when no Avatar can be chosen)
  if ((o.avatars.length === 0 || hasKw(g, att, 'kick') || av.length === 0) && power(g, att) > 0 && !lifeBlocked(g, att)) t.push(null); // v14: FX.noLifeAttack
  return t;
}
export function canAttack(g: Game, p: PID, c: Card) {
  if (g.turn === 1) return false; // first player can't attack on the first turn
  if (c.f.noAttack === g.turn) return false;
  return P(g, p).avatars.includes(c) && !c.asleep;
}
// Declare and resolve one attack. unite: own awake Avatars with สามัคคี to add to the attacker.
// v14: currentFight() tells the fight being resolved; the target may be a Construct (legalTargets).
export function attack(g: Game, p: PID, att: Card, target: Card | null, unite: Card[] = []) {
  if (!canAttack(g, p, att)) return;
  const fi = { att, target };
  FIGHTS.push(fi);
  try { attackBody(g, p, att, target, unite, fi); } finally { const i = FIGHTS.lastIndexOf(fi); if (i >= 0) FIGHTS.splice(i, 1); }
  if (!g.sim && g.active === p) offTurnWindow(g, 'attack'); // v14b
}
function attackBody(g: Game, p: PID, att: Card, target: Card | null, unite: Card[], fi: { att: Card; target: Card | null }) {
  const o = opp(p);
  att.asleep = true;
  const pendStab = takeBuffs(g, p, att); // v14 features item 9: buffs given in the Battle Phase before this attack
  g.stats.attacks++;
  turnLog(g).attacks[p]++;
  log(g, `${att.def.name} attacks ${target ? target.def.name : 'LIFE'}`);
  emit(g, { ev: 'attack', who: p, from: att.uid, to: target ? target.uid : 'life' });
  // กระแสสิริมงคล: after it was used this turn, each further attack declared by the opponent draws its user 1 card
  if (P(g, o).once['drawOnAttack'] === g.turn) { log(g, `P${o} draws 1 (กระแสสิริมงคล: another attack)`); draw(g, o, 1); if (g.winner !== null) return; }
  for (const m of att.mods) { const mf = fx(m); if (mf && mf.onWearerAttack) mf.onWearerAttack(g, m, att); }
  const declared = target;
  const ev: Ev = { kind: 'attack', actor: p, source: att, target, cancelled: false, depth: 0 };
  respond(g, ev);
  if (ev.cancelled || g.winner !== null) { endBattleTemps(g); return; }
  if (!P(g, p).avatars.includes(att)) { endBattleTemps(g); return; }
  target = ev.target === undefined ? target : ev.target;
  fi.target = target;
  // "ฝ่ายตรงข้ามจะต้องใช้ความสามารถ โล่มนุษย์ เสมอ" (ลิโป้): the defender must redirect with a โล่มนุษย์ Avatar when it has one
  if (target === declared && fx(att)?.forceShield && !silenced(g, att)) {
    const sh = shieldOptions(g, o, ev);
    const s0 = sh.length ? decide(g, o, () => askPick(sh, sh.reduce((m, x) => (power(g, x) < power(g, m) ? x : m)), { title: `${att.def.name}: you must use โล่มนุษย์: choose the Avatar that takes the attack` })) : null;
    if (s0) { useShield(g, ev, s0); target = s0; fi.target = target; }
  }
  if (target && !onFieldOf(g, o, target)) { endBattleTemps(g); stateCheck(g); return; }
  // "when this attacks / is attacked" triggers
  { const f = fx(att); if (f && f.onAttack && !silenced(g, att)) decide(g, att.ctrl, () => withSource(att, () => f.onAttack!(g, att, target))); } // v14c: under withSource
  if (target) { const f = fx(target); if (f && f.onTargeted && !silenced(g, target)) decide(g, target.ctrl, () => f.onTargeted!(g, target, att)); }
  for (const l of lands(g)) { const lf = fx(l); if (lf && lf.landAttack) lf.landAttack(g, l, att); } // Land: "Avatar that attacks gets ..."
  if (g.winner !== null || !P(g, p).avatars.includes(att)) { endBattleTemps(g); stateCheck(g); return; }
  if (target && !onFieldOf(g, o, target)) { endBattleTemps(g); stateCheck(g); return; }
  const stabbers: Card[] = [...pendStab];
  for (const u of unite) {
    if (u === att || u.asleep || !P(g, p).avatars.includes(u)) continue;
    if (hasKw(g, u, 'unite')) {
      const amt = power(g, u);
      u.asleep = true; att.temp.push({ power: amt, until: 'battle' });
      emit(g, { ev: 'assist', kind: 'unity', who: p, from: u.uid, to: att.uid, amount: amt, s: `${u.def.name} สามัคคี: ${att.def.name} POWER +${amt}` });
      const f = fx(att); if (f && f.onUnited) f.onUnited(g, att, u);
      assistUsed(g, u, att, 'unity');
    } else if (hasKw(g, u, 'backstab')) {
      // แทงหลัง (user ruling 2026-10-12): rest this card, the attacker gets this card's POWER + 1 until the end of this fight
      const amt = power(g, u) + 1;
      u.asleep = true; att.temp.push({ power: amt, until: 'battle' }); stabbers.push(u);
      log(g, `${u.def.name} แทงหลัง: ${att.def.name} POWER +${amt}`);
      emit(g, { ev: 'assist', kind: 'backstab', who: p, from: u.uid, to: att.uid, amount: amt, s: `${u.def.name} แทงหลัง: ${att.def.name} POWER +${amt}` });
      const uf = fx(u); if (uf && uf.onBackstab && !silenced(g, u)) decide(g, p, () => uf.onBackstab!(g, u, att));
      assistUsed(g, u, att, 'backstab');
    }
  }
  if (target === null && power(g, att) <= 0) {
    // linkbot item 4: POWER 0 (or less) at damage time (e.g. after ไปเลยมอนตี้ in the attack window): no damage, no LIFE flips
    log(g, `${att.def.name} has POWER ${power(g, att)}: the attack on LIFE deals no damage`);
  } else if (target === null) {
    hitLife(g, o, att);
    if (g.winner === null) respond(g, { kind: 'lifeHit', actor: p, source: att, target: null, cancelled: false, depth: 0 }); // v14 window
  } else {
    // bugfix1 item 10 (user): worn cards' fight effects first (มีมมิ นักเรียนดีเด่น turns the foe purple), then the fighters'
    // own (เซอร์นัท ดาบแห่งแสงอรุณ +3 vs purple sees it)
    const pairs = [[att, target], [target, att]] as [Card, Card][];
    for (const [a, b] of pairs) for (const m of a.mods) { const mf = fx(m); if (mf && mf.wearerBattle) decide(g, a.ctrl, () => mf.wearerBattle!(g, m, a, b)); }
    for (const [a, b] of pairs) { const f = fx(a); if (f && f.battle && !silenced(g, a)) decide(g, a.ctrl, () => f.battle!(g, a, b)); }
    // React windows during the fight: defender first, then attacker
    const e1: Ev = { kind: 'fight', actor: p, source: att, target, cancelled: false, depth: 0 };
    respond(g, e1);
    const e2: Ev = { kind: 'fight', actor: o, source: target, target: att, cancelled: false, depth: 0 };
    respond(g, e2);
    if (P(g, p).avatars.includes(att) && onFieldOf(g, o, target)) {
      emit(g, { ev: 'hit', who: o, kind: target.def.type === 'Construct' ? 'construct' : 'avatar', uid: target.uid, by: att.uid });
      const pa = power(g, att), pt = power(g, target);
      const tieAtt = hasKw(g, att, 'tieWin'), tieDef = hasKw(g, target, 'tieWin');
      FIGHT++;
      try {
        if (pa > pt || (pa === pt && tieAtt && !tieDef)) killed(g, att, target, p);
        else if (pt > pa || (pa === pt && tieDef && !tieAtt)) killed(g, target, att, o);
        else { destroy(g, target, p); destroy(g, att, o); }
      } finally { FIGHT--; }
    }
  }
  // แทงหลัง: at the end of the fight, an attacker of a different colour from the helper is destroyed
  for (const u of stabbers) {
    if (!P(g, p).avatars.includes(att)) break;
    const ca = colorsEn(att), cu = colorsEn(u);
    if (!ca.some((x) => cu.includes(x))) {
      log(g, `แทงหลัง: ${att.def.name} is not the colour of ${u.def.name} and is destroyed`);
      emit(g, { ev: 'backstab_kill', who: p, uid: att.uid, by: u.uid, s: `แทงหลัง: ${att.def.name} is destroyed (colour differs from ${u.def.name})` });
      destroy(g, att, p); break;
    }
  }
  endBattleTemps(g);
  if (g.winner === null) fightWatch(g, att, target); // v14: FX.afterFight
  stateCheck(g);
}
// "Avatar ... ได้รับ / helper used สามัคคี / แทงหลัง" triggers of every card in play (ซัลลี่วอดก้า, เซนเซไฮ).
function assistUsed(g: Game, u: Card, att: Card, kind: 'unity' | 'backstab') {
  for (const s of kwSources(g)) { const sf = fx(s); if (sf && sf.onAssistUsed && !silenced(g, s)) decide(g, s.ctrl, () => sf.onAssistUsed!(g, s, u, att, kind)); }
}
// > 0 while a fight's result is being applied (destroy() then knows the destruction is "from battle")
let FIGHT = 0;
function killed(g: Game, winner: Card, loser: Card, by: PID) {
  const lp = loser.def.power, lpow = power(g, loser);
  if (!destroy(g, loser, by)) return;
  if (!P(g, winner.ctrl).avatars.includes(winner)) return;
  // granted "เมื่อ Avatar ใบนี้ทำลาย Avatar ฝ่ายตรงข้ามจากการต่อสู้: หงาย LIFE Card ใบบนสุดของฝ่ายตรงข้าม 1 ใบ" (เซนเซไฮ), until end of turn
  if ((winner.f.gFlipOnKill || 0) >= g.turn && !fullSilenced(g, winner)) {
    const q = opp(winner.ctrl), l = P(g, q).life.find((x) => !x.faceUp);
    if (l) { l.faceUp = true; log(g, `${winner.def.name}: flips P${q}'s top LIFE card (granted by เซนเซไฮ)`); scanLife(g, q); }
  }
  const f = fx(winner);
  if (f && f.onKill && !silenced(g, winner)) decide(g, winner.ctrl, () => f.onKill!(g, winner, loser, lpow, lp));
  for (const m of [...winner.mods]) { const mf = fx(m); if (mf && mf.onWearerKill) decide(g, winner.ctrl, () => mf.onWearerKill!(g, m, winner, lpow, lp)); }
}
function endBattleTemps(g: Game) {
  for (const pl of g.p) for (const a of pl.avatars) {
    a.temp = a.temp.filter((t) => t.until !== 'battle');
    for (const k of Object.keys(a.f)) if (k.startsWith('kwb:')) delete a.f[k]; // keywords granted "until the end of that fight"
  }
}

// ---------- turn structure ----------
export function playTurn(g: Game) {
  const p = g.active;
  const pl = P(g, p);
  for (const q of g.p) { q.used = { Normal: false, Modification: false, React: false, Land: false }; }
  // Draw Phase: wake own Avatars, draw 1 (first player skips the first draw), refill to 3.
  enterPhase(g, 'Draw');
  g.stopBattle = false;
  for (const a of pl.avatars) if (a.noWakeUntil < g.turn) a.asleep = false;
  const dpSkip = drawPhaseStart(g, p); // v14b: Draw Phase count, Hell returns, FX.drawInstead
  if (!(g.turn === 1) && pl.once['noDraw'] !== g.turn && !dpSkip) draw(g, p, 1);
  if (g.turn === 1 && g.firstDraw2) draw(g, p, 2);
  if (pl.hand.length < 3 && pl.once['noDraw'] !== g.turn) draw(g, p, 3 - pl.hand.length);
  for (const s of [...pl.avatars, ...pl.mz.filter((x) => !isLand(x))]) { const f = fx(s); if (f && f.drawPhase) f.drawPhase(g, s); }
  ctrlBackAfterDraw(g, p); // simplify1: "control ... until the end of its owner's next Draw Phase" (ctrlUntilOwnerDraw)
  if (g.winner !== null) return;
  // Main Phase
  enterPhase(g, 'Main');
  for (const c of pl.returnAtMain.splice(0)) {
    if (pl.exile.includes(c) && canPlaceAvatar(pl) && dimReturnOk(g, p, c)) { detach(g, c); resetOnLeave(c); pl.avatars.push(c); turnLog(g).summons[p].push(c.def.name); log(g, `${c.def.name} returns from exile`); } // other-team audit Q8
  }
  checkPartner(g, p);
  lifeTriggers(g, p, 'main'); // LIFE cards flipped since our last Main Phase
  if (g.winner !== null) return;
  phaseWatch(g, 'mainStart'); if (g.winner !== null) return; // v14c: FX.mainStart (every card in play, Lands too, both players)
  for (const a of [...pl.avatars, ...pl.mz.filter((x) => !isLand(x))]) { const f = fx(a); if (f && f.startMain && (pl.avatars.includes(a) || pl.mz.includes(a)) && !silenced(g, a)) abilityWindow(g, p, a, () => f.startMain!(g, a)); if (g.winner !== null) return; }
  stateCheck(g);
  BRAINS![p].main(g, p);
  if (g.winner !== null) return;
  offTurnWindow(g, 'mainEnd'); // v14b
  if (g.winner !== null) return;
  const ob = BRAINS![opp(p)];
  if (ob.oppMain) ob.oppMain(g, opp(p));
  if (g.winner !== null) return;
  // Battle Phase
  enterPhase(g, 'Battle');
  if (g.turn > 1) { lifeTriggers(g, p, 'battle'); if (g.winner !== null) return; }
  if (g.turn > 1) { phaseWatch(g, 'startBattle'); stateCheck(g); if (g.winner !== null) return; } // v14: FX.startBattle
  // v13: React window at the start of the Battle Phase, before the first attack (พระคุ้มครอง), when an attack is possible
  if (g.turn > 1 && (!BRAINS![p].wantsBattle || BRAINS![p].wantsBattle(g, p) || attackDuty(g, p).length > 0) && pl.avatars.some((a) => canAttack(g, p, a))) {
    respond(g, { kind: 'battleStart', actor: p, source: null, cancelled: false, depth: 0 });
    if (g.winner !== null) return;
  }
  if (g.turn > 1) { offTurnWindow(g, 'battleStart'); if (g.winner !== null) return; } // v14b
  if (g.turn > 1) BRAINS![p].battle(g, p);
  if (g.winner !== null) return;
  if (g.turn > 1) { enforceDuty(g, p); if (g.winner !== null) return; } // v14: forced attacks the brain did not make
  // End Phase
  enterPhase(g, 'End');
  const endHand = new Set(pl.hand.map((c) => c.uid)); // v14 features item 5: cards added during the End Phase are exempt
  respond(g, { kind: 'endTurn', actor: p, source: null, cancelled: false, depth: 0 }); // v14 window: about to end the turn
  if (g.winner !== null) return;
  offTurnWindow(g, 'endTurn'); // v14b
  if (g.winner !== null) return;
  for (const a of [...pl.avatars, ...pl.mz.filter((x) => !isLand(x))]) { const f = fx(a); if (f && f.endPhase && (pl.avatars.includes(a) || pl.mz.includes(a)) && !silenced(g, a)) f.endPhase(g, a); }
  for (const land of lands(g)) { const lf = fx(land); if (lf && lf.endPhase) decide(g, land.owner, () => lf.endPhase!(g, land)); }
  phaseWatch(g, 'eachEndPhase'); // v14: FX.eachEndPhase (both players' cards, every End Phase)
  if (g.winner !== null) return;
  for (const q of g.p) for (const a of [...q.avatars]) if (a.f.endDestroy === g.turn) destroy(g, a, null, a.f.endDestroyM === g.turn); // other-team audit: ความกล้าหาญ = by a Magic (แกลลาติน)
  for (const q of g.p) for (const a of [...q.avatars]) if (a.f.endHell === g.turn) toHell(g, a);
  for (const q of g.p) for (const a of [...q.avatars]) if (a.f.returnCtrl === g.turn) { detach(g, a); a.ctrl = a.owner; P(g, a.owner).avatars.push(a); }
  for (const a of [...pl.avatars]) if (a.fumaExile) { toExile(g, a); pl.returnAtMain.push(a); }
  for (const q of g.p) for (const c of q.returnAtEnd.splice(0)) {
    if (q.exile.includes(c) && canPlaceAvatar(q) && dimReturnOk(g, q.id, c)) { detach(g, c); resetOnLeave(c); q.avatars.push(c); turnLog(g).summons[q.id].push(c.def.name); } // other-team audit Q8
  }
  for (const q of g.p) for (const a of [...q.avatars, ...q.mz]) { a.temp = a.temp.filter((t) => typeof t.until === 'number' && t.until > g.turn); a.kick = false; } // v14c: numeric until = a turn number
  handLimit(g, p, endHand); // v14 features item 5: discard down to 7
  if (g.winner !== null) return;
  clearBuffs(g); // v14 features item 9: unused buffs expire
  for (const q of [0, 1] as PID[]) scanLife(g, q); // register LIFE flipped by effects this turn
  checkPartner(g, p);
  stateCheck(g);
  g.turn++;
  g.active = opp(p);
}

export function playGame(g: Game, maxTurns = 80): PID | -1 {
  while (g.winner === null && g.turn <= maxTurns) withDecider(g.active, () => playTurn(g));
  if (g.winner === null) g.winner = -1;
  return g.winner;
}

// Clone for look-ahead (bot). Brains are module-level so state stays plain data.
export function cloneSim(g: Game): Game {
  const log = g.log; g.log = null;
  const c = structuredClone(g);
  g.log = log;
  c.sim = true;
  registerGame(c);
  return c;
}

// =====================================================================================================================
// ---------- v14 engine hooks ("core-rules"). Card workers: engine/v14-hooks.md lists every hook with an example. ----------
// =====================================================================================================================
import type { TurnLog, Rule, Temp } from './types.ts';
import { gameOf } from './view.ts';

/** g.rules entries with this `until` last for the rest of the game. */
export const RULE_GAME = 1e9;
/** This turn's log (summons, attacks, Avatars lost / destroyed by battle or effect, mills); reset when the turn changes. */
export function turnLog(g: Game): TurnLog {
  if (!g.tl || g.tl.turn !== g.turn) {
    g.tl = { turn: g.turn, summons: [[], []], attacks: [0, 0], left: [0, 0], destroyed: [0, 0], destroyedBattle: [0, 0], destroyedEffect: [0, 0], milled: [0, 0], millBy: [0, 0] };
  }
  return g.tl;
}

// ---------- where a card is ----------
export type FieldZone = 'avatars' | 'mz' | 'mod' | 'land';
/** The field zone of c (Avatar Zone, Magic Zone incl. Constructs / extra Lands, attached to an Avatar, the Land slot) or null. */
export function fieldZone(g: Game, c: Card): FieldZone | null {
  for (const q of g.p) {
    if (q.avatars.includes(c)) return 'avatars';
    if (q.mz.includes(c)) return 'mz';
    for (const a of q.avatars) if (a.mods.includes(c)) return 'mod';
  }
  return g.land === c ? 'land' : null;
}
const onFieldOf = (g: Game, p: PID, c: Card) => P(g, p).avatars.includes(c) || P(g, p).mz.includes(c);

// ---------- hook lookup (names of FX entries that define a hook; cached) ----------
let HOOKS: Record<string, Set<string>> | null = null;
function withHook(h: string): Set<string> {
  if (!HOOKS) HOOKS = {};
  let s = HOOKS[h];
  if (!s) { s = new Set(Object.keys(FX).filter((k) => !!FX[k] && !!(FX[k] as any)[h])); HOOKS[h] = s; }
  return s;
}
/** Call after adding / changing FX entries at run time (unit tests). newGame() calls it. */
export function refreshHooks() { HOOKS = null; LINKS.clear(); CP_CACHE.clear(); }
const hookOn = (s: Set<string>, c: Card) => s.size > 0 && (s.has(c.def.name) || s.has(c.def.print) || (!!c.f && !!(c.f as any)['cp:name'] && s.has(copiedFrom(c) || ''))); // v14b: copies
/** Cards in play (kwSources) whose FX defines hook h and whose text is on (contOff: continuous text). */
function hookSources(g: Game, h: string, contCheck = true): Card[] {
  const names = withHook(h);
  if (!names.size) return [];
  return kwSources(g).filter((s) => hookOn(names, s) && !(contCheck && contOff(g, s)));
}
/** Cards in both hands and both Hells whose FX defines hook h. */
function zoneWatchers(g: Game, h: string, skip: Card[] = []): Card[] {
  const names = withHook(h);
  if (!names.size) return [];
  const out: Card[] = [];
  for (const q of g.p) for (const c of [...q.hand, ...q.hell]) if (hookOn(names, c) && !skip.includes(c)) out.push(c);
  return out;
}

// ---------- 9. ability loss / immunity / targeting ----------
/** Parts of a card's text an FX.textOff hook can switch off: 'ability' = normal text deletion (✓ abilities, จุติ, keywords),
 *  or single parts. textOff returning true = everything (ลูกฮึด, ต่อเนื่อง, คำสั่งเสีย too). */
export type AbilityPart = 'ability' | 'jutsu' | 'deathCry' | 'cont' | 'grit' | 'kw';
let TXT_BUSY = 0, UNAFF_BUSY = 0;
function textOffBy(g: Game, c: Card, part: AbilityPart | 'all'): boolean {
  if (TXT_BUSY) return false;
  const names = withHook('textOff');
  if (!names.size) return false;
  let hit = false;
  TXT_BUSY++;
  try {
    const test = (s: Card) => {
      if (hit || !hookOn(names, s)) return;
      const r = fx(s).textOff!(g, s, c);
      if (r === true) hit = true;
      else if (part !== 'all' && Array.isArray(r) && (r.includes(part) || (r.includes('ability') && (part === 'jutsu' || part === 'kw')))) hit = true;
    };
    for (const q of g.p) {
      for (const a of q.avatars) { test(a); for (const m of a.mods) test(m); }
      for (const s of q.mz) if (!s.f.faceDown) test(s);
    }
    if (g.land) test(g.land);
  } finally { TXT_BUSY--; }
  return hit;
}
/** FX.unaffected: the card is not affected by any effect at all (แบงค์ Miner): it can't be removed by effects (fights still
 *  destroy it), its POWER ignores temporary changes and other cards' auras / Lands, its text can't be deleted, no keyword
 *  is granted or denied to it, and other cards' effects can't choose it. */
export function unaffected(g: Game, c: Card, src?: Card | null): boolean {
  if (UNAFF_BUSY) return false;
  const f = fx(c);
  if (!f || !f.unaffected) return false;
  UNAFF_BUSY++;
  try { return !!f.unaffected(g, c, src ?? undefined); } finally { UNAFF_BUSY--; } // v14d: src = the effect's card (optional)
}
/** Is this part of c's text switched off right now? Every rules check goes through here (silenced = 'ability',
 *  contOff = 'cont', fullSilenced = everything). Sources: text deletion this turn (silencedTurn / fullSil) and FX.textOff
 *  of cards in play (Overdose "#"). An unaffected card never loses its text. */
export function abilitiesOff(g: Game, c: Card, part: AbilityPart = 'ability'): boolean {
  if (unaffected(g, c)) return false;
  const base = c.silencedTurn === g.turn, full = base && c.f.fullSil === g.turn;
  if (part === 'cont') { if (base && (!c.def.cont || full)) return true; }
  else if (part === 'deathCry') { if (full) return true; } // คำสั่งเสีย survives normal deletion
  else if (part === 'grit') { if (full || (base && !(c.def.grit || c.def.cont))) return true; }
  else if (base) return true;
  if (ownTextOff(g, c, part)) return true; // simplify1: timed text loss stored on the card (loseText)
  return textOffBy(g, c, part);
}
/** "Can't be chosen" checks for effects: false when c (a card in play) may not be picked by src's effect: c is unaffected,
 *  or a card in play says so (FX.noTarget(g, self, target, by)). Untargeted ("all") effects still hit. */
export function effectTargetable(c: Card, src: Card | null = currentSource()): boolean {
  if (!src || !c || c === src || !(c as any).def) return true;
  if (!withHook('noTarget').size && !withHook('unaffected').size && !withHook('shieldFrom').size) return true;
  const g = gameOf(c);
  if (!g || !fieldZone(g, c)) return true;
  if (unaffectedBy(g, c, src)) return false; // v14d: per source
  for (const s of hookSources(g, 'noTarget')) if (fx(s).noTarget!(g, s, c, src)) return false;
  return true;
}
/** best() / pickN() / oppTargets() drop cards that can't be chosen by the current effect. */
export function targetFilter<T>(xs: T[]): T[] {
  if (!SRC.length || (!ANY_LOCK && !withHook('noTarget').size && !withHook('unaffected').size && !withHook('shieldFrom').size)) return xs;
  return xs.filter((x: any) => !x || typeof x.uid !== 'number' || (!(ANY_LOCK && hellLocked(x)) && effectTargetable(x))); // v14b: lockInHell
}
// "targeted" React window: every pick of a card in play by an effect (askPick) opens it for that card's controller.
let TW_BUSY = 0;
function targetWindow(r: any): any {
  const g = LIVE, src = SRC[SRC.length - 1];
  if (!g || g.sim || !src || !r || r === src || typeof r.uid !== 'number' || !r.def || TW_BUSY || !BRAINS || g.winner !== null) return r;
  if (!fieldZone(g, r)) return r;
  const ev: Ev = { kind: 'targeted', actor: src.ctrl, source: src, target: r, cancelled: false, depth: 0, responder: r.ctrl };
  TW_BUSY++;
  try { respond(g, ev); } finally { TW_BUSY--; }
  if (ev.cancelled) { log(g, `${src.def.name}: choosing ${r.def.name} was cancelled`); return null; }
  if (ev.target && ev.target !== r) { log(g, `${src.def.name}: the target changes to ${ev.target.def.name}`); return ev.target; }
  return r;
}

// ---------- 1 + 2. leaving the field ----------
/** How a card leaves the field: destroy = "ถูกทำลาย" (destroy()); hell = sent to Hell without destroying; hand; exile; deck. */
export type LeaveHow = 'destroy' | 'hell' | 'hand' | 'exile' | 'deck';
export interface LeaveInfo {
  how: LeaveHow;
  by: PID | null; // player whose card / attack caused it (null = rules, e.g. POWER 0)
  src: Card | null; // card whose ability caused it (null for a fight or a rule)
  battle: boolean; // destroyed as the result of a fight (the loser of a battle; Magic lowering POWER first still counts)
  viaMagic: boolean; // caused by a Magic card
  cost: boolean; // paid as a cost (เซ่นไหว้ / ส่งลงนรก as cost): guards don't apply
  zone: FieldZone; // where it was
  owner: PID; ctrl: PID; // controller when it left
  wearer: Card | null; // for an attached card: its Avatar
  textOff: boolean; // its abilities were off when it left (its own afterLeave does not run)
  noDeathCry: boolean; // destroy: its คำสั่งเสีย did not run (text off, or FX.blockDeathCry)
  power: number; // POWER when it left
  to?: 'hell' | 'hand' | 'exile' | 'deck' | 'gone'; // where it went (set before the after-leave triggers; gone = token)
}
export interface LeaveOpts { by?: PID | null; src?: Card | null; viaMagic?: boolean; cost?: boolean; battle?: boolean; noGuard?: boolean }
/** What FX.leaveGuard returns when it can keep a card on the field. optional (default true): the guard's controller is
 *  asked "use it?" (the bot answers want, default true). run() does the replacement (roll a die, discard a card, destroy
 *  the attached card...) and returns true when the card stays. */
export interface LeaveGuard { label?: string; optional?: boolean; want?: boolean; run(): boolean }
function leaveInfo(g: Game, c: Card, how: LeaveHow, o: LeaveOpts, zone: FieldZone): LeaveInfo {
  const src = o.src !== undefined ? o.src : currentSource();
  const by = o.by !== undefined ? o.by : (src ? src.ctrl : null);
  let wearer: Card | null = null;
  if (zone === 'mod') for (const q of g.p) for (const a of q.avatars) if (a.mods.includes(c)) wearer = a;
  const fight = how === 'destroy' && FIGHT > 0;
  return {
    how, by, src: fight && o.src === undefined ? null : src, battle: o.battle ?? fight, viaMagic: !!o.viaMagic || (!!src && src.def.type === 'Magic' && !fight),
    cost: !!o.cost, zone, owner: c.owner, ctrl: c.ctrl, wearer, textOff: silenced(g, c), noDeathCry: false,
    power: zone === 'avatars' || c.def.type === 'Construct' ? power(g, c) : 0,
  };
}
function askYesNo(g: Game, c: Card, title: string, want: boolean): boolean {
  if (!humanDeciding(g)) return want;
  return askPick0([c], want ? c : null, { optional: true, title }) !== null;
}
const GUARDING = new Set<number>();
let LEAVE_DEPTH = 0;
/** Leave-field protection: true = c stays on the field. Order: unaffected, preventLeave (opponent's non-destroy removals),
 *  then FX.leaveGuard of c itself, its attached cards, every other card in play, then both hands (จิวท่าย). Costs are never
 *  stopped. destroy() runs its older hooks (preventLeave, saveFromHand, protectWearer, protectSelf, the destroy React
 *  window) first. Control changes don't call this. */
export function leaveGuarded(g: Game, c: Card, info: LeaveInfo): boolean {
  if (info.cost || GUARDING.has(c.uid)) return false;
  if (!info.battle && info.src !== c && (info.src ? unaffectedBy(g, c, info.src) : unaffected(g, c))) { // v14d: per source
    log(g, `${c.def.name} is unaffected by effects: it stays on the field`); return true; }
  GUARDING.add(c.uid);
  try {
    if (carriedGuard(g, c, info)) return true; // v14c: c.f['lg:<FX name>']
    if (info.how !== 'destroy' && info.by !== null && info.by !== c.ctrl) {
      const f = fx(c);
      if (f && f.preventLeave && !silenced(g, c) && decide(g, c.ctrl, () => f.preventLeave!(g, c))) return true;
    }
    const names = withHook('leaveGuard');
    if (!names.size) return false;
    const pool: Card[] = [c, ...c.mods];
    for (const s of kwSources(g)) if (!pool.includes(s)) pool.push(s);
    pool.push(...P(g, c.ctrl).hand, ...P(g, opp(c.ctrl)).hand);
    for (const s of pool) {
      if (!hookOn(names, s)) continue;
      if (fieldZone(g, s) && silenced(g, s)) continue;
      const sf = fx(s);
      const gd = decide(g, s.ctrl, () => withSource(s, () => sf.leaveGuard!(g, s, c, info)));
      if (!gd) continue;
      const use = gd.optional === false || decide(g, s.ctrl, () => askYesNo(g, s, `${s.def.name}: ${gd.label || `keep ${c.def.name} on the field`}?`, gd.want !== false));
      if (!use) continue;
      const kept = decide(g, s.ctrl, () => withSource(s, () => gd.run()));
      if (!fieldZone(g, c)) return true; // the guard moved it itself
      if (kept) {
        log(g, `${s.def.name}: ${c.def.name} stays on the field`);
        emit(g, { ev: 'protect', who: c.ctrl, uid: c.uid, by: s.uid, s: `${s.def.name}: ${c.def.name} stays on the field` });
        return true;
      }
    }
  } finally { GUARDING.delete(c.uid); }
  return false;
}
/** Move c off the field (or between other zones): guards first when c is in play, then put(), then the after-leave triggers. */
function leaveTo(g: Game, c: Card, how: LeaveHow, o: LeaveOpts, put: () => void): boolean {
  const zone = fieldZone(g, c);
  let info: LeaveInfo | null = null;
  if (zone) {
    info = leaveInfo(g, c, how, o, zone);
    if (!o.noGuard && LEAVE_DEPTH < 12 && leaveGuarded(g, c, info)) return false;
    if (!fieldZone(g, c)) return false;
  }
  detach(g, c); dropMods(g, c); resetOnLeave(c);
  if (!c.token) put();
  if (info) afterLeft(g, c, info);
  return true;
}
function deathCryBlocked(g: Game, c: Card, info: LeaveInfo): boolean {
  for (const s of hookSources(g, 'blockDeathCry')) if (s !== c && fx(s).blockDeathCry!(g, s, c, info)) return true;
  return false;
}
/** After c left the field (already in its new zone): turn log, c's own FX.afterLeave, FX.onAnyLeave / onAnyDestroyed of
 *  cards in play, in hands and in Hells, then the 'destroyed' (destroy) or 'left' (other ways) React windows: first for
 *  c's controller, then for the other player. */
function afterLeft(g: Game, c: Card, info: LeaveInfo) {
  const home = P(g, c.owner);
  info.to = home.hell.includes(c) ? 'hell' : home.hand.includes(c) || P(g, opp(c.owner)).hand.includes(c) ? 'hand' : home.exile.includes(c) ? 'exile' : home.deck.includes(c) ? 'deck' : 'gone';
  const isAv = info.zone === 'avatars' && isAvatarDef(c.def);
  if (isAv) {
    const t = turnLog(g);
    t.left[info.ctrl]++;
    if (info.how === 'destroy') { t.destroyed[info.ctrl]++; if (info.battle) t.destroyedBattle[info.ctrl]++; else t.destroyedEffect[info.ctrl]++; }
  }
  if (LEAVE_DEPTH >= 12) return;
  LEAVE_DEPTH++;
  try {
    const self = fx(c);
    if (self && self.afterLeave && !info.textOff && !c.token) decide(g, c.owner, () => withSource(c, () => self.afterLeave!(g, c, info)));
    const dHook = info.how === 'destroy' ? 'onAnyDestroyed' : '';
    for (const h of ['onAnyLeave', dHook]) {
      if (!h || g.winner !== null) continue;
      const pool = [...hookSources(g, h, false).filter((s) => !silenced(g, s)), ...zoneWatchers(g, h)].filter((s) => s !== c);
      for (const s of pool) {
        const sf: any = fx(s);
        if (fieldZone(g, s) || g.p.some((q) => q.hand.includes(s) || q.hell.includes(s))) decide(g, s.ctrl, () => withSource(s, () => sf[h](g, s, c, info)));
      }
    }
    if ((isAv || (info.zone === 'mz' && c.def.type === 'Construct')) && !g.sim && g.winner === null) {
      const actor = info.by !== null ? info.by : opp(info.ctrl);
      for (const r of [info.ctrl, opp(info.ctrl)] as PID[]) {
        if (g.winner !== null) break;
        respond(g, { kind: info.how === 'destroy' ? 'destroyed' : 'left', actor, source: c, cancelled: false, depth: 0, responder: r, leave: info });
      }
    }
  } finally { LEAVE_DEPTH--; }
}
/** Put a card in play into its owner's Deck: 'top', 'bottom' or 'shuffle' (guards and after-leave triggers like toHell). */
export function toDeck(g: Game, c: Card, where: 'top' | 'bottom' | 'shuffle' = 'shuffle', o: LeaveOpts = {}): boolean {
  return leaveTo(g, c, 'deck', o, () => {
    const d = P(g, c.owner).deck;
    if (where === 'top') d.unshift(c); else d.push(c);
    if (where === 'shuffle') shuffle(g, d);
  });
}

// ---------- 3. response windows: suppression ----------
/** FX.blockReact of cards in play: 'all' = no window, 'magic' (or true) = no React Magic in this window. */
function reactBlock(g: Game, ev: Ev): 'all' | 'magic' | null {
  let out: 'magic' | null = null;
  for (const s of hookSources(g, 'blockReact', false)) {
    if (silenced(g, s)) continue;
    const r = fx(s).blockReact!(g, s, ev);
    if (r === 'all') return 'all';
    if (r) out = 'magic';
  }
  return out;
}
/** The fight being resolved (attacker and target; target null = LIFE), or null outside attack(). */
const FIGHTS: { att: Card; target: Card | null }[] = [];
export function currentFight(): { att: Card; target: Card | null } | null { return FIGHTS.length ? FIGHTS[FIGHTS.length - 1] : null; }
/** Every card that can answer a React window for p: hand, Avatars, attached cards p controls, Magic Zone, p's Land. */
export function reactCands(g: Game, p: PID): Card[] {
  const pl = P(g, p), out: Card[] = [...pl.hand, ...pl.avatars];
  for (const a of pl.avatars) for (const m of a.mods) if (m.ctrl === p) out.push(m);
  for (const q of g.p) for (const a of q.avatars) if (q.id !== p) for (const m of a.mods) if (m.ctrl === p) out.push(m);
  out.push(...pl.mz);
  if (g.land && g.land.ctrl === p) out.push(g.land);
  return out;
}

// ---------- 4. forced attacks ----------
/** Avatars of p that must attack now: FX.mustAttack(g, self, a) of a card in play names Avatar a (a can attack and has a
 *  target), or FX.mustAttackOnce(g, self, p) holds and p has not attacked this turn (then any one attack satisfies it).
 *  While this list is not empty, p can't end the turn (the engine forces the attack if a brain stops early). */
export function attackDuty(g: Game, p: PID): Card[] {
  if (g.turn === 1 || g.winner !== null || g.stopBattle) return [];
  const must = withHook('mustAttack'), once = withHook('mustAttackOnce');
  if (!must.size && !once.size) return [];
  const can = P(g, p).avatars.filter((a) => canAttack(g, p, a) && legalTargets(g, p, a).length > 0);
  if (!can.length) return [];
  const out = new Set<Card>();
  for (const s of kwSources(g)) {
    if (contOff(g, s)) continue;
    const sf = fx(s);
    if (hookOn(must, s)) for (const a of can) if (sf.mustAttack!(g, s, a)) out.add(a);
    if (hookOn(once, s) && turnLog(g).attacks[p] === 0 && sf.mustAttackOnce!(g, s, p)) for (const a of can) out.add(a);
  }
  return [...out];
}
/** Why p must attack (card names), for the screen. */
export function dutyReason(g: Game, p: PID): string {
  const ns = new Set<string>();
  for (const s of kwSources(g)) {
    if (contOff(g, s)) continue;
    const sf = fx(s);
    if ((sf?.mustAttack && P(g, p).avatars.some((a) => sf.mustAttack!(g, s, a))) || (sf?.mustAttackOnce && sf.mustAttackOnce(g, s, p))) ns.add(s.def.name);
  }
  return [...ns].join(', ');
}
/** Safety net after the brain's Battle Phase: make the remaining forced attacks (heuristic targets). */
function enforceDuty(g: Game, p: PID) {
  for (let i = 0; i < 8 && g.winner === null && !g.stopBattle; i++) {
    const d = attackDuty(g, p);
    if (!d.length) return;
    const att = d.reduce((m, x) => (power(g, x) > power(g, m) ? x : m));
    const ts = legalTargets(g, p, att);
    let t: Card | null = ts.includes(null) ? null : (ts[0] as Card);
    if (!ts.includes(null)) {
      let bv = -Infinity;
      for (const x of ts as Card[]) { const v = power(g, att) > power(g, x) ? value(g, x) : -value(g, x); if (v > bv) { bv = v; t = x; } }
    }
    log(g, `${att.def.name} must attack (${dutyReason(g, p)})`);
    attack(g, p, att, t);
  }
}

// ---------- 5. Constructs as attack targets ----------
// v14 features item 1 (user 2026-10-17): every Construct of the opponent can be attacked (general rule). A Construct's own
// canBeAttacked hook is now its verdict (false = can't be chosen: ยิมทมิฬ with วอเตอร์แมน, หอสมุดจอมเวทย์ with a จอมเวทย์);
// FX.noAttackOn and its own untargetable still apply. Hooks of other cards that return true are no longer needed (harmless).
function constructTargets(g: Game, p: PID, att: Card): Card[] {
  const cons = P(g, opp(p)).mz.filter((x) => x.def.type === 'Construct' && !x.f.faceDown);
  if (!cons.length) return [];
  return cons.filter((x) => {
    const f = fx(x);
    if (f && f.canBeAttacked && !contOff(g, x) && !f.canBeAttacked(g, x, x, att)) return false;
    if (f && f.untargetable && !contOff(g, x) && f.untargetable(g, x, att)) return false;
    return !attackShielded(g, x, att);
  });
}
/** v14 features: t is a Construct (attack target that never hits LIFE; it fights with its POWER). */
export const isConstruct = (c: Card | null | undefined) => !!c && c.def.type === 'Construct';
function lifeBlocked(g: Game, att: Card): boolean {
  return hookSources(g, 'noLifeAttack').some((s) => fx(s).noLifeAttack!(g, s, att));
}

// ---------- 6. mill / scout ----------
export interface MillInfo { owner: PID; cards: Card[]; by: PID | null; src: Card | null; duringMagic: boolean; byVirus: boolean }
function millBlocked(g: Game, kind: 'mill' | 'scout', owner: PID, by: PID | null, src: Card | null): boolean {
  return hookSources(g, 'blockMill').some((s) => fx(s).blockMill!(g, s, kind, owner, by, src));
}
function bonusOf(g: Game, h: 'millBonus' | 'scoutBonus', owner: PID, n: number, by: PID | null, src: Card | null): number {
  let k = 0;
  for (const s of hookSources(g, h)) k += (fx(s) as any)[h](g, s, owner, n, by, src) || 0;
  return k;
}
function millWatch(g: Game, info: MillInfo) {
  const pool = [...hookSources(g, 'onMill', false).filter((s) => !silenced(g, s)), ...zoneWatchers(g, 'onMill', info.cards)];
  for (const s of pool) if (g.winner === null) decide(g, s.ctrl, () => withSource(s, () => fx(s).onMill!(g, s, info.owner, info.cards, info.by, info.src, info)));
}

// ---------- 7. summon / cast / ability restrictions ----------
export type SummonHow = 'paid' | 'jutsu' | 'own' | 'effect' | 'token';
/** Predicates of timed rules (g.rules). A card file registers its rule: RULES['เพื่อลูกค้า'] = { summon: (g, r, c) => symIs(c, 'สัตว์') }
 *  and adds it with addRule(g, { p, key: 'เพื่อลูกค้า', until: g.turn }). summon / cast / ability: true = allowed;
 *  zoneCap: max Avatars in p's Avatar Zone. */
export interface RuleDef {
  summon?(g: Game, r: Rule, c: Card, how: SummonHow): boolean;
  cast?(g: Game, r: Rule, c: Card): boolean;
  ability?(g: Game, r: Rule, c: Card): boolean;
  zoneCap?(g: Game, r: Rule): number;
  pay?(g: Game, r: Rule, payCard: Card, forCard: Card): boolean; // v14c: false = payCard (r.p's) can't be paid as GEM for forCard
  startBattle?(g: Game, r: Rule): void; // v14c: delayed triggers: start of every Battle Phase while the rule lives
  endPhase?(g: Game, r: Rule): void; // v14c: every End Phase while the rule lives
  extraMagic?(g: Game, r: Rule, m: Card): boolean; // simplify1: r.p may use Magic m although its subtype was used this turn (r.n = how many, default 1)
  magic?(g: Game, r: Rule, m: Card, caster: PID): void; // simplify1: delayed watcher: any player used a Magic while the rule lives
  label?: string;
}
// RULES lives in cards.ts (evaluated before the card files, which register rules at load time)
import { RULES } from './cards.ts';
export { RULES };
/** Add a restriction for player r.p until the end of turn r.until (g.turn = this turn, RULE_GAME = the whole game). */
export function addRule(g: Game, r: Rule) { (g.rules ||= []).push(r); log(g, `P${r.p}: ${RULES[r.key]?.label || r.key} (${r.until >= RULE_GAME ? 'this game' : r.until === g.turn ? 'this turn' : 'until turn ' + r.until})`); }
export function rulesOf(g: Game, p: PID): Rule[] {
  if (!g.rules || !g.rules.length) return [];
  if (g.rules.some((r) => r.until < g.turn)) g.rules = g.rules.filter((r) => r.until >= g.turn);
  return g.rules.filter((r) => r.p === p);
}
/** May p summon Avatar c now (how)? FX.summonIf of c itself ("#only by its own ability"), p's rules, FX.blockSummon of cards in play. */
/** other-team audit Q8 (user: coming back from the Dark Dimension counts as อัญเชิญ): summon limits (FX.blockSummon, e.g.
 *  ด่านตรวจเข้าเมือง) also hold for an Avatar returning from exile; it stays there when blocked. */
export function dimReturnOk(g: Game, p: PID, c: Card): boolean {
  for (const s of hookSources(g, 'blockSummon')) if (fx(s).blockSummon!(g, s, p, c, 'effect')) { log(g, `${c.def.name} can't come back from the Dark Dimension (summon limit)`); return false; }
  return true;
}
export function summonAllowed(g: Game, p: PID, c: Card, how: SummonHow): boolean {
  const f = fx(c);
  if (f && f.summonIf && !f.summonIf(g, p, c, how)) return false;
  for (const r of rulesOf(g, p)) { const d = RULES[r.key]; if (d && d.summon && !d.summon(g, r, c, how)) return false; }
  for (const s of hookSources(g, 'blockSummon')) if (fx(s).blockSummon!(g, s, p, c, how)) return false;
  return true;
}
/** May p use Magic card c now? p's rules (cast) and FX.blockCast of cards in play. */
export function castAllowed(g: Game, p: PID, c: Card): boolean {
  for (const r of rulesOf(g, p)) { const d = RULES[r.key]; if (d && d.cast && !d.cast(g, r, c)) return false; }
  for (const s of hookSources(g, 'blockCast')) if (fx(s).blockCast!(g, s, p, c)) return false;
  return true;
}
/** May p use the activated abilities (สั่งใช้) of card c now? p's rules (ability) and FX.blockAbility of cards in play. */
export function abilityAllowed(g: Game, p: PID, c: Card): boolean {
  for (const r of rulesOf(g, p)) { const d = RULES[r.key]; if (d && d.ability && !d.ability(g, r, c)) return false; }
  for (const s of hookSources(g, 'blockAbility')) if (fx(s).blockAbility!(g, s, p, c)) return false;
  return true;
}
/** Max Avatars (tokens included) p may have in the Avatar Zone (6 = the normal limit; นรกในกรง: 3). */
export function zoneCap(g: Game, p: PID): number {
  let cap = 6;
  for (const r of rulesOf(g, p)) { const d = RULES[r.key]; if (d && d.zoneCap) cap = Math.min(cap, d.zoneCap(g, r)); }
  for (const s of hookSources(g, 'zoneCap')) { const n = fx(s).zoneCap!(g, s, p); if (typeof n === 'number') cap = Math.min(cap, n); }
  return cap;
}

// ---------- 10. small extras ----------
/** Flip p's top face-down LIFE card by an effect (it is registered at once: FX.onLifeFlipped watchers run). */
export function flipLifeCard(g: Game, p: PID, byAttack = false): Card | null {
  const pl = P(g, p), i = pl.life.findIndex((l) => !l.faceUp);
  if (i < 0) return null;
  pl.life[i].faceUp = true;
  log(g, `P${p} LIFE flipped by an effect (${flippedLife(pl)}/5)`);
  noteLifeFlip(g, p, i, byAttack);
  return pl.life[i].card;
}
function lifeWatch(g: Game, p: PID, c: Card, byAttack: boolean) {
  for (const s of hookSources(g, 'onLifeFlipped', false)) if (!silenced(g, s) && g.winner === null) decide(g, s.ctrl, () => withSource(s, () => fx(s).onLifeFlipped!(g, s, p, c, byAttack)));
}
/** FX.onAnyMagic of cards in play: any player used a Magic (cast, or React). */
function magicWatch(g: Game, magic: Card, caster: PID) {
  for (const s of hookSources(g, 'onAnyMagic', false)) if (!silenced(g, s)) decide(g, s.ctrl, () => withSource(s, () => fx(s).onAnyMagic!(g, s, magic, caster)));
  for (const r of [...(g.rules || [])]) { const d = RULES[r.key]; if (d && d.magic && r.until >= g.turn && g.winner === null) decide(g, r.p, () => d.magic!(g, r, magic, caster)); } // simplify1: RuleDef.magic
}
/** Run hook h (startBattle / eachEndPhase) of every card in play, both players. */
function phaseWatch(g: Game, h: 'startBattle' | 'eachEndPhase' | 'mainStart') {
  for (const s of hookSources(g, h, false)) {
    if (g.winner !== null) return;
    if (!silenced(g, s) && fieldZone(g, s)) decide(g, s.ctrl, () => withSource(s, () => (fx(s) as any)[h](g, s)));
  }
  // v14c: live timed rules with RuleDef.startBattle / endPhase (both players)
  if (h === 'mainStart') return;
  const rk = h === 'startBattle' ? 'startBattle' : 'endPhase';
  for (const p of [0, 1] as PID[]) for (const r of rulesOf(g, p)) { const d = RULES[r.key]; if (d && d[rk] && g.winner === null) decide(g, p, () => d[rk]!(g, r)); }
}
/** FX.afterFight of every card in play once a fight (or an attack on LIFE: target null) is over. */
function fightWatch(g: Game, att: Card, target: Card | null) {
  for (const s of hookSources(g, 'afterFight', false)) {
    if (g.winner !== null) return;
    if (!silenced(g, s) && fieldZone(g, s)) decide(g, s.ctrl, () => withSource(s, () => fx(s).afterFight!(g, s, att, target)));
  }
}
// ---------- [Link X] (generic) ----------
const LINKS = new Map<string, string[]>();
/** Names in the card's "[Link X]" text. */
export function linkNames(c: Card): string[] {
  let r = LINKS.get(c.def.name);
  if (!r) { r = []; for (const m of cardText(c).matchAll(/\[\s*Link\s+([^\]]+?)\s*\]/gi)) r.push(m[1]); LINKS.set(c.def.name, r); }
  return r;
}
/** c is in [Link] state: c and its Link partner (either card's "[Link X]") are both on the same Avatar Zone. */
// v14 features item 2: the state starts only when the player uses the Link action on the pair (linkPair); both cards
// remember each other (c.f.linkWith = partner uid, cleared when a card leaves the field).
export function inLink(g: Game, c: Card): boolean {
  const zone = g.p.find((q) => q.avatars.includes(c));
  if (!zone || !c.f.linkWith) return false;
  const o = zone.avatars.find((x) => x.uid === c.f.linkWith);
  return !!o && linkActive(c, o) && pairMatch(c, o);
}
function linkCheck(g: Game, p: PID) {
  for (const a of [...P(g, p).avatars]) {
    const now = inLink(g, a);
    if (now && !a.f.linkOn) {
      a.f.linkOn = 1;
      const f = fx(a);
      if (f && f.onLink && !silenced(g, a)) decide(g, p, () => withSource(a, () => f.onLink!(g, a)));
      if (P(g, p).avatars.includes(a)) respond(g, { kind: 'partner', actor: p, source: a, cancelled: false, depth: 0 });
    } else if (!now && a.f.linkOn) delete a.f.linkOn;
  }
}

// =================== v14b cross-card hooks (see engine/v14-hooks.md "v14b") ===================
import { addNote } from './view.ts';

// ---------- v14b-5: discard watcher (FX.onDiscard) ----------
type DiscardRec = { g: Game; cards: Card[]; by: PID; src: Card; depth: number };
const DISCARDS: DiscardRec[] = [];
let PAYING = 0;
/** discard(): was c in a hand, discarded by an ability (not paid as GEM), with a watcher defined somewhere? */
function discardWatched(g: Game, c: Card): boolean {
  return SRC.length > 0 && !PAYING && withHook('onDiscard').size > 0 && g.p.some((q) => q.hand.includes(c));
}
function noteDiscard(g: Game, c: Card) {
  const src = SRC[SRC.length - 1], depth = SRC.length, last = DISCARDS[DISCARDS.length - 1];
  if (last && last.g === g && last.src === src && last.depth === depth) last.cards.push(c);
  else DISCARDS.push({ g, cards: [c], by: src.ctrl, src, depth });
}
/** Runs when an ability (withSource) finishes: discards it made are reported to FX.onDiscard of cards in play,
 *  in both hands and in both Hells (after the discarding ability has fully resolved). */
function flushDiscards() {
  while (DISCARDS.length && DISCARDS[DISCARDS.length - 1].depth > SRC.length) {
    const r = DISCARDS.pop()!, g = r.g;
    if (g.winner !== null) continue;
    const field = hookSources(g, 'onDiscard');
    const zones = zoneWatchers(g, 'onDiscard').filter((w) => abilityAllowed(g, w.owner, w));
    for (const w of [...field, ...zones]) {
      if (g.winner !== null) break;
      const inField = field.includes(w);
      if (inField ? !fieldZone(g, w) : !g.p.some((q) => q.hand.includes(w) || q.hell.includes(w))) continue; // moved meanwhile
      const who = inField ? w.ctrl : w.owner;
      decide(g, who, () => withSource(w, () => fx(w).onDiscard!(g, w, r.cards, r.by, r.src)));
    }
    stateCheck(g);
  }
}

// ---------- v14b-4: Draw Phase (FX.drawInstead for cards in the deck; numbered Draw Phases) ----------
/** How many Draw Phases p has had so far, the current one included (turn 1 of the first player counts as 1). */
export function drawPhaseNo(g: Game, p: PID): number { return P(g, p).once['dp#'] || 0; }
/** Start of p's Draw Phase (playTurn). Returns true when the normal draw of 1 is replaced. */
function drawPhaseStart(g: Game, p: PID): boolean {
  const pl = P(g, p);
  const n = pl.once['dp#'] = (pl.once['dp#'] || 0) + 1;
  // cards locked in a Hell that come back at this Draw Phase (lockInHell)
  for (const q of g.p) for (const c of [...q.hell]) if ('dpRetP' in c.f && c.f.dpRetP === p && c.f.dpRet === n) {
    unlockHell(c);
    addToHand(g, c, p, { from: 'hell', by: p, src: null });
    log(g, `${c.def.name} returns from Hell to P${p}'s hand`);
  }
  if (g.turn === 1 || pl.once['noDraw'] === g.turn) return false;
  const names = withHook('drawInstead');
  if (!names.size) return false;
  const seen = new Set<string>();
  for (const s of kwSources(g)) { // v14d: cards in play controlled by p (the hook does the replacement itself)
    if (s.ctrl !== p || !hookOn(names, s) || silenced(g, s)) continue;
    if (decide(g, p, () => withSource(s, () => !!fx(s).drawInstead!(g, s)))) { log(g, `${s.def.name}: replaces P${p}'s draw`); return true; }
  }
  for (const c of [...pl.deck]) {
    if (!hookOn(names, c) || seen.has(c.def.name) || !pl.deck.includes(c)) continue;
    seen.add(c.def.name);
    if (!abilityAllowed(g, p, c)) continue;
    if (decide(g, p, () => withSource(c, () => !!fx(c).drawInstead!(g, c)))) { log(g, `P${p} takes ${c.def.name} instead of the draw`); return true; }
  }
  return false;
}

// ---------- v14b-2: added to hand (FX.onToHand) ----------
export type HandFrom = 'deck' | 'hell' | 'field' | 'exile' | 'life' | 'other';
export interface HandOpts { from?: HandFrom; by?: PID | null; src?: Card | null }
function handZoneOf(g: Game, c: Card): HandFrom | 'hand' {
  if (fieldZone(g, c)) return 'field';
  for (const q of g.p) {
    if (q.hand.includes(c)) return 'hand';
    if (q.deck.includes(c)) return 'deck';
    if (q.hell.includes(c)) return 'hell';
    if (q.exile.includes(c)) return 'exile';
    if (q.life.some((l) => l.card === c)) return 'life';
  }
  return 'other';
}
/** Put c into p's hand ("นำขึ้นมือ") from wherever it is, then run its FX.onToHand. A card on the field goes through
 *  toHand() (leave guards, after-leave triggers). A card locked in Hell (lockInHell) stays: returns false.
 *  o.by / o.src default to the current source (the card whose ability does it) and its controller. */
export function addToHand(g: Game, c: Card, p: PID = c.owner, o: HandOpts = {}): boolean {
  const at = handZoneOf(g, c);
  if (at === 'hand') return true;
  if (at === 'field') return toHand(g, c, p, { by: o.by, src: o.src });
  if (at === 'hell' && hellLocked(c)) { log(g, `${c.def.name} can't leave the Hell`); return false; }
  if (handBlocked(g, c, p, o.from ?? (at === 'other' ? 'other' : at), o)) return false; // v14c: FX.blockToHand
  if (at === 'life') { for (const q of g.p) { const i = q.life.findIndex((l) => l.card === c); if (i >= 0) q.life.splice(i, 1); } } else detach(g, c);
  P(g, p).hand.push(c);
  handWatch(g, c, o.from ?? (at === 'other' ? 'other' : at), o);
  return true;
}
/** FX.onToHand of c, for code that moved c into a hand itself (scout picks: handWatch(g, c, 'deck')). */
export function handWatch(g: Game, c: Card, from: HandFrom, o: HandOpts = {}) {
  const f = fx(c);
  if (!f || !f.onToHand || g.winner !== null) return;
  const holder = g.p.findIndex((q) => q.hand.includes(c));
  if (holder < 0) return;
  const src = o.src === undefined ? currentSource() : o.src;
  const by = o.by === undefined ? (src ? src.ctrl : null) : o.by;
  decide(g, holder, () => withSource(c, () => f.onToHand!(g, c, from, by, src)));
}

// ---------- v14b-3: copied abilities, Hell lock ----------
const CP_CACHE = new Map<string, any>();
/** The FX name whose abilities c has copied right now (copyAbilities), or null. Copies last while c stays on the field
 *  (and until the end of turn `until` when given). */
export function copiedFrom(c: Card): string | null {
  const n = (c.f as any)['cp:name'];
  if (!n) return null;
  const g = gameOf(c);
  if (!g) return n;
  const u = c.f['cp:until'];
  if ((u && g.turn > u) || !fieldZone(g, c)) return null;
  return n;
}
/** c gains every FX ability of `from` (a card, or a card name / print). Its own FX keeps priority for hooks both define.
 *  The caller runs the copied จุติ itself when the text says so: fx(c).jutsu is c's own; use FX[name].jutsu. */
export function copyAbilities(g: Game, c: Card, from: Card | string, until = 0) {
  const name = typeof from === 'string' ? from : (FX[from.def.name] ? from.def.name : from.def.print);
  (c.f as any)['cp:name'] = name; c.f['cp:until'] = until;
  log(g, `${c.def.name} gains the abilities of ${typeof from === 'string' ? from : from.def.name}`);
}
function withCopy(c: Card, own: any): any {
  const n = copiedFrom(c);
  const src = n ? FX[n] : null;
  if (!src) return own;
  const key = c.def.name + '|' + n;
  let m = CP_CACHE.get(key);
  if (!m) { m = { ...src, ...(own || {}) }; CP_CACHE.set(key, m); }
  return m;
}
let ANY_LOCK = false;
/** "This card can't be removed from the Hell in any way" (หมอเลิฟ). Optionally it comes back to `returnTo`'s hand at that
 *  player's afterDrawPhases-th Draw Phase from now (2 = "the 2nd Draw Phase after this"), even if the source left. */
export function lockInHell(g: Game, c: Card, returnTo: PID | null = null, afterDrawPhases = 0, why = '') {
  ANY_LOCK = true;
  c.f.hellLock = 1;
  if (returnTo !== null) { c.f.dpRetP = returnTo; c.f.dpRet = drawPhaseNo(g, returnTo) + afterDrawPhases; }
  addNote(g, c, `ออกจากนรกไม่ได้${why ? ' (' + why + ')' : ''}${returnTo !== null ? ` · ขึ้นมือใน Draw Phase ที่ ${afterDrawPhases}` : ''}`);
}
export function hellLocked(c: Card): boolean {
  if (!c || !c.f || !c.f.hellLock) return false;
  const g = gameOf(c);
  return !g || g.p.some((q) => q.hell.includes(c));
}
function unlockHell(c: Card) { delete c.f.hellLock; delete c.f.dpRet; delete c.f.dpRetP; delete (c.f as any)['v:note']; delete c.f['v:noteT']; }

// ---------- v14b-1: Magic in the opponent's turn (FX.offTurnMagic), extra React conditions (FX.reactAlso) ----------
/** May p cast Magic m now although it is the opponent's turn? (a card in play controlled by p says so) */
export function offTurnAllowed(g: Game, p: PID, m: Card): boolean {
  if (g.active === p || !withHook('offTurnMagic').size) return false;
  return hookSources(g, 'offTurnMagic').some((s) => s.ctrl === p && !!fx(s).offTurnMagic!(g, s, m));
}
/** Normal / Modification / Land Magic p can cast right now in the opponent's turn (one per type per turn as usual). */
export function offTurnActs(g: Game, p: PID): Act[] {
  if (g.active === p || !withHook('offTurnMagic').size) return [];
  const pl = P(g, p), acts: Act[] = [];
  for (const c of pl.hand) {
    if (c.def.type !== 'Magic') continue;
    const kind = c.def.subtype as MagicKind, f = fx(c);
    if (kind === 'React' || !f || !magicSlotFree(g, p, c) || !castAllowed(g, p, c) || !offTurnAllowed(g, p, c)) continue;
    if (kind === 'Land' && lands(g).some((l) => fx(l)?.lockLand)) continue;
    if (bestPayment(g, p, costOf(g, p, c), [c], c) === null) continue;
    const n = f.options || 1;
    for (let o = 0; o < n; o++) if (!f.canCast || quiet(() => f.canCast!(g, p, c, o))) acts.push({ k: 'cast', uid: c.uid, opt: o, label: `cast ${c.def.name}${n > 1 ? ' ' + o : ''} (opponent's turn)` });
  }
  return acts;
}
let OT_BUSY = 0;
/** The non-active player gets the chance to cast (Brain.offTurn): after each action of the active player, at the end of
 *  its Main Phase, at the start of the Battle Phase, after each attack, and at the start of the End Phase. */
export function offTurnWindow(g: Game, when: 'act' | 'mainEnd' | 'battleStart' | 'attack' | 'endTurn') {
  if (g.sim || !BRAINS || g.winner !== null || OT_BUSY || !withHook('offTurnMagic').size) return;
  const p = opp(g.active), b = BRAINS[p];
  if (!b.offTurn) return;
  OT_BUSY++;
  try {
    for (let i = 0; i < 4 && g.winner === null; i++) {
      const acts = quiet(() => offTurnActs(g, p));
      if (!acts.length) break;
      const a = b.offTurn(g, p, acts, when);
      const c = a ? findCard(g, a.uid) : null;
      if (!a || !c) break;
      log(g, `P${p} casts ${c.def.name} in the opponent's turn`);
      if (!decide(g, p, () => castMagic(g, p, c, a.opt))) break;
      stateCheck(g);
    }
  } finally { OT_BUSY--; }
}
/** FX.reactAlso of p's cards in play: React Magic c may also be used in this window (original conditions still apply). */
function reactAlsoOk(g: Game, p: PID, c: Card, ev: Ev): boolean {
  if (!withHook('reactAlso').size) return false;
  return hookSources(g, 'reactAlso').some((s) => s.ctrl === p && !!fx(s).reactAlso!(g, s, c, ev));
}

// =================== v14c small hooks asked by the card workers (engine/v14-hooks.md "v14c") ===================
/** FX.blockToHand of cards in play: true = c may not be put into p's hand now (addToHand / search). */
function handBlocked(g: Game, c: Card, p: PID, from: HandFrom, o: HandOpts): boolean {
  if (!withHook('blockToHand').size) return false;
  const src = o.src === undefined ? currentSource() : o.src;
  const by = o.by === undefined ? (src ? src.ctrl : null) : o.by;
  const s = hookSources(g, 'blockToHand').find((x) => !!fx(x).blockToHand!(g, x, c, p, from, by, src));
  if (s) log(g, `${s.def.name}: ${c.def.name} can't be put into the hand`);
  return !!s;
}
/** FX.noProtect of cards in play (and of the attacker of the current fight): true = target's built-in protections
 *  (พระคุ้มครอง, preventLeave, saveFromHand, protectWearer, protectSelf, leaveGuard, unaffected) don't stop this destroy. */
function protectionsOff(g: Game, c: Card): boolean {
  if (!withHook('noProtect').size) return false;
  const fi = currentFight();
  const srcs = hookSources(g, 'noProtect');
  if (fi && !srcs.includes(fi.att) && fx(fi.att)?.noProtect) srcs.push(fi.att);
  return srcs.some((s) => !!fx(s).noProtect!(g, s, c));
}
/** Activate abilities of p's cards in play whose FX has battleField: true, usable now in the Battle Phase
 *  (their can() must allow the Battle Phase). Brain.battle offers them (bot: look-ahead; human: listed with the attacks). */
export function battleActs(g: Game, p: PID): Act[] {
  if (!withHook('battleField').size) return [];
  return mainActs(g, p).filter((a) => a.k === 'field' && !!fx(findCard(g, a.uid)!)?.battleField);
}
/** Carried leave guards: c.f['lg:<FX name>'] = last turn it holds (set by a card that has left or isn't in play);
 *  FX[name].leaveGuard(g, c, c, info) is asked like any other guard (self = the protected card). */
function carriedGuard(g: Game, c: Card, info: LeaveInfo): boolean {
  for (const k of Object.keys(c.f)) {
    if (!k.startsWith('lg:') || !(c.f[k] >= g.turn)) continue;
    const sf = FX[k.slice(3)];
    if (!sf || !sf.leaveGuard) continue;
    const gd = decide(g, c.ctrl, () => withSource(c, () => sf.leaveGuard!(g, c, c, info)));
    if (!gd) continue;
    const use = gd.optional === false || decide(g, c.ctrl, () => askYesNo(g, c, `${k.slice(3)}: ${gd.label || `keep ${c.def.name} on the field`}?`, gd.want !== false));
    if (!use) continue;
    const kept = decide(g, c.ctrl, () => withSource(c, () => gd.run()));
    if (!fieldZone(g, c)) return true;
    if (kept) { log(g, `${k.slice(3)}: ${c.def.name} stays on the field`); return true; }
  }
  return false;
}
/** FX.onScouted of each revealed card that was not taken by the scout pick (before the rest is put away). */
function scoutWatch(g: Game, p: PID, left: Card[], src: Card | null) {
  if (!withHook('onScouted').size) return;
  const by = src ? src.ctrl : null;
  for (const c of [...left]) {
    const f = fx(c);
    if (f && f.onScouted && !findCard(g, c.uid) && g.winner === null) decide(g, p, () => withSource(c, () => f.onScouted!(g, c, p, by, src)));
  }
}
/** FX.onEnterPlay: a Land was placed (cast or effect), a Normal Magic stayed in the Magic Zone, a Construct was built. */
function enterPlay(g: Game, c: Card) {
  const f = fx(c);
  if (f && f.onEnterPlay && fieldZone(g, c) && g.winner === null) decide(g, c.ctrl, () => withSource(c, () => f.onEnterPlay!(g, c)));
}
/** GEM value overrides: RuleDef.pay (false = c can't pay for forCard) and FX.gemValue of cards in play. null = no change. */
function gemOverride(g: Game, c: Card, forCard: Card | null): number | null {
  if (g.rules && g.rules.length) for (const r of rulesOf(g, c.owner)) { const d = RULES[r.key]; if (d && d.pay && forCard && !d.pay(g, r, c, forCard)) return 0; }
  if (withHook('gemValue').size) for (const s of hookSources(g, 'gemValue')) { const v = fx(s).gemValue!(g, s, c, forCard); if (typeof v === 'number') return v; }
  return null;
}
/** Avatar Zone limit after the Land that allowed 6 (พิภพรัททาทุย) is gone: the owner sends real Avatars to Hell down to 4. */
function zoneTrim(g: Game) {
  for (const pl of g.p) {
    const real = realAvatars(pl), max = ratSix(g, pl) ? 6 : 4;
    if (real.length <= max) continue;
    const out = decide(g, pl.id, () => worstN(real, real.length - max, (x) => value(g, x), { title: `Avatar Zone: choose ${real.length - max} Avatar(s) to send to Hell (max ${max})` }));
    for (const a of out) toHell(g, a, { cost: true, by: null, src: null });
  }
}
/** FX.afterAction of cards in play: called at the end of every stateCheck (after each action / effect / fight). */
let AA_BUSY = 0;
function actionWatch(g: Game) {
  if (AA_BUSY || g.winner !== null || !withHook('afterAction').size) return;
  AA_BUSY++;
  try { for (const s of hookSources(g, 'afterAction')) if (fieldZone(g, s) && g.winner === null) decide(g, s.ctrl, () => withSource(s, () => fx(s).afterAction!(g, s))); }
  finally { AA_BUSY--; }
}

// =================== v14d (engine/v14-hooks.md "v14d") ===================
// ---------- d1: effect sources (POWER changes, targeting, leaving) ----------
let SHIELD_BUSY = 0;
/** Does c ignore effects of card src? FX.unaffected(g, c, src) of c itself (return false for sources whose effects still
 *  apply), or FX.shieldFrom(g, self, c, src) of a card in play. src === c never counts. */
export function unaffectedBy(g: Game, c: Card, src: Card | null): boolean {
  if (!src) return unaffected(g, c);
  if (src === c || SHIELD_BUSY) return false;
  if (unaffected(g, c, src)) return true;
  if (!withHook('shieldFrom').size) return false;
  SHIELD_BUSY++;
  try { return hookSources(g, 'shieldFrom').some((s) => !!fx(s).shieldFrom!(g, s, c, src)); } finally { SHIELD_BUSY--; }
}
/** Should temporary POWER change t (tagged with its source uid) count for c? */
function tempCounts(g: Game, c: Card, t: Temp, imm: boolean, shield: boolean): boolean {
  if (t.src === undefined || (!imm && !shield)) return !imm;
  const s = findCard(g, t.src) || kwSources(g).find((x) => x.uid === t.src) || null;
  return s ? !unaffectedBy(g, c, s) : !imm;
}
/** Add a POWER change with its source (default: the current source). until: 'turn' | 'battle' | a turn number | 'perm'. */
export function addPower(g: Game, c: Card, n: number, until: Temp['until'] | 'perm' = 'turn', src: Card | null = currentSource()) {
  const t: Temp = { power: n, until: until === 'perm' ? RULE_GAME : until };
  if (src) t.src = src.uid;
  c.temp.push(t);
}
/** withSource's finally: POWER changes made by this ability without a source get it (so unaffected / shieldFrom can tell). */
function tagTemps(src: Card) {
  const g = gameOf(src);
  if (!g) return;
  for (const q of g.p) for (const a of q.avatars.concat(q.mz)) for (const t of a.temp) if (t.src === undefined) t.src = src.uid;
}

// ---------- d2: who may wear a Modification ----------
/** Can Modification mod be attached to wearer? Def.noWear, FX.wearIf(g, mod, wearer) of the Modification,
 *  FX.refuseMod(g, wearer, mod) of the wearer (text off = no refusal). */
export function canWear(g: Game, mod: Card, wearer: Card): boolean {
  if (!wearer || wearer.def.noWear || !P(g, wearer.ctrl).avatars.includes(wearer)) return false;
  const mf = fx(mod);
  if (mf && mf.wearIf && !mf.wearIf(g, mod, wearer)) return false;
  const wf = fx(wearer);
  if (wf && wf.refuseMod && !silenced(g, wearer) && wf.refuseMod(g, wearer, mod)) return false;
  return true;
}
/** Attach mod to wearer (from anywhere) if canWear; runs FX.onAttach. Returns false (mod not moved) when it can't. */
export function attach(g: Game, mod: Card, wearer: Card, runHook = true): boolean {
  if (!canWear(g, mod, wearer)) return false;
  detach(g, mod);
  mod.wearer = wearer.uid; wearer.mods.push(mod);
  const f = fx(mod);
  if (runHook && f && f.onAttach) f.onAttach(g, mod, wearer);
  return true;
}

// ---------- d4: becoming asleep / awake ----------
let REST_BUSY = 0;
/** stateCheck: Avatars whose asleep state changed since the last check: FX.onRest(g, self) of the Avatar itself when it
 *  became asleep, FX.onRestChange(g, self, a, asleep) of cards in play for any Avatar. rest(g, a) fires at once. */
function restWatch(g: Game) {
  if (REST_BUSY) return;
  REST_BUSY++;
  try {
    const watch = withHook('onRest').size > 0 || withHook('onRestChange').size > 0;
    for (const q of g.p) for (const a of [...q.avatars]) {
      const now = a.asleep ? 1 : 0, was = a.f.zz ? 1 : 0;
      if (now === was) continue;
      if (now) a.f.zz = 1; else delete a.f.zz;
      if (!watch || g.winner !== null) continue;
      const f = fx(a);
      if (now && f && f.onRest && !silenced(g, a)) decide(g, a.ctrl, () => withSource(a, () => f.onRest!(g, a)));
      for (const s of hookSources(g, 'onRestChange')) if (fieldZone(g, s) && g.winner === null) decide(g, s.ctrl, () => withSource(s, () => fx(s).onRestChange!(g, s, a, !!now)));
    }
  } finally { REST_BUSY--; }
}
/** Put Avatar a to sleep ("ทำให้หลับ" / rest as a cost) and run the rest triggers now. */
export function rest(g: Game, a: Card) { a.asleep = true; restWatch(g); }

// ---------- d5: unattackable Avatars ----------
/** FX.noAttackOn(g, self, target, attacker) of cards in play: true = target can't be attacked by attacker. */
function attackShielded(g: Game, t: Card, att: Card): boolean {
  if ((t.f.noAtkUntil ?? -1) >= g.turn && att.ctrl !== t.ctrl) return true; // simplify1: noAttackUntil (stored on the card)
  if (!withHook('noAttackOn').size) return false;
  return hookSources(g, 'noAttackOn').some((s) => !!fx(s).noAttackOn!(g, s, t, att));
}

// ---------- d6: LIFE face down ----------
/** FX.blockLifeDown(g, self, p) of cards in play: p's LIFE can't be turned face down. */
export function lifeDownBlocked(g: Game, p: PID): boolean {
  if (critical(P(g, p))) return true; // v14 features item 4: สถานะสาหัส (all LIFE face up): no LIFE can be turned face down
  if (!withHook('blockLifeDown').size) return false;
  return hookSources(g, 'blockLifeDown').some((s) => !!fx(s).blockLifeDown!(g, s, p));
}
/** Turn p's LIFE l face down (use this instead of l.faceUp = false). false = blocked. */
export function lifeDown(g: Game, p: PID, l: Life): boolean {
  if (!l.faceUp) return true;
  if (lifeDownBlocked(g, p)) { log(g, `P${p}'s LIFE can't be turned face down`); return false; }
  l.faceUp = false; l.seen = false; l.trig = false; l.wasUp = false;
  log(g, `P${p} turns ${l.card.def.name} face down (${flippedLife(P(g, p))}/${P(g, p).life.length})`);
  return true;
}
/** stateCheck: a LIFE turned face down by code that set faceUp directly is turned back up while it is blocked. */
function lifeDownWatch(g: Game) {
  for (const p of [0, 1] as PID[]) {
    let blocked: boolean | null = null;
    for (const l of P(g, p).life) {
      if (l.faceUp) { l.wasUp = true; continue; }
      if (!l.wasUp) continue;
      if (blocked === null) blocked = lifeDownBlocked(g, p) || P(g, p).life.every((x) => x.faceUp || x.wasUp); // v14 features: was critical
      if (blocked) { l.faceUp = true; l.seen = true; log(g, `P${p}'s LIFE can't be turned face down: ${l.card.def.name} stays face up`); }
      else l.wasUp = false;
    }
  }
}

// =================== v14 features (user's game changes 2026-10-17, v14/BRIEF-features.md) ===================
// ---------- item 2: manual คู่หู / [Link] ----------
const PAIRS = new Map<string, string[]>();
/** Partner names a card names in its text: "[Link X]", "[คู่หู - X]", 'คู่หู - "X"', "{คู่หู} X {". */
export function pairNames(c: Card): string[] {
  let r = PAIRS.get(c.def.name);
  if (r) return r;
  r = [...linkNames(c)];
  const t = cardText(c).replace(/\s+/g, ' ');
  for (const re of [/\[\s*คู่หู\s*-\s*"?([^\]"]+?)"?\s*\]/g, /คู่หู\s*-\s*"([^"]+)"/g, /\{\s*คู่หู\s*\}\s*([^{}:]+?)\s*\{/g]) for (const m of t.matchAll(re)) r.push(m[1].trim());
  if (c.def.name === 'หนุมาน วานรวายุ') r.push('นิลพัท วานรสีกาฬ');
  if (c.def.name === 'นิลพัท วานรสีกาฬ') r.push('หนุมาน วานรวายุ');
  r = [...new Set(r.filter((x) => x.length > 1 && x.length < 60))];
  PAIRS.set(c.def.name, r);
  return r;
}
/** a and b name each other as คู่หู / [Link] partners (either card's text is enough). */
// linkbot: spelling variants between card names and effect text (โพลิกอน / โพลีกอน; Sally / Sully, Whiskey / Whisky)
const PAIR_SPELL: [RegExp, string][] = [[/โพลิกอน/g, 'โพลีกอน'], [/Sally/g, 'Sully'], [/Whiskey/g, 'Whisky']];
const pairSpell = (n: string) => PAIR_SPELL.reduce((s, [re, to]) => s.replace(re, to), n);
const pairNameHas = (c: Card, n: string) => nameHas(c, n) || nameHas(c, pairSpell(n));
export function pairMatch(a: Card, b: Card): boolean {
  return a !== b && (pairNames(a).some((n) => pairNameHas(b, n)) || pairNames(b).some((n) => pairNameHas(a, n)));
}
/** The Link action was used on exactly this pair (both still remember each other). */
export function linkActive(a: Card, b: Card): boolean { return !!a.f && !!b.f && a.f.linkWith === b.uid && b.f.linkWith === a.uid; }
/** Link actions for p's Main Phase: one per ordered pair (uid = the clicked Avatar, which stays; opt = the partner, which moves next to it). */
export function linkActs(g: Game, p: PID): Act[] {
  const av = P(g, p).avatars, out: Act[] = [];
  if (av.length < 2) return out;
  for (const a of av) {
    if (inLink(g, a)) continue;
    for (const b of av) if (b !== a && !inLink(g, b) && pairMatch(a, b)) out.push({ k: 'link', uid: a.uid, opt: b.uid, label: `Link: ${a.def.name} + ${b.def.name}` });
  }
  return out;
}
/** Form the คู่หู / [Link] state of a and b (b moves next to a), then run the partner triggers (onPartner, onLink, 'partner' window). */
export function linkPair(g: Game, p: PID, a: Card, b: Card): boolean {
  const pl = P(g, p);
  if (a === b || !pl.avatars.includes(a) || !pl.avatars.includes(b) || !pairMatch(a, b) || inLink(g, a) || inLink(g, b)) return false;
  a.f.linkWith = b.uid; b.f.linkWith = a.uid;
  a.f.linkTurn = b.f.linkTurn = g.turn; // linkbot: "when X enters [Link]" (ค้อนโยเนียร์) = the Link action this turn
  linkSlots(g, pl, a, b);
  log(g, `Link: ${a.def.name} + ${b.def.name} enter คู่หู / [Link]`);
  emit(g, { ev: 'link', who: p, a: a.uid, b: b.uid, s: `${p === 0 ? 'P0' : 'P1'}: ${a.def.name} + ${b.def.name} Link` });
  checkPartner(g, p);
  stateCheck(g);
  return true;
}

// ---------- item 8: fixed Avatar Zone slots ----------
// c.f.slot: 0..3 = the four slots, counted from the side far from the Deck (3 = next to the Deck); 4, 5 = the hidden
// extra slots. A new Avatar takes the free slot closest to the Deck; nothing moves when one leaves. c.f.slotP = side + 1.
const SLOT_FILL = [3, 2, 1, 0, 4, 5];
export function slotOf(c: Card): number { return c.f && typeof c.f.slot === 'number' && c.f.slotP ? c.f.slot : -1; }
export function assignSlots(g: Game) {
  for (const pl of g.p) {
    const used = new Set<number>(), todo: Card[] = [];
    for (const a of pl.avatars) {
      const s = a.f.slot;
      if (typeof s === 'number' && s >= 0 && s <= 5 && a.f.slotP === pl.id + 1 && !used.has(s)) used.add(s);
      else todo.push(a);
    }
    for (const a of todo) {
      const s = SLOT_FILL.find((x) => !used.has(x));
      if (s === undefined) break;
      a.f.slot = s; a.f.slotP = pl.id + 1; used.add(s);
    }
  }
}
/** Link: move b into a slot next to a (swapping with whatever is there). */
function linkSlots(g: Game, pl: Player, a: Card, b: Card) {
  assignSlots(g);
  const sa = a.f.slot, sb = b.f.slot;
  if (sa > 3 || Math.abs(sa - sb) === 1 && sb <= 3) return;
  const cands = [sa - 1, sa + 1].filter((x) => x >= 0 && x <= 3);
  if (!cands.length) return;
  const occ = (x: number) => pl.avatars.find((o) => o.f.slot === x) || null;
  cands.sort((x, y) => (occ(x) ? 1 : 0) - (occ(y) ? 1 : 0) || Math.abs(x - sb) - Math.abs(y - sb));
  const t = cands[0], o = occ(t);
  if (o) o.f.slot = sb;
  b.f.slot = t;
  log(g, `${b.def.name} moves next to ${a.def.name}`);
}

// ---------- item 5: hand limit ----------
export const HAND_LIMIT = 7;
/** End Phase: p discards down to 7. Cards added to the hand during this End Phase (not in `before`) don't count. */
export function handLimit(g: Game, p: PID, before: Set<number>) {
  const pl = P(g, p);
  const extra = pl.hand.filter((c) => !before.has(c.uid)).length;
  const n = pl.hand.length - HAND_LIMIT - extra;
  if (n <= 0) return;
  const xs = decide(g, p, () => worstN(pl.hand, n, (c) => keepValue(g, c), { title: `Hand limit: discard ${n} card${n > 1 ? 's' : ''} (keep 7) · ทิ้งการ์ดให้เหลือ 7 ใบ` }));
  for (const c of xs) if (pl.hand.includes(c)) discard(g, p, c);
  log(g, `P${p} discards ${xs.length} for the hand limit (7): ${xs.map((c) => c.def.name).join(', ')}`);
  emit(g, { ev: 'handlimit', who: p, n: xs.length, cards: xs.map((c) => ({ uid: c.uid, print: c.def.print, name: c.def.name })), s: '' });
}

// ---------- item 9: Battle-Phase buffs (สามัคคี / แทงหลัง given before the attack) ----------
// Helper A (awake, with สามัคคี or แทงหลัง, allowed to help B as helpersFor says) rests and B gets the POWER at once:
// สามัคคี = A's POWER, แทงหลัง = A's POWER + 1 (a Temp with buff = A's uid). Several helpers may stack on one B. When B
// attacks, the buffs last until the end of that fight and แทงหลัง's colour rule applies after it. Cancel (before B
// attacks): A wakes, B loses the buff. Unused buffs expire at the end of the turn (A stays rested).
export interface BuffAct { helper: Card; to: Card; kind: 'unity' | 'backstab'; amount: number; bonus?: number }
export function buffKindOf(g: Game, u: Card): 'unity' | 'backstab' | null { return hasKw(g, u, 'unite') ? 'unity' : hasKw(g, u, 'backstab') ? 'backstab' : null; }
const pendingOn = (b: Card) => b.temp.some((t) => !!t.buff);
/** Helpers whose buff is waiting on b. */
export function pendingBuffs(g: Game, b: Card): Card[] {
  return b.temp.filter((t) => !!t.buff).map((t) => findCard(g, t.buff!)).filter((x): x is Card => !!x);
}
/** The helper's pending buff target (or null). */
export function buffTargetOf(g: Game, u: Card): Card | null {
  if (u.f.buffT !== g.turn || !u.f.buffTo) return null;
  const b = findCard(g, u.f.buffTo);
  return b && b.temp.some((t) => t.buff === u.uid) ? b : null;
}
export function buffActs(g: Game, p: PID): BuffAct[] {
  if (g.phase !== 'Battle' || g.active !== p || g.turn === 1 || g.stopBattle || g.winner !== null) return [];
  const out: BuffAct[] = [];
  for (const b of P(g, p).avatars) {
    if (!canAttack(g, p, b) || legalTargets(g, p, b).length === 0) continue;
    for (const u of helpersFor(g, p, b)) {
      if (pendingOn(u) || buffTargetOf(g, u)) continue;
      const kind = buffKindOf(g, u);
      if (!kind) continue;
      // FX.assistBonus: the helper gains POWER just before it helps (ฮอล นักบวช), so the buff carries it
      const uf = fx(u);
      const bonus = uf && uf.assistBonus && !silenced(g, u) ? uf.assistBonus(g, u, b, kind) : 0;
      out.push({ helper: u, to: b, kind, amount: power(g, u) + bonus + (kind === 'backstab' ? 1 : 0), bonus });
    }
  }
  return out;
}
export function applyBuff(g: Game, p: PID, u: Card, b: Card): boolean {
  const a = buffActs(g, p).find((x) => x.helper === u && x.to === b);
  if (!a) return false;
  u.asleep = true;
  if (a.bonus) addPower(g, u, a.bonus, 'turn', u);
  b.temp.push({ power: a.amount, until: 'turn', src: u.uid, buff: u.uid });
  u.f.buffTo = b.uid; u.f.buffT = g.turn; u.f.buffK = a.kind === 'unity' ? 1 : 2;
  const th = a.kind === 'unity' ? 'สามัคคี' : 'แทงหลัง';
  log(g, `${u.def.name} ${th}: ${b.def.name} POWER +${a.amount} (until it attacks)`);
  emit(g, { ev: 'buff', kind: a.kind, who: p, from: u.uid, to: b.uid, amount: a.amount, s: `${u.def.name} ${th}: ${b.def.name} POWER +${a.amount}` });
  stateCheck(g);
  return true;
}
export function cancelBuff(g: Game, p: PID, u: Card): boolean {
  const b = buffTargetOf(g, u);
  if (!b || u.ctrl !== p) return false;
  b.temp = b.temp.filter((t) => t.buff !== u.uid);
  if (P(g, p).avatars.includes(u)) u.asleep = false;
  delete u.f.buffTo; delete u.f.buffT; delete u.f.buffK;
  log(g, `${u.def.name}: buff on ${b.def.name} cancelled`);
  emit(g, { ev: 'unbuff', who: p, from: u.uid, to: b.uid, s: '' });
  stateCheck(g);
  return true;
}
/** attack(): the attacker's pending buffs last until the end of this fight; returns the แทงหลัง helpers (colour rule). */
function takeBuffs(g: Game, p: PID, att: Card): Card[] {
  const stab: Card[] = [];
  for (const t of att.temp) {
    if (!t.buff) continue;
    const u = findCard(g, t.buff);
    delete t.buff; t.until = 'battle';
    if (!u) continue;
    const kind = u.f.buffK === 1 ? 'unity' : 'backstab';
    delete u.f.buffTo; delete u.f.buffT; delete u.f.buffK;
    if (kind === 'unity') {
      emit(g, { ev: 'assist', kind: 'unity', who: p, from: u.uid, to: att.uid, amount: t.power, s: `${u.def.name} สามัคคี: ${att.def.name} POWER +${t.power}` });
      const f = fx(att); if (f && f.onUnited) f.onUnited(g, att, u);
      assistUsed(g, u, att, 'unity');
    } else {
      stab.push(u);
      emit(g, { ev: 'assist', kind: 'backstab', who: p, from: u.uid, to: att.uid, amount: t.power, s: `${u.def.name} แทงหลัง: ${att.def.name} POWER +${t.power}` });
      const uf = fx(u); if (uf && uf.onBackstab && !silenced(g, u)) decide(g, p, () => uf.onBackstab!(g, u, att));
      assistUsed(g, u, att, 'backstab');
    }
  }
  return stab;
}
/** End of turn: buffs nobody used expire. */
function clearBuffs(g: Game) {
  for (const pl of g.p) for (const a of pl.avatars) {
    if (a.temp.some((t) => t.buff)) a.temp = a.temp.filter((t) => !t.buff);
    if (a.f.buffT) { delete a.f.buffTo; delete a.f.buffT; delete a.f.buffK; }
  }
}

// ---------- simplify1: timed effects stored on the target card (they last after the source left the field) ----------
/** The card loses its text until the end of turn `until` (a turn number; g.turn = this turn) while it stays on the field.
 *  parts: true = all text (ลูกฮึด, ต่อเนื่อง, คำสั่งเสีย too), or a list of AbilityParts. Stored in c.f (cleared when it leaves). */
export function loseText(g: Game, c: Card, until: number, parts: true | AbilityPart[] = true) {
  if (unaffected(g, c)) return;
  c.f.txOff = Math.max(Number(c.f.txOff ?? -1), until); c.f.txParts = parts === true ? 'all' : parts.join(',');
}
function ownTextOff(g: Game, c: Card, part: AbilityPart | 'all'): boolean {
  if (c.f.txOff === undefined || c.f.txOff < g.turn) return false;
  if (c.f.txParts === 'all') return true;
  if (part === 'all') return false;
  const ps = String(c.f.txParts || '').split(',');
  return ps.includes(part) || (ps.includes('ability') && (part === 'jutsu' || part === 'kw'));
}
/** Opponents of its controller can't choose c as an attack target until the end of turn `until` (kept on c while it stays). */
export function noAttackUntil(g: Game, c: Card, until: number) { c.f.noAtkUntil = Math.max(Number(c.f.noAtkUntil ?? -1), until); }
/** After takeControl: control of c goes back to its owner at the end of the owner's next Draw Phase. */
export function ctrlUntilOwnerDraw(g: Game, c: Card) { c.f.ctrlBackDraw = g.turn; }
function ctrlBackAfterDraw(g: Game, p: PID) {
  for (const q of g.p) for (const a of [...q.avatars, ...q.mz]) {
    if (a.f.ctrlBackDraw === undefined || a.owner !== p || a.ctrl === p || a.f.ctrlBackDraw >= g.turn) continue;
    detach(g, a); a.ctrl = a.owner; delete a.f.ctrlBackDraw; P(g, a.owner).avatars.push(a);
    log(g, `${a.def.name} returns to its owner P${p} (end of the Draw Phase)`);
  }
}
/** RuleDef.extraMagic: a live rule of p that lets p use Magic m once more this turn (null = none). */
function extraMagicRule(g: Game, p: PID, m: Card): Rule | null {
  if (m.def.type !== 'Magic' || !g.rules || !g.rules.length) return null;
  for (const r of rulesOf(g, p)) { const d = RULES[r.key]; if (d && d.extraMagic && (r.n ?? 1) > 0 && d.extraMagic(g, r, m)) return r; }
  return null;
}
/** May p use Magic m now as far as "one Magic of each subtype per turn" goes (pl.used, or an extra-Magic rule)? */
export function magicSlotFree(g: Game, p: PID, m: Card): boolean { return !P(g, p).used[m.def.subtype as MagicKind] || !!extraMagicRule(g, p, m); }
/** p uses Magic m: marks its subtype used; when it was used already, an extra-Magic rule is spent instead. */
export function useMagicSlot(g: Game, p: PID, m: Card) {
  const pl = P(g, p), kind = m.def.subtype as MagicKind;
  if (pl.used[kind]) { const r = extraMagicRule(g, p, m); if (r) { r.n = (r.n ?? 1) - 1; log(g, `${m.def.name}: extra Magic (${RULES[r.key]?.label || r.key})`); } }
  pl.used[kind] = true;
}
/** simplify1 (user 2026-10-22): "Avatar ที่ไม่มีความสามารถใน Text Box หรือไม่มี Text Box" now: a token, a card printed with no
 *  text (vanilla / no FX entry), or one whose abilities are removed right now (เชาว์ปัญญาลิง, Skill : Hypersense = silencedTurn;
 *  ตัดเน็ต full deletion; FX.textOff; loseText): everything abilitiesOff(g, c, 'ability') reports. Shared by every such check. */
export function noAbilityNow(g: Game, c: Card): boolean {
  return c.token || ((c.def as any).vanilla ?? !fx(c)) || abilitiesOff(g, c, 'ability');
}
