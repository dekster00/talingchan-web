// Card effects for BT09, CC02 (cards not coded in cards.ts / cards2.ts).
// Approximations are marked "approx:". Helpers below are local copies of the cards2.ts ones.
import { rollDie } from '../engine.ts';
import type { Card, Def, Game, PID } from '../types.ts';
import type { Ev } from '../engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield } from '../engine.ts';
import { attach as attachCard, canWear, lifeDown } from '../engine.ts'; // v14d
import type { Fx, HandAct } from '../cards.ts';
import { FX, value, best, worst, pickGemExact, pickN, worstN, mayDo, chooseMode, oppChoice, removeOpp, inMain, search, oppTargets, cancel } from '../cards.ts';
import { costFirst } from '../cards.ts'; // other-team audit Q9
import {
  P, opp, power, draw, destroy, toHell, toExile, discard, detach, summon, shuffle, mill, canPlaceAvatar,
  flippedLife, critical, onceUsed, markOnce, keepValue, log, findCard, fx, rand, bestPayment, choosePayment,
  hitLife, silenced, hasKw, costOf, uniqueBlocked, gemOf, isNinja, lose,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding
} from '../engine.ts';
// v14 (cards-D): hooks from engine/v14-hooks.md and view helpers from engine/v14-view.md
import { turnLog, currentFight, RULES, addRule, RULE_GAME, flipLifeCard, askChoose, askPick, fieldZone, nameHas, kwSources, contOff } from '../engine.ts';
import { setName, setCost, setSymbols, symbolsOf, grantGet, originZone } from '../view.ts';
import { addPower as addPowerE } from '../engine.ts'; // other-team audit

// ---------- helpers ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function named(c: Card, key: string) {
  // other-team audit: "ธอร์" is inside "อาเธอร์"; it must not count as ธอร์
  const has = (s: string) => (key === 'ธอร์' ? /(^|[^เ])ธอร์/.test(s) : s.includes(key));
  if (c.def.aka && c.def.aka.some(has)) return true;
  if (has(c.def.name)) return true;
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some(has));
}
const onZone = (g: Game, p: PID, key: string) => P(g, p).avatars.filter((a) => named(a, key));
const linked = (g: Game, c: Card, key: string) => P(g, c.ctrl).avatars.some((a) => a !== c && named(a, key) && a.f.linkWith === c.uid && c.f.linkWith === a.uid); // v14 features: Link action
const onField = (g: Game, c: Card) => P(g, c.ctrl).avatars.includes(c);
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
const use = (g: Game, p: PID, key: string) => markOnce(g, P(g, p), key);
const hellAvatars = (g: Game, p: PID, pred: (c: Card) => boolean = () => true) => P(g, p).hell.filter((c) => isA(c) && pred(c));
const d6 = (g: Game) => rollDie(g); // emits the 'roll' event
function act(label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct { return { label, can, run }; }
function boost(c: Card, n: number) { c.temp.push({ power: n, until: 'turn' }); }
// สอดแนม / look at the top n: engine scoutDeck() reveals them, lets the human pick and order the rest
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle') {
  scoutDeck(g, p, n, pick, rest);
}
function takeHand(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean) {
  const c = best(list.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  if (c) { list.splice(list.indexOf(c), 1); P(g, p).hand.push(c); }
  return c;
}
function takeSummon(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect', max = 1) {
  let n = 0;
  const pool = [...list].filter(pred);
  while (n < max && canPlaceAvatar(P(g, p))) {
    const c = max > 1 ? pickN(pool, 1, (x) => value(g, x), { optional: true })[0] || null : best(pool, (x) => value(g, x)); // human picks inside scouts
    if (!c) break;
    pool.splice(pool.indexOf(c), 1);
    list.splice(list.indexOf(c), 1);
    c.f.viaScout = 1; P(g, p).hell.push(c); // somewhere findable; summon() detaches it
    if (summon(g, p, c, how)) n++;
  }
  return n;
}
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
  const c = best(zone.filter((x) => isA(x) && pred(x)), (x) => value(g, x));
  if (c && canPlaceAvatar(P(g, p)) && summon(g, p, c, how)) return c;
  return null;
}
function discardWorst(g: Game, p: PID, n: number, except: Card[] = []) {
  for (let i = 0; i < n; i++) {
    const d = worst(P(g, p).hand.filter((x) => !except.includes(x)), (x) => keepValue(g, x));
    if (!d) return false;
    discard(g, p, d);
  }
  return true;
}
function steal(g: Game, p: PID, t: Card) {
  if (t.mods.some((m) => (FX[m.def.name] as any)?.noSteal)) return false;
  if (!canPlaceAvatar(P(g, p))) return false;
  if (!takeControl(g, t, p)) return false;
  log(g, `P${p} takes control of ${t.def.name}`);
  return true;
}
function attach(g: Game, c: Card, w: Card) {
  if (!canChangeCtrl(g, c, w.ctrl)) { log(g, `${c.def.name}: its control can't be changed (รูปประจำบ้าน)`); return; }
  if (!canWear(g, c, w)) { log(g, `${c.def.name} can't be attached to ${w.def.name}`); if (!findCard(g, c.uid)) P(g, c.owner).hell.push(c); return; } // v14d: canWear
  detach(g, c);
  c.asleep = false; c.temp = []; c.wearer = w.uid; c.ctrl = w.ctrl;
  attachCard(g, c, w, false); // v14d: central attach (canWear checked above; onAttach stays with the callers)
}
// flip a LIFE card that is not an attack (nothing happens when all are already face up)
function flipLife(g: Game, p: PID) { if (!critical(P(g, p))) hitLife(g, p, null); }
// would an effect be stopped by the card's own "stay on field" ability (หนุมาน etc.)? Has side effects, so only call when resolving.
function staysOnField(g: Game, by: PID, a: Card) {
  const f = FX[a.def.name];
  return a.ctrl !== by && !!(f && f.preventLeave && !silenced(g, a) && f.preventLeave(g, a));
}
const wins = (g: Game, a: Card, b: Card) => power(g, a) > power(g, b) || (power(g, a) === power(g, b) && hasKw(g, a, 'tieWin') && !hasKw(g, b, 'tieWin'));
// หุ่นพิฆาต 300%: nobody can summon from Deck (v14: enforced for every card by its blockSummon; this is a quick pre-check)
const deckLocked = (g: Game) => g.p.some((q) => q.avatars.some((a) => a.def.name === 'หุ่นพิฆาต 300%' && !silenced(g, a)));
// current Cost of an Avatar on the field (v14: costOf includes ห้างโรงเกลือ / ราชาใบก้อน costMod)
function costNow(g: Game, a: Card) { return costOf(g, a.ctrl, a); }
// Move an Avatar into a Magic Zone under a new name (its own abilities no longer apply there).
// The original Def is kept on the new Def so it can be restored.
function capture(g: Game, toP: PID, t: Card, name: string, print: string, symbol: string) {
  if (!canChangeCtrl(g, t, toP)) { log(g, `${t.def.name}: its control can't be changed (รูปประจำบ้าน)`); return; }
  if (t.token) { toHell(g, t); return; }
  for (const m of [...t.mods]) { detach(g, m); P(g, m.owner).hell.push(m); }
  detach(g, t);
  t.asleep = false; t.temp = []; t.kick = false; t.bonus = 0; t.f = {}; t.silencedTurn = -1; t.magicImmuneUntil = 0; t.noWakeUntil = 0;
  const orig: Def = (t.def as any).orig || t.def;
  t.def = { ...orig, name, print, symbol, orig } as any;
  t.ctrl = toP; P(g, toP).mz.push(t);
  log(g, `${orig.name} is put in P${toP}'s Magic Zone as ${name}`);
}
function restore(c: Card) { const o = (c.def as any).orig; if (o) c.def = o; }
// ตั๋งโต๊ะ: once per turn in our turn when an opponent's Avatar changes state (asleep <-> awake), draw 1.
// v14: the opposing Avatars' states are remembered on ตั๋งโต๊ะ (f['dz:'+uid]) and compared at every check point
// (this group's state changes, โล่มนุษย์ used, after each fight, Battle Phase start, End Phase).
const DONGZHUO = 'ตั๋งโต๊ะ ขุนพลฮ่องเต้ทรราช';
function dzSnap(g: Game, c: Card) {
  for (const k of Object.keys(c.f)) if (k.startsWith('dz:')) delete c.f[k];
  for (const a of P(g, opp(c.ctrl)).avatars) c.f['dz:' + a.uid] = a.asleep ? 1 : 2;
}
function dzCheck(g: Game, c: Card) {
  if (!P(g, c.ctrl).avatars.includes(c) || silenced(g, c)) return;
  if (g.active !== c.ctrl) { dzSnap(g, c); return; }
  const changed = P(g, opp(c.ctrl)).avatars.some((a) => c.f['dz:' + a.uid] !== undefined && c.f['dz:' + a.uid] !== (a.asleep ? 1 : 2));
  dzSnap(g, c);
  if (changed && once(g, c.ctrl, 'dongzhuo')) { use(g, c.ctrl, 'dongzhuo'); log(g, `${DONGZHUO}: an opposing Avatar changed state, draw 1`); draw(g, c.ctrl, 1); }
}
function stateChanged(g: Game, p: PID) {
  for (const a of [...P(g, p).avatars]) if (a.def.name === DONGZHUO) dzCheck(g, a);
}
// GEM payment that adds up to exactly n (every card must have GEM)
function exactPay(g: Game, p: PID, n: number, forCard: Card): Card[] | null {
  const hand = P(g, p).hand.filter((c) => c !== forCard && gemOf(g, c, forCard) > 0).slice(0, 12);
  let bestSet: Card[] | null = null, bv = Infinity;
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    let s = 0, v = 0;
    for (let i = 0; i < hand.length; i++) if (mask & (1 << i)) { s += gemOf(g, hand[i], forCard); v += keepValue(g, hand[i]); }
    if (s !== n || v >= bv) continue;
    bv = v; bestSet = hand.filter((_, i) => mask & (1 << i));
  }
  return bestSet;
}
// ไม้กวาดปีกปักษา: every face-up card of player q in the Magic Zone area: mz cards, q's Modifications on any Avatar, q's Lands
function broomTargets(g: Game, q: PID): Card[] {
  const out: Card[] = P(g, q).mz.filter((x) => !x.f.faceDown);
  for (const pl of g.p) for (const a of pl.avatars) for (const m of a.mods) if (m.ctrl === q && !out.includes(m)) out.push(m);
  for (const l of lands(g)) if (l.ctrl === q && !out.includes(l)) out.push(l);
  return out;
}
// คาถา เสกควายเข้าท้อง: count Avatar destructions by it / by "จอมเวทย์" abilities per player (pl.once is cloned with the game)
function buffaloCount(g: Game, p: PID, gone: Card) {
  const pl = P(g, p), key = gone.uid * 10000 + (g.turn % 10000);
  if (pl.once['buffaloK'] === key) return; // the same destruction seen by another copy
  pl.once['buffaloK'] = key; pl.once['buffaloN'] = (pl.once['buffaloN'] || 0) + 1;
  log(g, `เสกควายเข้าท้อง: destruction ${pl.once['buffaloN']}/3`);
}
const buffaloUp = (g: Game, p: PID) => (P(g, p).once['buffaloN'] || 0) >= 3;
function buffaloField(g: Game, p: PID): Card[] {
  const q = opp(p), out: Card[] = oppTargets(g, p, true);
  for (const a of P(g, q).avatars) for (const m of a.mods) out.push(m);
  for (const pl of g.p) if (pl.id !== q) for (const a of pl.avatars) for (const m of a.mods) if (m.ctrl === q) out.push(m);
  out.push(...P(g, q).mz.filter((x) => !x.f.faceDown));
  for (const l of lands(g)) if (l.ctrl === q) out.push(l);
  return out;
}
// ด่านตรวจเข้าเมือง: a player who summoned more than 2 times this turn loses the Avatars summoned after the 2nd (newest first)
function checkpointTrim(g: Game) {
  for (const q of g.p) {
    const names = turnLog(g).summons[q.id];
    if (names.length <= 2 || q.once['checkTrim'] === g.turn) continue;
    q.once['checkTrim'] = g.turn;
    const done: Card[] = [];
    for (const nm of names.slice(2).reverse()) {
      const a = [...q.avatars].reverse().find((x) => x.def.name === nm && !done.includes(x));
      if (!a) continue;
      done.push(a);
      log(g, `ด่านตรวจเข้าเมือง: ${a.def.name} was summoned after the 2nd summon this turn, it is destroyed`);
      destroy(g, a, null);
    }
  }
}
// มอร์ฟีน: Avatars in either Hell whose owner has room
const morphCands = (g: Game, p: PID) => [...P(g, p).hell, ...P(g, opp(p)).hell].filter((x) => x.def.type === 'Avatar' && canPlaceAvatar(P(g, x.owner), false, x));
RULES['morphine'] = { label: 'revived by มอร์ฟีน: its สั่งใช้ abilities can\'t be used', ability: (g, r, c) => c.uid !== r.n || !c.f.morphNoAct };
const showColor = (g: Game, p: PID, color: string) => P(g, p).hand.some((x) => isA(x) && colorIs(x, color));

