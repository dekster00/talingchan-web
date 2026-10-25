// v14 "core-view": what the player sees about changed cards, and the effective values every rule check uses.
// Card workers: read engine/v14-view.md (hook names, signatures, examples).
//
// 1. Effective symbols / names: symbolsOf / namesOf (engine.ts symIs / nameHas use them, so every rule check sees them).
//    Sources: FX[name].symbolsFor / namesFor of every card in play (Avatars, attached cards, Magic Zone, Land, face-up
//    LIFE) and of the card itself (in any zone), plus per-card overrides set by effects (setSymbols / addSymbols /
//    setName / addName). The symbol '*' means "every symbol" (shown as "All in one").
// 2. Effective cost: viewCost (engine.ts costOf uses it, for paying and for display): own FX.costOf (or printed Cost),
//    or a per-card override (setCost / swapCostPower), then + every FX.costMod from cards in play and the card itself.
// 3. GET badge: getList(g, c) = FX.getActive(g, self) of the card, FX.getFor(g, src, target) of cards in play, and
//    per-card grants (grantGet).
// 4. Origin tag: how a field Avatar arrived (c.f['v:how'] / c.f['v:from'], set by summon(); tokens are 'token').
// 5. Detail-box notes: FX.viewNote(g, src, target) + per-card addNote; face-up deck top: FX.revealTop / revealTop flag.
// cardView(g, c) packs all of this for the screen (play/worker.ts puts it in cv(...).vw).
//
// Module state uses `var` + lazy init: engine.ts imports this file inside an import cycle.
import type { Card, Game, PID } from './types.ts';
import { fx, kwSources, contOff, silenced, P, costOf } from './engine.ts';

/** View hooks an FX entry may define (in addition to the Fx interface of cards.ts). */
export interface ViewFx {
  /** Symbols `target` has because of `self` (a card in play, or target itself in any zone). Array = added;
   *  {set: [...]} = replaces target's symbols. '*' = every symbol. null/[] = nothing. */
  symbolsFor?(g: Game, self: Card, target: Card): string[] | { set: string[] } | null;
  /** Names `target` has because of `self`. Array = also has these names; {set: name} = renamed. */
  namesFor?(g: Game, self: Card, target: Card): string[] | { set: string } | null;
  /** Cost change `self` gives `target` (any zone: check it yourself). -1 = Cost -1. */
  costMod?(g: Game, self: Card, target: Card): number;
  /** This card's conditional ability is active now: true = "GET", a string = what it got (shown on hover). */
  getActive?(g: Game, self: Card): boolean | string;
  /** `self` (in play) gives `target` a GET: true or a text. */
  getFor?(g: Game, self: Card, target: Card): boolean | string;
  /** Extra line for target's detail box (self = a card in play, or target itself). */
  viewNote?(g: Game, self: Card, target: Card): string | null;
  /** While true, the top card of player p's deck is face up for both players. */
  revealTop?(g: Game, self: Card, p: PID): boolean;
}
const vfx = (c: Card): ViewFx | undefined => fx(c) as any;

// ---------- card -> game ----------
// symIs / nameHas / costOf callers pass only a Card. Every game registers its cards (registerGame / newCard); a card not
// registered (e.g. after the play table's Undo restored a copy) belongs to the last real game.
var CG: WeakMap<Card, Game> | undefined;
var LAST: Game | null = null;
export function bindCard(g: Game, c: Card) {
  if (!CG) CG = new WeakMap();
  CG.set(c, g);
  for (const m of c.mods) CG.set(m, g);
}
export function bindGame(g: Game) {
  if (!g || !g.p) return;
  if (!g.sim) LAST = g;
  for (const pl of g.p) {
    if (!pl) continue;
    for (const z of [pl.hand, pl.avatars, pl.hell, pl.deck, pl.exile, pl.mz, pl.resolving || [], pl.returnAtMain, pl.returnAtEnd]) for (const c of z || []) bindCard(g, c);
    for (const l of pl.life) bindCard(g, l.card);
  }
  if (g.land) bindCard(g, g.land);
}
export function gameOf(c: Card): Game | null { return (CG && CG.get(c)) || LAST; }