const FOREST = 'ป่าพงไพร เผ่าพงศ์พันธุ์';
const forest = (g: Game) => !!landOn(g, FOREST);
const fruit = (c: Card) => isA(c) && named(c, 'ภูติผลไม้');
function fruitFx(extra: Fx): Fx {
  return {
    keep: 2.5, ...extra,
    onSummon: (g, c, how) => { (c as any).forestExile = 0; if (extra.onSummon) extra.onSummon(g, c, how); },
    deathCry: (g, c, owner) => {
      if (extra.deathCry) extra.deathCry(g, c, owner);
      if ((c as any).forestExile && P(g, owner).hell.includes(c)) { (c as any).forestExile = 0; toExile(g, c); }
    },
  };
}

const SERVANT = 'ข้ารับใช้ของ มนุษย์ดาว R18';
const servants = (g: Game, p: PID) => [...P(g, p).avatars, ...P(g, p).mz].filter((x) => isA(x) && named(x, 'ข้ารับใช้'));
let r18Sent = 0; // handoff from กัล's hand ability to its จุติ
let shivaPower = 0; // handoff from พระอิศวร วีลแชร์'s trigger to its own-summon ability

function thorBlast(g: Game, p: PID, lifeIfNone: boolean) {
  const lim = 3 + Math.floor(P(g, p).hell.length / 10);
  const t = best(P(g, opp(p)).avatars.filter((a) => costNow(g, a) <= lim), (a) => value(g, a));
  log(g, `ธอร์ blast (Cost <= ${lim})`);
  if (t && destroy(g, t, p)) return;
  if (lifeIfNone) flipLife(g, opp(p));
}
const THOR = 'ธอร์ บุตรแห่งโอดิน', LOKI = 'โลกิ เจ้าชายยักษ์น้ำแข็ง';
// linkbot: "when ธอร์ or โลกิ enters [Link]" = a ธอร์ / โลกิ of ours that the Link action paired this turn (still in Link)
const linkFormedNow = (g: Game, p: PID) => P(g, p).avatars.some((a) => (named(a, 'ธอร์') || named(a, 'โลกิ')) && a.f.linkTurn === g.turn
  && P(g, p).avatars.some((b) => b !== a && b.f.linkWith === a.uid && a.f.linkWith === b.uid));

// มรดกของพระอิศวร cycle: scout 2 for a colour, stay in the Magic Zone, later destroy it to summon that colour at Cost -2
function legacy(color: string, label: string): Fx {
  const cands = (g: Game, p: PID) => P(g, p).hand.filter((a) => a.def.type === 'Avatar' && colorIs(a, color) && !fx(a)?.noHandSummon
    && !uniqueBlocked(g, p, a) && bestPayment(g, p, Math.max(0, costOf(g, p, a) - 2), [a], a) !== null);
  return {
    keep: 3, stayMz: true,
    canCast: (g, p) => P(g, p).deck.length > 4,
    resolve: (g, p, c) => { c.f.placed = g.turn; peek(g, p, 2, (top) => { takeHand(g, p, top, (x) => colorIs(x, color)); }, 'bottom'); },
    fieldActs: (g, p, c) => [act(`${label}: destroy, summon a ${color} Avatar at Cost -2`, (g2) => inMain(g2, p) && P(g2, p).mz.includes(c)
      && g2.turn > (c.f.placed ?? 1e9) && canPlaceAvatar(P(g2, p)) && cands(g2, p).length > 0,
    (g2) => {
      const a = best(cands(g2, p), (x) => value(g2, x));
      if (!a) return;
      const pay = choosePayment(g2, p, Math.max(0, costOf(g2, p, a) - 2), [a], a);
      if (!pay) return;
      toHell(g2, c);
      summon(g2, p, a, 'paid', pay);
    })],
  };
}

// คุณปลาชด: with บึงทมิฬ as the Land, each player controls only 1 non-ปลา Avatar. v14 ruling: when it arrives each player
// chooses the one to keep and the others are destroyed; afterwards a 2nd non-ปลา Avatar can't be summoned (blockSummon).
const PLACHOD = 'บึงทมิฬ  People - คุณปลาชด';
const fishLand = (g: Game) => lands(g).some((l) => named(l, 'บึงทมิฬ'));
function fishLock(g: Game) {
  if (!fishLand(g)) return;
  if (!g.p.some((q) => q.avatars.some((a) => a.def.name === PLACHOD && !silenced(g, a)))) return;
  for (const q of g.p) {
    const non = q.avatars.filter((a) => !symIs(a, 'ปลา'));
    if (non.length <= 1) continue;
    const keepA = decide(g, q.id, () => askPick(non, non.reduce((m, a) => (value(g, a) > value(g, m) ? a : m)), { title: 'คุณปลาชด: choose the non-ปลา Avatar you keep (the others are destroyed)' })) || non[0];
    for (const a of non) if (a !== keepA && q.avatars.includes(a)) { log(g, `คุณปลาชด: ${a.def.name} is destroyed`); destroy(g, a, null); }
  }
}
const fxWorth = (g: Game, p: PID) => P(g, p).avatars.filter((a) => FX[a.def.name] && !silenced(g, a)).reduce((s, a) => s + value(g, a), 0);
function cutNet(g: Game) { for (const q of g.p) for (const a of q.avatars) silenceFull(g, a); log(g, 'ตัดเน็ต: all Avatars lose their abilities'); }
const seenSummon = new WeakSet<object>();
const overdoseOn = (g: Game, p: PID) => new Set(P(g, p).avatars.filter((a) => named(a, 'Overdose')).map((a) => a.def.name)).size >= 4;

const POJI: [string, (c: Card) => boolean, string][] = [
  ['Avatar', (x) => isA(x), 'เนอร์เกิ้ล'],
  ['Magic', (x) => x.def.type === 'Magic', 'แมวดำ'],
  ['Construct', (x) => x.def.type === 'Construct', 'ปอนด์'],
];

const NEW: Record<string, Fx> = {
  // ===== BT09 Avatars =====
  'พระอิศวร วีลแชร์': {
    keep: 3,
    // v14 ruling: after a "พระอิศวร" on our Avatar Zone was destroyed and is in our Hell (by anyone), a popup asks whether
    // to use it (React window 'destroyed', from hand, not a React use)
    react: {
      on: ['destroyed'], fromHand: true, noLimit: true,
      // other-team audit: any Avatar Zone (ours or the opponent's) as long as it went to OUR Hell
      can: (g, p, c, ev) => !!ev.leave && !!ev.source && ev.source !== c && ev.leave.zone === 'avatars' && ev.leave.to === 'hell'
        && ev.source.owner === p && P(g, p).hell.includes(ev.source) && isA(ev.source) && named(ev.source, 'พระอิศวร') && canPlaceAvatar(P(g, p), false, c),
      want: (g, p) => hellAvatars(g, p, (x) => named(x, 'พระอิศวร')).some((x) => x.def.power >= 4),
      resolve: (g, p, c) => { if (P(g, p).hand.includes(c) && canPlaceAvatar(P(g, p), false, c)) summon(g, p, c, 'own'); },
    },
    onOwnSummon: (g, c) => {
      const h = best(hellAvatars(g, c.ctrl, (x) => named(x, 'พระอิศวร')), (x) => x.def.power);
      if (h) { c.bonus += Math.floor(h.def.power / 2); log(g, `พระอิศวร วีลแชร์: base POWER = half of ${h.def.name} (${Math.floor(h.def.power / 2)})`); }
      const n = power(g, c);
      const t = best(P(g, opp(c.ctrl)).avatars, (a) => value(g, a) + (power(g, a) <= n ? 3 : 0));
      if (t && n > 0) { addPowerE(g, t, -n, 'perm', c); log(g, `พระอิศวร วีลแชร์ (POWER ${n}): ${t.def.name} POWER -${n}`); } // other-team audit: a POWER cut (ยาแก้ไอน้ำดำ sees it)
    },
  },
  'เนอร์เกิ้ล เนียร์ สมาชิกลัทธิแห่หัว': {
    keep: 3,
    // summoned by พี่โปจิ: the text becomes "red แห่หัว ใบอื่น POWER +2" (GET badge on the field Avatar)
    aura: (g, s, t) => (t !== s && t.ctrl === s.ctrl && named(t, 'แห่หัว') && onField(g, s) && P(g, t.ctrl).avatars.includes(t)
      ? (s.f.byPoji ? (colorIs(t, 'แดง') ? 2 : 0) : 1) : 0),
    getActive: (g, s) => !!s.f.byPoji && 'อัญเชิญโดย พี่โปจิ: ต่อเนื่อง Avatar "แห่หัว" สีแดง ใบอื่น POWER +2',
  } as Fx,
  'DJ ปีโป้': {
    keep: 2.5,
    // v14: when the opponent's LIFE is flipped by our Avatar's attack, we say "ขอโทษ" (popup); the opponent may forgive
    // (popup; the bot never forgives): then that LIFE card's ability does not work. ขอโทษสังคม: always forgiven this turn.
    onLifeFlipped: (g, self, p, life, byAttack) => {
      if (!byAttack || p === self.ctrl || !P(g, self.ctrl).avatars.includes(self)) return;
      const fi = currentFight(); if (fi && fi.att.ctrl !== self.ctrl) return;
      const l = P(g, p).life.find((x) => x.card === life);
      if (!l || !l.trig) return; // the LIFE card has no ability to stop
      askChoose(g, `DJ ปีโป้: say "ขอโทษ" to P${p} (${life.def.name})`, ['ขอโทษ (Sorry)'], 0);
      log(g, `DJ ปีโป้: P${self.ctrl} says "ขอโทษ"`);
      const always = P(g, self.ctrl).once['sorryOK'] === g.turn;
      const forgive = always || decide(g, p, () => askChoose(g, `DJ ปีโป้ says "ขอโทษ": forgive? (forgiven = your LIFE card ${life.def.name} does not activate)`, ['ยกโทษให้ (forgive)', 'ไม่ยกโทษ (do not forgive)'], 1) === 0);
      if (forgive) { l.trig = false; log(g, `P${p} forgives${always ? ' (ขอโทษสังคม)' : ''}: ${life.def.name}'s ability does not work`); }
      else log(g, `P${p} does not forgive`);
    },
  },
  'กัณหา นาคเกล็ดดำ': {
    keep: 3.5,
    // v14: POWER 7+ at the start of our Battle Phase -> gains the ability until end of turn (GET badge). When it attacks and
    // destroys an opposing Avatar in that fight: summon a Cost 3 สัตว์มหัศจรรย์ "นาค" from Deck; its own อัตโนมัติ ability
    // turns on at once (f.got7 = this turn, the key the นาค cards use) and it shows GET too.
    startBattle: (g, c) => { if (g.active === c.ctrl && P(g, c.ctrl).avatars.includes(c) && power(g, c) >= 7) { c.f.got7 = g.turn; log(g, `กัณหา: POWER ${power(g, c)} at the start of Battle Phase, gains its ability`); } },
    getActive: (g, c) => c.f.got7 === g.turn && 'POWER 7+: ชนะการต่อสู้ตอนโจมตี -> อัญเชิญ นาค Cost 3 จาก Deck',
    onKill: (g, c) => {
      if (c.f.got7 !== g.turn || currentFight()?.att !== c) return;
      const pl = P(g, c.ctrl);
      const s = fromZoneSummon(g, c.ctrl, pl.deck, (x) => named(x, 'นาค') && costOf(g, c.ctrl, x) === 3 && symIs(x, 'สัตว์มหัศจรรย์'));
      shuffle(g, pl.deck);
      if (s && pl.avatars.includes(s)) { s.f.got7 = g.turn; grantGet(g, s, 'อัญเชิญโดย กัณหา: ความสามารถ อัตโนมัติ ทำงานทันที (จนจบเทิร์น)', g.turn); log(g, `${s.def.name}: its อัตโนมัติ ability turns on (กัณหา)`); }
    },
  } as Fx,
  // กุ่ย/ฮอล/นาย: พอดี is gated by the engine (def.exactKw: จุติ only when GEM paid == Cost)
  'กุ่ย หน้าตาดี': {
    keep: 3, unite: true,
    jutsu: (g, c) => peek(g, c.ctrl, 7, (top) => { takeHand(g, c.ctrl, top, (x) => isA(x) && named(x, 'วีรบุรุษ') && x.def.cost === 6); }),
  },
  'ฮอล หน้าตาดี': {
    keep: 3, unite: true,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      const h = best(pl.hell.filter((x) => isA(x) && named(x, 'วีรบุรุษ') && x.def.cost === 6), (x) => x.def.power);
      if (h) { detach(g, h); pl.deck.push(h); shuffle(g, pl.deck); draw(g, c.ctrl, 1); }
    },
  },
  'นาย หน้าตาดี': {
    keep: 3, unite: true,
    jutsu: (g, c) => { fromZoneSummon(g, c.ctrl, P(g, c.ctrl).hell, (x) => (named(x, 'กุ่ย') || named(x, 'ฮอล')) && x !== c); },
  },
  'เพนกวินหิมะ เหลียง': {
    keep: 3, alias: ['ทหารหิมะ'], // "#" name ทหารหิมะ and Symbol ต่างชาติ are in Def.aka / Def.syms (sim.ts hashStats)
    viewNote: (g, self, t) => (t === self ? 'ถือว่ามีชื่อ "ทหารหิมะ" และเป็น Symbol ต่างชาติ ด้วย · 4 GEM สีฟ้า เมื่อเป็น Cost ของ ราชินีหิมะ' : null),
    gemAs: (g, c, s) => (s && named(s, 'ราชินีหิมะ') ? 4 : c.def.gem),
    fieldActs: (g, p, c) => [act('เหลียง: sacrifice, call ทหารหิมะ from Deck', (g2) => inMain(g2, p) && onField(g2, c) && !deckLocked(g2)
      && P(g2, p).deck.some((x) => isA(x) && named(x, 'ทหารหิมะ') && x.def.power === 2),
    (g2) => {
      const pl = P(g2, p);
      destroy(g2, c, p, false, { cost: true }); // เซ่นไหว้ is a cost
      const royal = hellAvatars(g2, p, (x) => named(x, 'ทหารหิมะ')).length >= 12
        && pl.deck.some((x) => named(x, 'ราชาหิมะ')) && pl.deck.some((x) => named(x, 'ราชินีหิมะ'));
      if (royal && mayDo(g2, c, 'summon ราชาหิมะ and ราชินีหิมะ instead', true)) { fromZoneSummon(g2, p, pl.deck, (x) => named(x, 'ราชาหิมะ')); fromZoneSummon(g2, p, pl.deck, (x) => named(x, 'ราชินีหิมะ')); } // bugs7 item 7: "สามารถ" = optional
      else for (let i = 0; i < 2; i++) fromZoneSummon(g2, p, pl.deck, (x) => named(x, 'ทหารหิมะ') && x.def.power === 2);
      shuffle(g2, pl.deck);
    })],
  },
  'รัททาทุย นินจา': {
    keep: 3,
    // v14 ruling: any way a รัททาทุย / "นินจา" Avatar leaves our Avatar Zone (destroyed, fight, to hand, exile, to Hell,
    // to Deck; by anyone): React window from hand (popup), discard cards with exactly 3 GEM, summon this card.
    react: {
      on: ['destroyed', 'left'], fromHand: true, noLimit: true,
      can: (g, p, c, ev) => !!ev.leave && !!ev.source && ev.source !== c && ev.leave.ctrl === p && ev.leave.zone === 'avatars'
        && (symIs(ev.source, 'รัททาทุย') || nameHas(ev.source, 'นินจา')) && canPlaceAvatar(P(g, p), false, c) && !!exactPay(g, p, 3, c),
      want: (g, p, c) => { const plan = exactPay(g, p, 3, c); return !!plan && plan.reduce((s, x) => s + keepValue(g, x), 0) <= 7; },
      resolve: (g, p, c) => {
        if (!P(g, p).hand.includes(c) || !canPlaceAvatar(P(g, p), false, c)) return;
        const plan = exactPay(g, p, 3, c); if (!plan) return;
        const pay = pickGemExact(g, p, 3, c, plan, 'รัททาทุย นินจา: discard cards with exactly 3 GEM');
        if (!pay) return;
        for (const x of pay) discard(g, p, x);
        log(g, 'รัททาทุย นินจา jumps in');
        summon(g, p, c, 'own');
      },
    },
  },
  'พี่โปจิ เจ้าลัทธิแห่หัว': {
    keep: 4.5,
    fieldActs: (g, p, c) => POJI.map(([lab, kind, who]) => {
      const tgt = (x: Card) => isA(x) && named(x, who) && named(x, 'แห่หัว');
      return act(`พี่โปจิ: exile a ${lab} from Deck, call ${who}`, (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'poji') && !deckLocked(g2)
        && canPlaceAvatar(P(g2, p)) && P(g2, p).deck.some(tgt) && P(g2, p).deck.some((x) => kind(x) && !tgt(x)),
      (g2) => {
        const pl = P(g2, p); use(g2, p, 'poji');
        const ex = worst(pl.deck.filter((x) => kind(x) && !tgt(x)), (x) => keepValue(g2, x));
        if (ex) toExile(g2, ex);
        const s = fromZoneSummon(g2, p, pl.deck, tgt);
        if (s && pl.avatars.includes(s)) s.f.byPoji = 1;
        shuffle(g2, pl.deck);
      });
    }),
  },
  // cards19: BT09-018's real name (picture); the summon lock is g8's alienRule, the hand Cost -2 is g8's costMod on every
  // "ตัวอะไรสักอย่าง" card (read P.onceGame.alienLock)
  'ตัวอะไรสักอย่างที่เป็นมิตรและพูดมาก': {
    keep: 2.5, tieWin: true,
    deathCry: (g, c, owner) => { P(g, owner).onceGame['alienLock'] = true; },
  },
  'หมาป่าเดียวดาย': {
    keep: 5,
    jutsu: (g, c) => {
      if (deckLocked(g)) return;
      const pl = P(g, c.ctrl); let budget = 5;
      while (canPlaceAvatar(pl)) {
        const x = pickN(pl.deck.filter((y) => isA(y) && symIs(y, 'สัตว์') && y.def.cost <= budget), 1, (y) => value(g, y), { optional: true, title: `หมาป่าเดียวดาย: summon a สัตว์ from your Deck (Cost left ${budget})` })[0];
        if (!x) break;
        budget -= x.def.cost; summon(g, c.ctrl, x, 'effect');
      }
      shuffle(g, pl.deck);
    },
    onAttack: (g, c) => {
      const pl = P(g, c.ctrl);
      const n = [...pl.avatars, ...pl.mz].filter((x) => x !== c && symIs(x, 'สัตว์')).length;
      if (n) boost(c, n);
    },
  },
  'กัล มนุษย์ดาว R18': {
    keep: 4,
    handActs: (g, p, c) => [act('กัล: send servants to hell, summon', (g2) => {
      const pl = P(g2, p); const sv = servants(g2, p);
      return inMain(g2, p) && pl.hand.includes(c) && sv.length > 0 && !uniqueBlocked(g2, p, c)
        && (canPlaceAvatar(pl) || sv.some((s) => pl.avatars.includes(s) && !s.token));
    }, (g2) => {
      const sv = pickN(servants(g2, p), 2, (x) => -value(g2, x), { optional: true, title: 'กัล: send up to 2 ข้ารับใช้ to Hell' });
      for (const s of sv) { restore(s); toHell(g2, s); }
      r18Sent = sv.length;
      if (!summon(g2, p, c, 'jutsu')) r18Sent = 0;
    })],
    jutsu: (g, c) => {
      c.bonus += 3 * r18Sent; r18Sent = 0;
      const t = best(P(g, opp(c.ctrl)).avatars.filter((a) => power(g, a) < power(g, c)), (a) => value(g, a));
      if (t && !staysOnField(g, c.ctrl, t)) capture(g, c.ctrl, t, SERVANT, 'R18-SERVANT', 'เอเลี่ยน');
    },
  },
  'คราเค่น ปลาหมึกปีศาจ': {
    keep: 4,
    fieldActs: (g, p, c) => [act('คราเค่น: discard 1, put a POWER 8+ Avatar in their Magic Zone', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'kraken')
      && P(g2, p).hand.length >= 1 && P(g2, opp(p)).avatars.some((a) => power(g2, a) >= 8),
    (g2) => {
      use(g2, p, 'kraken'); discardWorst(g2, p, 1);
      const t = best(P(g2, opp(p)).avatars.filter((a) => power(g2, a) >= 8), (a) => value(g2, a));
      if (t && !staysOnField(g2, p, t)) capture(g2, opp(p), t, t.def.name + ' (คราเค่น)', 'KRAKEN-CAPTIVE', t.def.symbol);
    })],
  },
  // the ability given by คราเค่น to the Avatar it sent to the Magic Zone (GET badge / detail box)
  'KRAKEN-CAPTIVE': {
    getActive: () => 'ได้รับจาก คราเค่น: สั่งใช้ จาก Magic Zone ทิ้งการ์ดบนมือ 2 ใบ : อัญเชิญ Avatar ใบนี้จาก Magic Zone',
    viewNote: (g: Game, self: Card, t: Card) => (t === self ? 'ได้รับ [GET] จาก คราเค่น: สั่งใช้ จาก Magic Zone ทิ้งการ์ดบนมือ 2 ใบ : อัญเชิญ Avatar ใบนี้' : null),
    fieldActs: (g, p, c) => [act('summon back from Magic Zone (discard 2)', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && P(g2, p).hand.length >= 2 && canPlaceAvatar(P(g2, p)),
      (g2) => { if (!discardWorst(g2, p, 2)) return; restore(c); summon(g2, p, c, 'effect'); })],
  },
  'ริน บันนี่เกิร์ล': {
    keep: 3,
    jutsu: (g, c) => {
      const t = best(P(g, opp(c.ctrl)).avatars.filter((a) => power(g, a) === 0), (a) => value(g, a));
      if (t && steal(g, c.ctrl, t)) t.bonus += 1;
    },
  },
  'ธอร์ บุตรแห่งโอดิน': {
    keep: 4.5,
    onKill: (g, c) => { if (linked(g, c, LOKI)) thorBlast(g, c.ctrl, true); },
  },
  'โลกิ เจ้าชายยักษ์น้ำแข็ง': {
    keep: 3,
    // "สามัคคี ... สามารถใช้ความสามารถ สามัคคี ให้กับ ธอร์ ได้เท่านั้น" (v13: canHelp)
    unite: true,
    canHelp: (g, c, att) => named(att, 'ธอร์'),
    onSummon: (g, c) => { c.f.noAttack = g.turn; },
    endPhase: (g, c) => { c.f.noAttack = g.turn + 2; },
    fieldActs: (g, p, c) => [act('โลกิ: POWER up', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'loki:' + c.uid) && linked(g2, c, THOR),
      (g2) => { use(g2, p, 'loki:' + c.uid); boost(c, 1 + Math.floor(P(g2, p).hell.length / 5)); })],
  },
  'มิสเตอร์โบโบ้': {
    keep: 3.5, // พอดี gated by the engine (def.exactKw)
    jutsu: (g, c) => peek(g, c.ctrl, 1, (top) => { if (!deckLocked(g)) takeSummon(g, c.ctrl, top, (x) => isA(x) && symIs(x, 'เทพ'), 'jutsu'); }, 'hell'),
  },
  'แบงค์ ตัวแดง': {
    keep: 3.5,
    // v14: red attackers can't choose it (the attacker is known now). Ruling: an attacker that can choose no Avatar may attack
    // LIFE directly (v14c engine legalTargets).
    untargetable: (g, c, att) => !!att && colorIs(att, 'แดง'),
    onAttack: (g, c, t) => { if (t && colorIs(t, 'แดง') && linked(g, c, 'สตางค์น้องชายแบงค์')) removeOpp(g, c.ctrl, t, 'hell', false); },
  },
  'สตางค์น้องชายแบงค์ ตัวเขียว': {
    keep: 3, unite: true,
    untargetable: (g, c, att) => !!att && colorIs(att, 'เขียว'),
  },
  'วินดิโก้': {
    keep: 5, noHandSummon: true,
    // "#can't be summoned except by its own ability" (v14 ruling: no other way at all)
    summonIf: (g, p, c, how) => how === 'own',
    react: {
      on: ['summon'], noLimit: true, fromHand: true,
      // v14: the turn log counts every summon of the opponent this turn (tokens too)
      can: (g, p, c, ev) => ev.actor !== p && turnLog(g).summons[ev.actor].length >= 3 && canPlaceAvatar(P(g, p), false, c),
      want: (g, p, c, ev) => P(g, ev.actor).avatars.length >= 2,
      resolve: (g, p, c) => { if (P(g, p).hand.includes(c)) summon(g, p, c, 'own'); },
    },
    onSummon: (g, c) => {
      const o = P(g, opp(c.ctrl));
      if (!o.avatars.length) return;
      const keepA = oppChoice(g, c.ctrl, () => best(o.avatars, (a) => value(g, a)))!; // the opponent picks the one they keep
      log(g, `วินดิโก้: P${opp(c.ctrl)} keeps only ${keepA.def.name}`);
      for (const a of [...o.avatars]) if (a !== keepA) removeOpp(g, c.ctrl, a, 'hell', false);
    },
  },
  'สกินวอคเกอร์': {
    keep: 3,
    // v14: copies name, Cost, GEM, Symbol and POWER of the chosen opposing Avatar until end of turn (view.ts overrides;
    // its own text stays: FX lookup uses the printed name)
    fieldActs: (g, p, c) => [act('สกินวอคเกอร์: copy an opponent Avatar', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'skin:' + c.uid)
      && P(g2, opp(p)).avatars.length > 0,
    (g2) => {
      use(g2, p, 'skin:' + c.uid);
      const t = best(P(g2, opp(p)).avatars, (a) => power(g2, a));
      if (!t || !onField(g2, c)) return;
      const pw = power(g2, t), nm = t.def.name, cost = costOf(g2, t.ctrl, t), gem = gemOf(g2, t, null), syms = symbolsOf(t);
      setName(g2, c, nm, g2.turn); setCost(g2, c, cost, g2.turn); setSymbols(g2, c, syms, g2.turn);
      c.f.skinGem = gem; c.f.skinT = g2.turn;
      boost(c, pw - power(g2, c));
      log(g2, `สกินวอคเกอร์ copies ${nm}: Cost ${cost}, GEM ${gem}, POWER ${pw}`);
    })],
    gemAs: (g, c) => (c.f.skinT === g.turn && c.f.skinGem !== undefined ? c.f.skinGem : c.def.gem),
  },
  'ปอนด์ สมาชิกลัทธิแห่หัว': {
    keep: 3,
    fieldActs: (g, p, c) => [act('ปอนด์: exile 1 from hell, shield + ลูกฮึด', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'pond:' + c.uid)
      && P(g2, p).hell.length > 0 && onZone(g2, p, 'แห่หัว').length > 0,
    (g2) => {
      use(g2, p, 'pond:' + c.uid);
      const x = worst(P(g2, p).hell, (y) => keepValue(g2, y)); if (x) toExile(g2, x);
      const t = best(onZone(g2, p, 'แห่หัว'), (a) => value(g2, a));
      if (!t) return;
      grantKw(g2, t, 'tieWin', g2.turn + 1); grantKw(g2, t, 'shield', g2.turn + 1); // until the end of the opponent's turn
      if (c.f.byPoji) t.magicImmuneUntil = Math.max(t.magicImmuneUntil, g2.turn + 1);
    })],
  },
  'เนฟิล ยักษ์ตัวสุดท้าย': {
    keep: 6,
    // other Avatars are sent to hell when it arrives (and at our End Phase, e.g. stolen ones); v14 ruling: while it is on our
    // Avatar Zone we can't summon any other Avatar (blockSummon). POWER loss after fights it wins (user: correct);
    // "#can't wear cards" = Def.noWear.
    blockSummon: (g, self, p) => p === self.ctrl && P(g, p).avatars.includes(self),
    onSummon: (g, c) => { for (const a of [...P(g, c.ctrl).avatars]) if (a !== c) toHell(g, a); },
    endPhase: (g, c) => { for (const a of [...P(g, c.ctrl).avatars]) if (a !== c) toHell(g, a); },
    onKill: (g, c, v, vp) => { c.bonus -= vp; log(g, `เนฟิล POWER -${vp}`); if (power(g, c) <= 0) destroy(g, c, null); },
    deathCry: (g, c, owner) => flipLife(g, owner),
  },
  'ภูติผลไม้ มะม่วง': fruitFx({ kwIf: (g, c, kw) => kw === 'shield' && forest(g) }),
  'ภูติผลไม้ มะเหมี่ยว': fruitFx({
    deathCry: (g, c, owner) => {
      if (!forest(g)) return;
      const h = best(P(g, owner).hand.filter((x) => fruit(x) && x.def.name !== 'ภูติผลไม้ มะเหมี่ยว'), (x) => x.def.power);
      if (h && canPlaceAvatar(P(g, owner))) summon(g, owner, h, 'effect');
      draw(g, owner, 1);
    },
  }),
  'ภูติผลไม้ มะเฟือง': fruitFx({ kickIf: (g, c) => forest(g) && P(g, opp(c.ctrl)).life.some((l) => !l.faceUp) }),
  'ภูติผลไม้ มะขาม': fruitFx({
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (P(g, p).deck.some((x) => x.def.name === FOREST)) search(g, p, (x) => x.def.name === FOREST, 'deck');
      else search(g, p, (x) => x.def.name === FOREST, 'hell');
    },
  }),
  'ท้าวเวสสุวรรณ': {
    keep: 5,
    // v14 ruling: after our {ยักษ์} Avatar was destroyed by an opposing card (fight included) and is in Hell: React window from
    // hand (popup), summon this card by its own ability.
    react: {
      on: ['destroyed'], fromHand: true, noLimit: true,
      can: (g, p, c, ev) => !!ev.leave && !!ev.source && ev.source !== c && ev.leave.ctrl === p && ev.leave.zone === 'avatars'
        && ev.leave.by === opp(p) && symIs(ev.source, 'ยักษ์') && canPlaceAvatar(P(g, p), false, c),
      want: () => true,
      resolve: (g, p, c) => { if (P(g, p).hand.includes(c) && canPlaceAvatar(P(g, p), false, c)) summon(g, p, c, 'own'); },
    },
    onOwnSummon: (g, c) => {
      const t = pickN(P(g, opp(c.ctrl)).avatars, 1, (a) => value(g, a), { optional: true, title: 'ท้าวเวสสุวรรณ: you may destroy 1 opposing Avatar' })[0];
      if (t) destroy(g, t, c.ctrl);
    },
    aura: (g, s, t) => (g.phase === 'Battle' && t.ctrl === s.ctrl && symIs(t, 'ยักษ์') && onField(g, s) && P(g, t.ctrl).avatars.includes(t) ? 2 : 0),
  },

  // ===== BT09 Magic =====
  // this turn DJ ปีโป้'s "ขอโทษ" is always forgiven (read by DJ ปีโป้'s onLifeFlipped); GEM only for DJ ปีโป้
  'ขอโทษสังคม': {
    keep: 1.5, costOnlyFor: (s) => s.def.name === 'DJ ปีโป้',
    canCast: (g, p) => g.active === p && P(g, p).avatars.some((a) => a.def.name === 'DJ ปีโป้') && P(g, opp(p)).life.some((l) => !l.faceUp && !!l.card.def.life),
    resolve: (g, p) => { P(g, p).once['sorryOK'] = g.turn; log(g, `ขอโทษสังคม: this turn P${p}'s DJ ปีโป้ is always forgiven`); },
  },
  'บลัดดี้แมรี่': {
    keep: 2, stayMz: true,
    canCast: (g, p) => !P(g, p).mz.some((x) => x.def.name === 'บลัดดี้แมรี่'),
    resolve: (g, p, c) => { c.f.mary = 0; },
    fieldActs: (g, p, c) => [act('บลัดดี้แมรี่: roll 2 dice', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'mary')
      && P(g2, p).hell.some((x) => x.def.name === 'วิญญาณร้าย'),
    (g2) => {
      use(g2, p, 'mary');
      const a = d6(g2), b = d6(g2);
      log(g2, `บลัดดี้แมรี่ rolls ${a} and ${b}`);
      if (a % 2 || b % 2) return;
      const s = P(g2, p).hell.find((x) => x.def.name === 'วิญญาณร้าย');
      if (!s) return;
      toExile(g2, s); c.f.mary = (c.f.mary || 0) + 1;
      if (c.f.mary >= 3) lose(g2, opp(p), 'บลัดดี้แมรี่ exiled 3 วิญญาณร้าย');
    })],
  },
  'ไม้กวาดปีกปักษา': {
    keep: 3,
    // v14 ruling: destroys every face-up card in the opponent's Magic Zone: Constructs, staying Magic, Avatars put there,
    // their Modifications (on any Avatar) and their Land(s). Then may draw 1 per 2 destroyed.
    canCast: (g, p) => broomTargets(g, opp(p)).length > 0,
    resolve: (g, p, c) => {
      let n = 0;
      for (const x of broomTargets(g, opp(p))) {
        if (!fieldZone(g, x)) continue;
        const ok = x.def.type === 'Construct' ? destroy(g, x, p, true) : toHell(g, x, { by: p, viaMagic: true });
        if (ok) { n++; restore(x); }
      }
      log(g, `ไม้กวาดปีกปักษา destroyed ${n} card(s)`);
      const k = Math.floor(n / 2);
      if (k > 0 && mayDo(g, c, `draw ${k}`, P(g, p).deck.length > k + 3)) draw(g, p, k);
    },
  },
  'ขอให้ตีนไม่ติดพื้น': {
    keep: 4,
    canCast: (g, p) => P(g, p).avatars.some((a) => symIs(a, 'ฤษี')) && oppTargets(g, p, true).length > 0,
    resolve: (g, p) => { const t = best(oppTargets(g, p, true), (a) => value(g, a)); if (t) removeOpp(g, p, t, 'hand', true); },
  },
  'แผนการตู้เย็นทับ': {
    keep: 3.5,
    canCast: (g, p) => {
      const cp = Math.max(-1, ...P(g, p).mz.filter((x) => x.def.type === 'Construct').map((x) => x.def.power));
      return oppTargets(g, p, true).some((a) => power(g, a) <= cp);
    },
    resolve: (g, p) => {
      const cp = Math.max(-1, ...P(g, p).mz.filter((x) => x.def.type === 'Construct').map((x) => x.def.power));
      const t = best(oppTargets(g, p, true).filter((a) => power(g, a) <= cp), (a) => value(g, a));
      if (t) destroy(g, t, p, true);
    },
  },
  'คาถา เสกควายเข้าท้อง': {
    keep: 5,
    // v14: after 3 Avatar destructions by this card or by "จอมเวทย์" abilities (counted per player, buffaloKills), the
    // text is upgraded (detail-box note "ได้รับ [GET]"): exile 1 opposing field card and/or 1 card in their Hell and/or
    // 1 random card from their hand.
    canCast: (g, p) => onZone(g, p, 'จอมเวทย์').length > 0 && (buffaloUp(g, p)
      ? buffaloField(g, p).length + P(g, opp(p)).hell.length + P(g, opp(p)).hand.length > 0
      : oppTargets(g, p, true).some((a) => power(g, a) <= 4)),
    resolve: (g, p, c) => {
      if (buffaloUp(g, p)) {
        const o = P(g, opp(p));
        const f = pickN(buffaloField(g, p), 1, (x) => (isA(x) ? value(g, x) : keepValue(g, x)), { optional: true, title: 'เสกควายเข้าท้อง: exile 1 card on the opposing field (optional)' })[0];
        if (f) toExile(g, f, { by: p, viaMagic: true });
        const h = pickN(o.hell, 1, (x) => keepValue(g, x), { optional: true, title: 'เสกควายเข้าท้อง: exile 1 card in the opposing Hell (optional)' })[0];
        if (h) { detach(g, h); P(g, h.owner).exile.push(h); log(g, `exile ${h.def.name} from Hell`); }
        if (o.hand.length && mayDo(g, c, 'exile 1 random card from the opposing hand', true)) {
          const r = o.hand[Math.floor(rand(g) * o.hand.length)];
          detach(g, r); P(g, r.owner).exile.push(r); log(g, `exile ${r.def.name} from P${opp(p)}'s hand (random)`);
        }
        return;
      }
      const ts = oppTargets(g, p, true).filter((a) => power(g, a) <= 4).slice(0, 8);
      let pick: Card[] = [], bv = 0;
      for (let mask = 1; mask < 1 << ts.length; mask++) {
        const set = ts.filter((_, i) => mask & (1 << i));
        if (set.reduce((s, a) => s + power(g, a), 0) > 4) continue;
        const v = set.reduce((s, a) => s + value(g, a), 0);
        if (v > bv) { bv = v; pick = set; }
      }
      // the human picks one at a time while the POWER total stays at 4 or less
      if (humanDeciding(g)) {
        pick = []; let sum = 0;
        for (;;) {
          const x = pickN(ts.filter((a) => !pick.includes(a) && sum + power(g, a) <= 4), 1, (a) => value(g, a), { optional: true, title: `เสกควายเข้าท้อง: destroy (POWER total ${sum}/4)` })[0];
          if (!x) break; pick.push(x); sum += power(g, x);
        }
      }
      for (const a of pick) if (destroy(g, a, p, true)) buffaloCount(g, p, a);
    },
    // destructions by "จอมเวทย์" abilities are seen by copies in hand / Hell (the card's own ones are counted in resolve)
    onAnyDestroyed: (g, self, gone, info) => {
      const src = info.src;
      if (!src || src.def.name === 'คาถา เสกควายเข้าท้อง' || info.battle || info.zone !== 'avatars' || !isA(gone)) return;
      if (src.ctrl !== self.owner || !nameHas(src, 'จอมเวทย์')) return;
      buffaloCount(g, self.owner, gone);
    },
    viewNote: (g, self, t) => (t === self && buffaloUp(g, self.owner) ? 'ได้รับ [GET] (ทำลายครบ 3 ครั้ง): เนรเทศ การ์ดบนสนามฝ่ายตรงข้าม 1 ใบ และ/หรือ การ์ดในนรกฝ่ายตรงข้าม 1 ใบ และ/หรือ สุ่มเนรเทศ การ์ดบนมือฝ่ายตรงข้าม 1 ใบ'
      : t === self ? `ทำลายแล้ว ${P(g, self.owner).once['buffaloN'] || 0}/3 ครั้ง` : null),
  } as Fx,
  'Ah-ah, ah!': {
    keep: 3.5, options: 2,
    canCast: (g, p, c, o) => P(g, p).deck.length > 8 && canPlaceAvatar(P(g, p))
      && P(g, p).avatars.some((a) => named(a, o === 0 ? 'ธอร์' : 'โลกิ'))
      && [...P(g, p).hell, ...P(g, p).deck].some((x) => isA(x) && named(x, o === 0 ? 'โลกิ' : 'ธอร์')),
    resolve: (g, p, c, o) => {
      mill(g, p, 5); // v14: แร้งทึ้งศพ sees every mill through onMill
      if (P(g, p).avatars.some((a) => named(a, o === 0 ? 'ธอร์' : 'โลกิ'))) fromZoneSummon(g, p, P(g, p).hell, (x) => named(x, o === 0 ? 'โลกิ' : 'ธอร์'));
    },
  },
  'ทะลุบ้านทะลุโกศ': {
    keep: 3,
    react: {
      on: ['fight'],
      can: (g, p, c, ev) => !!ev.target && !!ev.source && ev.target.ctrl === p && power(g, ev.target) >= 8 && !critical(P(g, opp(p))),
      want: (g, p, c, ev) => wins(g, ev.target!, ev.source!),
      // LIFE is flipped when the React resolves if our Avatar is winning the fight at that moment (user: correct)
      resolve: (g, p, c, ev) => { if (ev.target && ev.source && P(g, p).avatars.includes(ev.target) && wins(g, ev.target, ev.source)) flipLife(g, opp(p)); },
    },
  },
  'ตัดเน็ต': {
    keep: 3,
    // in our turn the bot casts it at the start of Battle Phase; in the opponent's turn it answers their first attack (user: correct)
    battleUse: (g, p) => !P(g, p).used.React && fxWorth(g, opp(p)) > fxWorth(g, p) + 3,
    resolve: (g) => cutNet(g),
    react: {
      on: ['attack'],
      can: (g, p, c, ev) => ev.actor !== p,
      want: (g, p) => fxWorth(g, opp(p)) > fxWorth(g, p) + 3,
      resolve: (g) => cutNet(g),
    },
  },
  'ลงกาโพรเทคชั่น': {
    keep: 3,
    react: {
      on: ['fight'],
      can: (g, p, c, ev) => !!ev.target && !!ev.source && ev.target.ctrl === p && symIs(ev.target, 'ยักษ์')
        && P(g, p).avatars.some((a) => a !== ev.target && !a.asleep && symIs(a, 'ยักษ์')),
      want: (g, p, c, ev) => {
        if (wins(g, ev.target!, ev.source!)) return false;
        const h = P(g, p).avatars.filter((a) => a !== ev.target && !a.asleep && symIs(a, 'ยักษ์'));
        return power(g, ev.target!) + Math.max(...h.map((a) => power(g, a))) > power(g, ev.source!);
      },
      resolve: (g, p, c, ev) => {
        const h = best(P(g, p).avatars.filter((a) => a !== ev.target && !a.asleep && symIs(a, 'ยักษ์')), (a) => power(g, a));
        if (h && ev.target && P(g, p).avatars.includes(ev.target)) { const n = power(g, h); h.asleep = true; ev.target.temp.push({ power: n, until: 'battle' }); }
      },
    },
  },
  'ค้อนโยเนียร์': {
    keep: 3,
    canCast: (g, p) => onZone(g, p, 'ธอร์').length > 0,
    modTarget: (g, p) => best(onZone(g, p, 'ธอร์'), (a) => value(g, a)),
    modPower: () => 1,
    // "enters Link" = ธอร์ and โลกิ both on our zone and one of them was summoned this turn (user: correct)
    hellActs: (g, p, c) => [act('ค้อนโยเนียร์: to Deck bottom, destroy', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c) && once(g2, p, 'mjolnir')
      && linkFormedNow(g2, p) && P(g2, opp(p)).avatars.length > 0,
    (g2) => { use(g2, p, 'mjolnir'); detach(g2, c); P(g2, p).deck.push(c); thorBlast(g2, p, false); })],
  },
  'กระสอบ': {
    keep: 2.5,
    // v14 ruling: the wearer stays awake but can't attack (f.noAttack, renewed every turn); in the 4th End Phase after it was
    // used (the End Phase of the turn it was cast counts as the 1st) this card goes to Hell.
    canCast: (g, p) => oppTargets(g, p, true).length > 0,
    modTarget: (g, p) => best(oppTargets(g, p, true), (a) => power(g, a) + (a.asleep ? 0 : 3)),
    onAttach: (g, m, w) => { m.f.sackEnd = 0; w.f.noAttack = g.turn; },
    eachEndPhase: (g, m) => {
      const w = m.wearer >= 0 ? findCard(g, m.wearer) : null;
      m.f.sackEnd = (m.f.sackEnd || 0) + 1;
      if (m.f.sackEnd >= 4) { log(g, 'กระสอบ: 4th End Phase, it goes to Hell'); toHell(g, m); return; }
      if (w) w.f.noAttack = g.turn + 1;
    },
    getFor: (g, m, t) => (t.mods.includes(m) ? `กระสอบ: โจมตีไม่ได้ (End Phase ${(m.f.sackEnd || 0)}/4)` : false),
  } as Fx,
  'หอกศักดิ์สิทธิ์ เอ็ดดา': {
    keep: 2.5,
    canCast: (g, p) => onZone(g, p, 'เทพธิดาแห่งวัลฮัลลา').length > 0,
    modTarget: (g, p) => best(onZone(g, p, 'เทพธิดาแห่งวัลฮัลลา'), (a) => value(g, a)),
    modPower: () => 1,
    onMilled: (g, c, p) => {
      if (!P(g, p).hell.includes(c)) return;
      const w = pickN(onZone(g, p, 'เทพธิดาแห่งวัลฮัลลา'), 1, (a) => value(g, a), { optional: true, title: 'เอ็ดดา: you may attach it to a เทพธิดาแห่งวัลฮัลลา' })[0]; // bugs7 item 7: "สามารถ" = optional
      if (w) attach(g, c, w);
    },
  },
  'กระบองตำรวจ': {
    keep: 2,
    canCast: (g, p) => P(g, p).avatars.some((a) => named(a, 'ตำรวจ')),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => named(a, 'ตำรวจ')), (a) => value(g, a)),
    onWearerKill: (g, m, w) => {
      const o = P(g, opp(w.ctrl));
      const x = worst(o.hell, (y) => keepValue(g, y)); // a weak card on top clogs their next draw
      if (x) { detach(g, x); o.deck.unshift(x); }
    },
  },
  // v14 ruling: every player may summon only 2 times per turn (blockSummon). If a player already summoned more this turn when
  // it arrives, the later ones are destroyed at once (v14c onEnterPlay; Battle start / End Phase checks stay as a safety net).
  'ด่านตรวจเข้าเมือง': {
    keep: 1.5, canCast: (g, p) => !g.land || g.land.owner !== p,
    blockSummon: (g, self, p, c) => isLandOn(g, self) && turnLog(g).summons[p].length >= 2 && !(c && c.f && c.f.swapT === g.turn), // other-team audit Q8: swap not counted
    onEnterPlay: (g, self) => checkpointTrim(g),
    startBattle: (g, self) => checkpointTrim(g),
    eachEndPhase: (g, self) => checkpointTrim(g),
  },
  'ป่าพงไพร เผ่าพงศ์พันธุ์': {
    keep: 3,
    canCast: (g, p) => (!g.land || g.land.owner !== p) && [...P(g, p).avatars, ...P(g, p).hand, ...P(g, p).hell].some(fruit),
    landPower: (g, l, a) => (fruit(a) ? 2 : 0),
    grant: (g, s, t, kw) => kw === 'unite' && fruit(t), // "Avatar ภูติผลไม้ POWER +2 และได้รับ ความสามารถ สามัคคี" (v13: Lands grant keywords)
    fieldActs: (g, p, c) => [act('ป่าพงไพร: exile Deck top, revive ภูติผลไม้', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'forest')
      && P(g2, p).deck.length > 3 && hellAvatars(g2, p, fruit).length > 0 && canPlaceAvatar(P(g2, p)),
    (g2) => {
      use(g2, p, 'forest');
      const top = P(g2, p).deck[0]; if (top) toExile(g2, top);
      const s = fromZoneSummon(g2, p, P(g2, p).hell, fruit);
      if (s && P(g2, p).avatars.includes(s)) (s as any).forestExile = 1;
    })],
  },
  // ===== BT09 Constructs =====
  'โพเดียมสมาคมผู้รู้ความจริง': {
    keep: 1.5,
    fieldActs: (g, p, c) => [act('โพเดียม: swap a hand card with Deck top', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'podium')
      && onZone(g2, p, 'ผู้รู้ความจริง').length > 0 && P(g2, p).hand.length > 0 && P(g2, p).deck.length > 0,
    (g2) => {
      use(g2, p, 'podium');
      const pl = P(g2, p);
      const h = worst(pl.hand, (x) => keepValue(g2, x)); const top = pl.deck.shift();
      if (!h || !top) { if (top) pl.deck.unshift(top); return; }
      detach(g2, h); pl.deck.unshift(h); pl.hand.push(top);
    })],
  },
  // v14 ruling: any {ฤษี} Magic used by either player (Normal, React, Modification, Land): draw 1
  'สำนักภฤคุ': { keep: 1.5, onAnyMagic: (g, s, m) => { if (P(g, s.ctrl).mz.includes(s) && symIs(m, 'ฤษี')) { log(g, `สำนักภฤคุ: ${m.def.name} is a ฤษี Magic, draw 1`); draw(g, s.ctrl, 1); } } },
  // v14 ruling: any "ริกกี้" Avatar on our zone that destroys an opposing Avatar in a fight (once per turn): return a
  // หนังมนุษย์ ชุดแก้แค้น from our Hell to the Deck and shuffle
  'ตู้เสื้อผ้าของริกกี้': {
    keep: 1,
    onAnyDestroyed: (g, s, gone, info) => {
      const p = s.ctrl, pl = P(g, p), fi = currentFight();
      if (!pl.mz.includes(s) || !info.battle || info.ctrl === p || info.zone !== 'avatars' || !fi) return;
      const ricky = [fi.att, fi.target].find((x) => !!x && x !== gone && x.ctrl === p && nameHas(x, 'ริกกี้'));
      if (!ricky || !once(g, p, 'wardrobe')) return;
      const h = pl.hell.find((x) => x.def.name === 'หนังมนุษย์ ชุดแก้แค้น');
      if (!h) return;
      use(g, p, 'wardrobe'); detach(g, h); pl.deck.push(h); shuffle(g, pl.deck);
      log(g, `ตู้เสื้อผ้าของริกกี้: ${ricky.def.name} won, หนังมนุษย์ ชุดแก้แค้น goes back into the Deck`);
    },
  },
  // ต่อเนื่อง: opposing field Avatars Cost -1 (v14 costMod: every rule check and the detail box "Cost now (printed)")
  'ห้างโรงเกลือ': { keep: 1, costMod: (g, self, t) => (P(g, self.ctrl).mz.includes(self) && t.ctrl !== self.ctrl && P(g, t.ctrl).avatars.includes(t) ? -1 : 0) } as Fx,

  // ===== CC02 =====
  'มหาราชาสีนิล': {
    keep: 6, tieWin: true, shield: true,
    battle: (g, c) => { c.temp.push({ power: 2, until: 'battle' }); },
    // v14 ruling: "destroyed from battle" = it lost a fight (also when a Magic lowered its POWER first); a Magic that removes
    // it directly (เจ้ากล้าดียังไง) is not a fight. Optional (popup): send all its Modifications to Hell, it stays.
    leaveGuard: (g, self, t, info) => (t === self && info.how === 'destroy' && info.battle && self.mods.length > 0
      ? { label: 'send all its Modifications to Hell so it is not destroyed', want: true,
        run: () => { for (const m of [...self.mods]) toHell(g, m, { cost: true }); log(g, 'มหาราชาสีนิล drops its Modifications to survive'); return true; } }
      : null),
    deathCry: (g, c, owner) => { for (const a of P(g, owner).avatars) a.bonus += 1; },
  },
  'นักดาบตะวันแดง': {
    keep: 4, // when it wins a fight as the defender (user: correct). "#" Symbol หุ่นยนต์ = Def.syms (rules + detail box note)
    viewNote: (g, self, t) => (t === self ? 'ถือว่าเป็น Symbol หุ่นยนต์ ด้วย' : null),
    onKill: (g, c) => { if (g.active === c.ctrl) return; const t = best(P(g, opp(c.ctrl)).avatars, (a) => value(g, a)); if (t) destroy(g, t, c.ctrl); },
  },
  'หมีบราซิล': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (!showColor(g, p, 'แดง')) return;
      const m = chooseMode(g, c, ['An Avatar of ours POWER +2', 'Draw 2, discard 1'], pl.hand.length <= 3 && pl.deck.length > 5 ? 1 : 0);
      if (m === 1) { draw(g, p, 2); discardWorst(g, p, 1); }
      else { const t = best(pl.avatars, (a) => value(g, a) + (a.asleep ? 0 : 2)); if (t) t.bonus += 2; }
    },
  },
  'ซุส เทพเจ้าสูงสุดแห่งโอลิมปัส': {
    keep: 6,
    jutsu: (g, c) => { for (let i = 0; i < 2; i++) search(g, c.ctrl, () => true, 'deck'); },
  },
  'ไอ้ชนหมา': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const fod = worst(pl.avatars.filter((a) => a !== c && symIs(a, 'สัตว์')), (a) => value(g, a));
      if (!fod || !mayDo(g, c, `เซ่นไหว้ ${fod.def.name} to scout 7`, value(g, fod) <= 6) || !destroy(g, fod, p)) return;
      peek(g, p, 7, (top) => {
        const pick = best(top.filter((x) => isA(x) && x.def.cost <= 5), (x) => value(g, x));
        if (!pick) return;
        top.splice(top.indexOf(pick), 1);
        if (pick.def.cost <= 2 && canPlaceAvatar(pl) && !deckLocked(g) && mayDo(g, pick, 'summon it instead (Cost 2 or less)', true)) { pl.hell.push(pick); summon(g, p, pick, 'effect'); }
        else pl.hand.push(pick);
      });
    },
  },
  [PLACHOD]: {
    keep: 3, onSummon: (g) => fishLock(g), endPhase: (g) => fishLock(g),
    blockSummon: (g, self, p, c) => P(g, self.ctrl).avatars.includes(self) && fishLand(g) && !symIs(c, 'ปลา')
      && P(g, p).avatars.some((a) => !symIs(a, 'ปลา')),
  },
  'หมีขาว': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (!showColor(g, p, 'ฟ้า')) return;
      const m = humanDeciding(g) ? chooseMode(g, c, ['Scout 5: summon an Avatar Cost 3 or less', 'Scout 5: an Avatar to hand'], 0) : -1;
      peek(g, p, 5, (top) => {
        if (m === 0 || (m < 0 && top.some((x) => isA(x) && x.def.cost <= 3) && canPlaceAvatar(P(g, p)) && !deckLocked(g))) { if (canPlaceAvatar(P(g, p)) && !deckLocked(g)) takeSummon(g, p, top, (x) => isA(x) && x.def.cost <= 3); }
        else takeHand(g, p, top, isA);
      });
    },
  },
  'เตียวเสียน จันทร์หลบโฉมสุดา': {
    keep: 3,
    untargetable: (g, c) => P(g, c.ctrl).avatars.some((a) => a !== c && named(a, 'ขุนพล') && colorIs(a, 'ม่วง') && symIs(a, 'ต่างชาติ')),
    fieldActs: (g, p, c) => [act('เตียวเสียน: wake all opponent Avatars', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'diaochan') && P(g2, opp(p)).avatars.some((a) => a.asleep),
      (g2) => {
        use(g2, p, 'diaochan');
        for (const a of P(g2, opp(p)).avatars) a.asleep = false;
        stateChanged(g2, p);
      })],
  },
  'ตั๋งโต๊ะ ขุนพลฮ่องเต้ทรราช': {
    keep: 4,
    // v14: the returned card gets Cost -3 in hand until end of turn (setCost: the detail box shows "now (printed)").
    // Draw trigger: see dzCheck (states compared after this group's effects, โล่มนุษย์, each fight, Battle start, End Phase).
    jutsu: (g, c) => {
      const x = search(g, c.ctrl, (x) => isA(x) && named(x, 'ขุนพล') && colorIs(x, 'ม่วง') && symIs(x, 'ต่างชาติ') && x.def.name !== c.def.name, 'hell');
      if (x && P(g, c.ctrl).hand.includes(x)) { const n = Math.max(0, costOf(g, c.ctrl, x) - 3); setCost(g, x, n, g.turn); log(g, `${x.def.name}: Cost ${n} in hand this turn (ตั๋งโต๊ะ)`); }
    },
    onSummon: (g, c) => dzSnap(g, c),
    drawPhase: (g, c) => dzSnap(g, c), // start of our turn (no ability window)
    onShieldUsed: (g, s) => dzCheck(g, s),
    afterFight: (g, s) => dzCheck(g, s),
    startBattle: (g, s) => dzCheck(g, s),
    eachEndPhase: (g, s) => dzCheck(g, s),
    afterAction: (g, s) => dzCheck(g, s), // v14c: after every action / effect: draw at once
  },
  // v14 ruling: every ธรณีสูบ (either Deck, any card) while this is on the Avatar Zone: draw 1, once per turn
  'แร้งทึ้งศพ': {
    keep: 2,
    onMill: (g, self) => {
      if (!P(g, self.ctrl).avatars.includes(self) || !once(g, self.ctrl, 'vulture:' + self.uid)) return;
      use(g, self.ctrl, 'vulture:' + self.uid); log(g, 'แร้งทึ้งศพ: a ธรณีสูบ happened, draw 1'); draw(g, self.ctrl, 1);
    },
  },
  'มอร์ฟีน Overdose': {
    keep: 6,
    // simplify1 (exact): while 4 differently named Overdose are on our Avatar Zone, the opponent can't use React or Normal
    // Magic at all (v14 blockCast: not offered, in any turn or window; they can still be paid as GEM)
    blockCast: (g: Game, self: Card, p: PID, m: Card) => p !== self.ctrl && P(g, self.ctrl).avatars.includes(self) && overdoseOn(g, self.ctrl)
      && (m.def.subtype === 'Normal' || m.def.subtype === 'React'),
    // v14 ruling: revive from either player's Hell, onto its owner's Avatar Zone; an opposing one can't use สั่งใช้
    // (timed rule 'morphine' on its uid, while it stays on the field). The bot only revives its own (Cost 4+).
    fieldActs: (g, p, c) => [act('มอร์ฟีน: flip own LIFE, revive an Avatar', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'morphine')
      && P(g2, p).life.some((l) => !l.faceUp) && morphCands(g2, p).length > 0
      && (humanDeciding(g2) || (flippedLife(P(g2, p)) <= 2 && morphCands(g2, p).some((x) => x.owner === p && x.def.cost >= 4))),
    (g2) => {
      use(g2, p, 'morphine'); flipLifeCard(g2, p);
      if (g2.winner !== null) return;
      const x = best(morphCands(g2, p), (y) => (y.owner === p ? value(g2, y) : -value(g2, y) - 10));
      if (!x || !canPlaceAvatar(P(g2, x.owner), false, x)) return;
      if (summon(g2, x.owner, x, 'effect') && x.owner !== p && P(g2, x.owner).avatars.includes(x)) {
        x.f.morphNoAct = 1; addRule(g2, { p: x.owner, key: 'morphine', until: RULE_GAME, n: x.uid });
      }
    })],
  },
  // v14 ruling: no card enters the field from a Deck while this is on the Avatar Zone (every summon path: blockSummon)
  'หุ่นพิฆาต 300%': {
    keep: 2.5,
    blockSummon: (g, self, p, c) => P(g, self.ctrl).avatars.includes(self) && originZone(g, c) === 'deck',
  },
  'ราชาใบก้อน': {
    keep: 4.5, shield: true,
    costMod: (g, self, t) => (t === self && g.p.some((q) => q.avatars.includes(self)) ? -(self.f.bkDown || 0) : 0),
    fieldActs: (g, p, c) => [act('ราชาใบก้อน: Cost -1, destroy', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'baikon') && costNow(g2, c) >= 1
      && P(g2, opp(p)).avatars.some((a) => costNow(g2, a) <= costNow(g2, c) - 1),
    (g2) => {
      use(g2, p, 'baikon'); c.f.bkDown = (c.f.bkDown || 0) + 1;
      const t = best(P(g2, opp(p)).avatars.filter((a) => costNow(g2, a) <= costNow(g2, c)), (a) => value(g2, a));
      if (t) destroy(g2, t, p);
    })],
  },
  'หมีเหลือง': {
    keep: 3,
    // option 1 (no battle destruction) is given to itself, option 2 to our best other Avatar (user: correct)
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (!showColor(g, p, 'เขียว')) return;
      const others = P(g, p).avatars.filter((a) => a !== c);
      const bt = best(others, (a) => value(g, a));
      const m = chooseMode(g, c, ['Not destroyed in battle (this card)', 'Unaffected by opponent Magic'], bt && value(g, bt) >= 5 ? 1 : 0);
      if (m === 1) { const t = best(P(g, p).avatars, (a) => value(g, a) + (a === c ? -1 : 0)); if (t) t.magicImmuneUntil = Math.max(t.magicImmuneUntil, g.turn + 1); }
      else c.f.bearSafe = g.turn + 1;
    },
    protectSelf: (g, c, by, viaMagic) => !viaMagic && g.phase === 'Battle' && (c.f.bearSafe || 0) >= g.turn,
  },
  'ริกกี้ คุณตาใจดี': {
    keep: 3.5,
    onSummon: (g, c) => { c.magicImmuneUntil = 1e9; },
    // (v14: its ตู้เสื้อผ้าของริกกี้ trigger moved to the Construct, which watches every ริกกี้)
  },
  'พญายักษ์ ทศกัณฐ์': {
    keep: 5,
    fieldActs: (g, p, c) => [act('ทศกัณฐ์: discard 1, call ยักษ์ POWER 3', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'tos') && P(g2, p).hand.length >= 1
      && canPlaceAvatar(P(g2, p)) && !deckLocked(g2) && P(g2, p).deck.some((x) => isA(x) && symIs(x, 'ยักษ์') && x.def.power === 3 && !named(x, 'ทศกัณ')),
    (g2) => {
      use(g2, p, 'tos'); discardWorst(g2, p, 1);
      fromZoneSummon(g2, p, P(g2, p).deck, (x) => symIs(x, 'ยักษ์') && x.def.power === 3 && !named(x, 'ทศกัณ'));
      shuffle(g2, P(g2, p).deck);
    })],
  },
  'มรดกของพระอิศวร': legacy('แดง', 'มรดกของพระอิศวร'),
  'หนังสือเอาตัวรอดของกุ่ย': legacy('ฟ้า', 'หนังสือเอาตัวรอดของกุ่ย'),
  'หมอนข้างมฤตยูเทวี': legacy('ม่วง', 'หมอนข้างมฤตยูเทวี'),
  'ใบรับสมัครพนักงานลงกา': legacy('เขียว', 'ใบรับสมัครพนักงานลงกา'),
  'กาจอก': {
    keep: 3.5,
    react: {
      on: ['fight'],
      can: (g, p, c, ev) => !!ev.target && !!ev.source && ev.target.ctrl === p && !ev.source.asleep && P(g, ev.source.ctrl).avatars.includes(ev.source),
      want: (g, p, c, ev) => !wins(g, ev.target!, ev.source!) || value(g, ev.source!) >= 6,
      resolve: (g, p, c, ev) => { if (ev.source && !ev.source.asleep) destroy(g, ev.source, p, true); },
    },
  },
  'เราจะตายแล้วท่านหยุดเถอะ': {
    keep: 3.5,
    react: {
      on: ['attack'],
      // v14 ruling: popup when an opposing Avatar attacks our LIFE and one of our Avatars was destroyed in a fight this turn
      can: (g, p, c, ev) => ev.actor !== p && ev.target === null && turnLog(g).destroyedBattle[p] > 0,
      want: () => true,
      resolve: cancel,
    },
  },
  'ปืนจักรวุทธ': {
    keep: 4,
    // v14: the wearer must attack when it can (mustAttack)
    mustAttack: (g, m, a) => a.uid === m.wearer,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => power(g, a) + (a.asleep ? 0 : 3)),
    onWearerAttack: (g, m, w) => { w.temp.push({ power: 4, until: 'battle' }); },
    onWearerKill: (g, m, w) => {
      if (g.active !== w.ctrl || !once(g, w.ctrl, 'chakra')) return;
      use(g, w.ctrl, 'chakra'); w.asleep = false; w.noWakeUntil = 1e9; w.f.chakraLock = m.uid;
    },
    // other-team audit: the "no waking" lasts only while it wears this gun
    afterLeave: (g: Game, m: Card, info: any) => { const w = info.wearer as Card | null; if (w && w.f && w.f.chakraLock === m.uid) { delete w.f.chakraLock; w.noWakeUntil = 0; } },
    fieldActs: (g, p, m) => [act('ปืนจักรวุทธ: return to hand, wake wearer', (g2) => inMain(g2, p) && m.wearer >= 0 && m.owner === p && once(g2, p, 'chakra2'),
      (g2) => {
        use(g2, p, 'chakra2');
        const w = findCard(g2, m.wearer);
        detach(g2, m); P(g2, p).hand.push(m);
        if (w) { w.asleep = false; w.noWakeUntil = 0; }
      })],
  },
  'วิหารเจ้าสมุทร': {
    keep: 3, alias: ['บึงทมิฬ'],
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [act('วิหาร: rest a ปลา, dig 3 for ปลา', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'temple')
      && P(g2, p).avatars.some((a) => symIs(a, 'ปลา') && !a.asleep) && P(g2, p).deck.length > 4,
    (g2) => {
      use(g2, p, 'temple');
      const f = worst(P(g2, p).avatars.filter((a) => symIs(a, 'ปลา') && !a.asleep), (a) => power(g2, a));
      if (f) f.asleep = true;
      peek(g2, p, 3, (top) => { takeHand(g2, p, top, (x) => symIs(x, 'ปลา')); }, 'hell');
    })],
  },
};