// ---------- helpers ----------
var DEPTH = 0; // > 0 while a view hook runs: symIs / nameHas inside a hook see printed values (no loops)
const live = (g: Game, c: Card, key: string) => { const t = c.f[key + 'T'] as number; return !t || t >= g.turn; };
const onField = (g: Game, c: Card) => g.p.some((q) => q.avatars.includes(c) || q.mz.includes(c) || q.avatars.some((a) => a.mods.includes(c)));
/** Cards with view hook `hook` that apply to `target`: every card in play (text not switched off) + target itself.
 *  Written as a plain loop (no arrays unless a hook exists): symIs / nameHas / costOf run very often. */
function sources(g: Game, target: Card, hook: keyof ViewFx): Card[] {
  let out: Card[] | null = null, self = false;
  const take = (s: Card) => {
    const f = vfx(s);
    if (!f || !f[hook]) return;
    if (s === target) { if (!self) { self = true; (out ||= []).push(s); } return; }
    if (contOff(g, s)) return;
    (out ||= []).push(s);
  };
  for (const q of g.p) {
    for (const a of q.avatars) { take(a); for (const m of a.mods) take(m); }
    for (const s of q.mz) if (!s.f.faceDown) take(s);
    for (const l of q.life) if (l.faceUp) take(l.card);
  }
  if (g.land) take(g.land);
  if (!self) take(target);
  return out || NONE;
}
const NONE: Card[] = [];
function guard<T>(dflt: T, fn: () => T): T {
  if (DEPTH > 2) return dflt;
  DEPTH++;
  try { return fn(); } catch (e) { return dflt; } finally { DEPTH--; }
}
function strList(v: any): string[] { return typeof v === 'string' && v ? v.split('|') : []; }

// ---------- 1. symbols ----------
export const ALL_SYMBOLS = '*';
export function printedSymbols(c: Card): string[] {
  const out: string[] = [];
  for (const s of [c.def.symbol, ...(c.def.syms || [])]) if (s && !out.includes(s)) out.push(s);
  return out;
}
/** Effective symbols of c ('*' = every symbol). */
export function symbolsOf(c: Card, g: Game | null = gameOf(c)): string[] {
  const base = printedSymbols(c);
  if (!g || DEPTH > 0 || !c.f) return base;
  return guard(base, () => {
    for (const s of sources(g, c, 'symbolLock')) { const f = vfx(s) as any; if (f && f.symbolLock && f.symbolLock(g, s, c)) return base; } // other-team audit: GHD โคลค
    let set: string[] | null = c.f['v:sym'] !== undefined && live(g, c, 'v:sym') ? strList(c.f['v:sym']) : null;
    const add: string[] = live(g, c, 'v:symAdd') ? strList(c.f['v:symAdd']) : [];
    for (const s of sources(g, c, 'symbolsFor')) {
      const f = vfx(s);
      if (!f || !f.symbolsFor || (s === c && silenced(g, c) && !c.def.cont)) continue;
      const r = f.symbolsFor(g, s, c);
      if (!r) continue;
      if (Array.isArray(r)) add.push(...r); else if (r.set) set = [...r.set];
    }
    const out = set ? [...set] : [...base];
    for (const a of add) if (a && !out.includes(a)) out.push(a);
    return out;
  });
}
/** Does c have symbol s now? (engine.ts symIs calls this.) */
export function hasSymbol(c: Card, s: string): boolean {
  const g = gameOf(c);
  if (!g || DEPTH > 0 || !c.f || (c.f['v:sym'] === undefined && c.f['v:symAdd'] === undefined && sources(g, c, 'symbolsFor') === NONE)) {
    return c.def.symbol === s || !!(c.def.syms && c.def.syms.includes(s)); // fast path: nothing changes symbols
  }
  const xs = symbolsOf(c, g);
  return xs.includes(s) || (xs.includes(ALL_SYMBOLS) && !!s);
}
/** Effect: c's symbols become syms (until the end of turn `until`; 0 = while it stays where it is: cleared when it
 *  leaves the field). */
export function setSymbols(g: Game, c: Card, syms: string[], until = 0) { (c.f as any)['v:sym'] = syms.join('|'); c.f['v:symT'] = until; }
/** Effect: c also has these symbols. */
export function addSymbols(g: Game, c: Card, syms: string[], until = 0) {
  const cur = live(g, c, 'v:symAdd') ? strList(c.f['v:symAdd']) : [];
  (c.f as any)['v:symAdd'] = [...new Set([...cur, ...syms])].join('|'); c.f['v:symAddT'] = until;
}

// ---------- 1b. names ----------
export function printedNames(c: Card): string[] { return [c.def.name, ...(c.def.aka || [])]; }
/** Effective names of c; [0] = the name it shows. */
export function namesOf(c: Card, g: Game | null = gameOf(c)): string[] {
  const base = printedNames(c);
  if (!g || DEPTH > 0 || !c.f) return base;
  return guard(base, () => {
    let main = c.f['v:name'] !== undefined && live(g, c, 'v:name') ? String(c.f['v:name']) : null;
    const add: string[] = live(g, c, 'v:nameAdd') ? strList(c.f['v:nameAdd']) : [];
    for (const s of sources(g, c, 'namesFor')) {
      const f = vfx(s);
      if (!f || !f.namesFor || (s === c && silenced(g, c) && !c.def.cont)) continue;
      const r = f.namesFor(g, s, c);
      if (!r) continue;
      if (Array.isArray(r)) add.push(...r); else if (r.set) main = r.set;
    }
    const out = main !== null ? [main, ...base.slice(1)] : [...base];
    for (const a of add) if (a && !out.includes(a)) out.push(a);
    return out;
  });
}
/** Some effective name of c contains key ("ติดชื่อ"). (engine.ts nameHas calls this.) */
export function hasName(c: Card, key: string): boolean {
  const g = gameOf(c);
  if (!g || DEPTH > 0 || !c.f || (c.f['v:name'] === undefined && c.f['v:nameAdd'] === undefined && sources(g, c, 'namesFor') === NONE)) {
    return c.def.name.includes(key) || !!(c.def.aka && c.def.aka.some((a) => a.includes(key))); // fast path
  }
  return namesOf(c, g).some((n) => n.includes(key));
}
/** Some effective name of c is exactly name. */
export function nameIs(c: Card, name: string): boolean { return namesOf(c).includes(name); }
/** Effect: rename c ("เปลี่ยนชื่อเป็น"). */
export function setName(g: Game, c: Card, name: string, until = 0) { (c.f as any)['v:name'] = name; c.f['v:nameT'] = until; }
/** Effect: c also has this name ("ได้รับชื่อ"). */
export function addName(g: Game, c: Card, name: string, until = 0) {
  const cur = live(g, c, 'v:nameAdd') ? strList(c.f['v:nameAdd']) : [];
  (c.f as any)['v:nameAdd'] = [...new Set([...cur, name])].join('|'); c.f['v:nameAddT'] = until;
}

// ---------- 2. cost ----------
/** costOf's second half: base = own FX.costOf / printed Cost (or a setCost / swap override), then + every costMod. */
export function viewCost(g: Game, p: PID, c: Card, base: number): number {
  if (!c.f || !g) return base;
  if (c.f['v:cost'] !== undefined && costOverrideLive(g, c)) base = Number(c.f['v:cost']);
  if (DEPTH > 0) return Math.max(0, base);
  const srcs = sources(g, c, 'costMod');
  if (srcs === NONE) return Math.max(0, base);
  const mod = guard(0, () => {
    let m = 0;
    for (const s of srcs) { const f = vfx(s); if (f && f.costMod && !(s === c && silenced(g, c) && !c.def.cont)) m += f.costMod(g, s, c) || 0; }
    return m;
  });
  return Math.max(0, base + mod);
}
function costOverrideLive(g: Game, c: Card) {
  if (c.f['v:costSwap']) return c.temp.some((t: any) => t.vSwap); // lasts as long as its POWER half
  return live(g, c, 'v:cost');
}
/** Effect: c's Cost becomes n (until the end of turn `until`; 0 = while it stays on the field). */
export function setCost(g: Game, c: Card, n: number, until = 0) { c.f['v:cost'] = n; c.f['v:costT'] = until; delete c.f['v:costSwap']; }
/** Effect: swap c's Cost and POWER (กลับหลังหัน: until = 'battle'; ชิบาตะ โบตัน: 'turn'). The POWER half is a temp
 *  POWER change, the Cost half lasts exactly as long. */