// หนังมนุษย์ ชุดแก้แค้น BT08-051 (base entry in g6.ts): v14 ruling: as a React it can be used when the opponent summons an
// Avatar, when we are attacked, or while we are attacking (our fight window); in Main Phase it is a Normal Magic (g6).
{
  const swapOk = (g: Game, p: PID, s: Card | null) => {
    const zone = s ? [s] : onZone(g, p, 'ริกกี้').filter(isA);
    return zone.some((a) => P(g, p).avatars.includes(a) && P(g, p).deck.some((x) => isA(x) && named(x, 'ริกกี้') && x.def.name !== a.def.name));
  };
  const swap = (g: Game, p: PID, s: Card) => {
    const nm = s.def.name;
    if (!toHell(g, s, { cost: true })) return;
    fromZoneSummon(g, p, P(g, p).deck, (x) => named(x, 'ริกกี้') && x.def.name !== nm, 'jutsu');
    shuffle(g, P(g, p).deck);
  };
  const base = FX['หนังมนุษย์ ชุดแก้แค้น'] || {};
  NEW['หนังมนุษย์ ชุดแก้แค้น'] = {
    ...base,
    keep: base.keep ?? 4,
    react: {
      on: ['summon', 'attack', 'fight'],
      can: (g, p, c, ev) => {
        if (ev.kind === 'summon') return ev.actor !== p && swapOk(g, p, null);
        if (ev.kind === 'attack') return ev.actor !== p && swapOk(g, p, null);
        return ev.actor !== p && !!ev.target && ev.target.ctrl === p && g.active === p && swapOk(g, p, null); // we are attacking
      },
      want: (g, p, c, ev) => ev.kind === 'attack' && !!ev.target && ev.target.ctrl === p && named(ev.target, 'ริกกี้') && !!ev.source
        && power(g, ev.source) >= power(g, ev.target) && swapOk(g, p, ev.target),
      resolve: (g, p, c, ev) => {
        const t = ev.kind === 'attack' && ev.target && named(ev.target, 'ริกกี้') && swapOk(g, p, ev.target) ? ev.target
          : worst(onZone(g, p, 'ริกกี้').filter((a) => swapOk(g, p, a)), (a) => value(g, a));
        if (t) swap(g, p, t);
      },
    },
  };
}