export function swapCostPower(g: Game, c: Card, until: 'turn' | 'battle', costNow: number = costOf(g, c.ctrl, c)) {
  const pw = c.def.power + c.bonus;
  c.temp.push({ power: costNow - pw, until, vSwap: g.turn } as any);
  c.f['v:cost'] = pw; c.f['v:costSwap'] = 1;
  addNote(g, c, `สลับ Cost/POWER: Cost ${pw} · POWER ${costNow}`, g.turn);
}

// ---------- 3. GET ----------
/** Texts of c's active GET abilities ('GET' when the hook gives no text). [] = no badge. */
export function getList(g: Game, c: Card): string[] {
  return guard([] as string[], () => {
    const out: string[] = [];
    const txt = (r: boolean | string | null | undefined) => { if (r) out.push(typeof r === 'string' ? r : 'GET'); };
    const f = vfx(c);
    if (f && f.getActive && !silenced(g, c)) txt(f.getActive(g, c));
    if (c.f['v:get'] !== undefined && live(g, c, 'v:get')) txt(String(c.f['v:get']) || true);
    for (const s of sources(g, c, 'getFor')) { const sf = vfx(s); if (s !== c && sf && sf.getFor) txt(sf.getFor(g, s, c)); }
    return out;
  });
}
/** Effect: target shows GET (with this text) until the end of turn `until` (0 = while it stays on the field). */
export function grantGet(g: Game, c: Card, text = 'GET', until = 0) { (c.f as any)['v:get'] = text; c.f['v:getT'] = until; }
export function clearGet(c: Card) { delete c.f['v:get']; delete c.f['v:getT']; }

// ---------- 4. origin ----------
export type OriginHow = 'paid' | 'jutsu' | 'own' | 'effect' | 'token';
export type OriginFrom = 'hand' | 'hell' | 'exile' | 'deck' | 'mz' | 'life' | 'other';
/** Where c is now (called by summon() before the card moves). */
export function originZone(g: Game, c: Card): OriginFrom {
  if (c.f.viaScout) return 'deck';
  for (const pl of g.p) {
    if (pl.hand.includes(c)) return 'hand';
    if (pl.hell.includes(c)) return 'hell';
    if (pl.exile.includes(c)) return 'exile';
    if (pl.deck.includes(c)) return 'deck';
    if (pl.mz.includes(c) || pl.avatars.some((a) => a.mods.includes(c))) return 'mz';
    if (pl.life.some((l) => l.card === c)) return 'life';
  }
  return 'other';
}
/** summon() records how the Avatar arrived (after the card's state was reset). */
export function noteOrigin(c: Card, how: string, from: OriginFrom) { (c.f as any)['v:how'] = how; (c.f as any)['v:from'] = from; }
/** How a field Avatar arrived, or null when unknown (put on the field without summon()). */
export function originOf(c: Card): { how: OriginHow; from: OriginFrom } | null {
  if (c.token) return { how: 'token', from: 'other' };
  const how = (c.f as any)['v:how'];
  return how ? { how, from: (c.f as any)['v:from'] || 'other' } : null;
}
/** Came from this zone (กลับบ้านเก่า: cameFrom(a, 'hell')). */
export function cameFrom(c: Card, from: OriginFrom): boolean { const o = originOf(c); return !!o && o.from === from; }
/** Summoned without paying its Cost from hand (any effect summon, จุติ by effect, from hell / exile / deck, token). */
export function specialSummoned(c: Card): boolean { const o = originOf(c); return !!o && o.how !== 'paid'; }
const HOW_TH: Record<string, string> = { paid: 'อัญเชิญ (จ่าย Cost)', jutsu: 'อัญเชิญ จุติ', own: 'อัญเชิญพิเศษ', effect: 'อัญเชิญพิเศษ', token: 'Token' };
const FROM_TH: Record<string, string> = { hell: 'จากนรก', exile: 'จากเนรเทศ', deck: 'จาก Deck', mz: 'จาก Magic Zone', life: 'จาก LIFE' };
export function originLabel(c: Card): string {
  const o = originOf(c);
  if (!o) return '';
  return [HOW_TH[o.how] || o.how, FROM_TH[o.from] || ''].filter(Boolean).join(' · ');
}