Object.assign(FX, NEW);

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): หนังมนุษย์ ชุดแก้แค้น sends the ริกกี้ to Hell (its
// cost) before the React window; the summon is the effect. The ริกกี้'s name is kept on the Magic for the effect.
{
  const okRicky = (g: Game, p: PID, a: Card) => P(g, p).avatars.includes(a) && P(g, p).deck.some((x) => isA(x) && named(x, 'ริกกี้') && x.def.name !== a.def.name);
  const payRicky = (g: Game, c: Card, p: PID, s: Card | null | undefined) => {
    if (!s) return false;
    c.f.rickyNm = s.def.name;
    return !!toHell(g, s, { cost: true });
  };
  const summonRicky = (g: Game, p: PID, c: Card) => {
    const nm = c.f.rickyNm; delete c.f.rickyNm;
    fromZoneSummon(g, p, P(g, p).deck, (x) => named(x, 'ริกกี้') && x.def.name !== nm, 'jutsu');
    shuffle(g, P(g, p).deck);
  };
  costFirst('หนังมนุษย์ ชุดแก้แค้น',
    (g, p, c) => payRicky(g, c, p, worst(onZone(g, p, 'ริกกี้').filter((a) => isA(a) && okRicky(g, p, a)), (a) => value(g, a))),
    (g, p, c) => summonRicky(g, p, c),
    (g, p, c, ev) => payRicky(g, c, p, ev.kind === 'attack' && ev.target && named(ev.target, 'ริกกี้') && okRicky(g, p, ev.target) ? ev.target
      : worst(onZone(g, p, 'ริกกี้').filter((a) => isA(a) && okRicky(g, p, a)), (a) => value(g, a))),
    (g, p, c) => summonRicky(g, p, c));
}