// ---------- 5. notes, revealed deck top ----------
/** Effect: an extra detail-box line on c (until the end of turn `until`; 0 = while it stays where it is). */
export function addNote(g: Game, c: Card, text: string, until = 0) { (c.f as any)['v:note'] = text; c.f['v:noteT'] = until; }
export function notesOf(g: Game, c: Card): string[] {
  return guard([] as string[], () => {
    const out: string[] = [];
    if (c.f['v:note'] !== undefined && live(g, c, 'v:note')) out.push(String(c.f['v:note']));
    for (const s of sources(g, c, 'viewNote')) { const f = vfx(s); if (f && f.viewNote) { const t = f.viewNote(g, s, c); if (t) out.push(t); } }
    return out;
  });
}
/** Effect: c (a deck card) is face up for both players while it stays in the deck (cleared when it moves out). */
export function revealCard(c: Card, on = true) { if (on) c.f['v:rev'] = 1; else delete c.f['v:rev']; }
/** The top card of p's deck is face up for both players (FX.revealTop of a card in play, or the card's own flag). */
export function deckTopRevealed(g: Game, p: PID): boolean {
  const top = P(g, p).deck[0];
  if (!top) return false;
  if (top.f['v:rev']) return true;
  return guard(false, () => kwSources(g).some((s) => { const f = vfx(s); return !!(f && f.revealTop && !contOff(g, s) && f.revealTop(g, s, p)); }));
}

// ---------- the screen ----------
/** Only what differs from the printed card, for the detail box / field badges (play/worker.ts cv().vw). null = nothing. */
export function cardView(g: Game, c: Card): any {
  const v: any = {};
  const syms = symbolsOf(c, g), ps = printedSymbols(c);
  if (syms.join('|') !== ps.join('|')) { v.syms = syms.filter((s) => s !== ALL_SYMBOLS); if (syms.includes(ALL_SYMBOLS)) v.symAll = true; }
  const names = namesOf(c, g), pn = printedNames(c);
  if (names.join('|') !== pn.join('|')) { v.name = names[0]; if (names[0] !== c.def.name) v.printedName = c.def.name; v.alsoNames = names.slice(1).filter((n) => !pn.includes(n)); }
  if (c.def.type === 'Avatar' || c.def.type === 'Construct' || c.def.type === 'Token') {
    const fxc = fx(c) as any;
    const cost = viewCost(g, c.ctrl, c, fxc && fxc.costOf ? safe(() => fxc.costOf(g, c.ctrl, c), c.def.cost) : c.def.cost);
    if (cost !== c.def.cost) v.cost = cost;
  }
  if (onField(g, c)) {
    const get = getList(g, c);
    if (get.length) v.get = get;
    const o = originLabel(c);
    if (o) { v.origin = o; v.originKey = originOf(c); }
  }
  const notes = notesOf(g, c);
  if (notes.length) v.notes = notes;
  return Object.keys(v).length ? v : null;
}
function safe<T>(fn: () => T, d: T): T { try { return fn(); } catch { return d; } }
