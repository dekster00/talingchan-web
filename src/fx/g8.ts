// Card effects for BT10, BT11 (cards not coded in cards.ts / cards2.ts).
// Approximations are marked "approx:". Helpers are local copies (cards2.ts does not export its helpers).
import type { Card, Game, PID, MagicKind } from '../types.ts';
import type { Fx, HandAct } from '../cards.ts';
import { FX, value, best, worst, pickN, worstN, mayDo, chooseMode, oppChoice, sacrifice, search, inMain, removeOpp } from '../cards.ts';
import { costFirst } from '../cards.ts'; // other-team audit Q9
import {
  P, opp, power, draw, destroy, toHell, toExile, toHand, discard, detach, summon, shuffle, mill,
  canPlaceAvatar, flippedLife, critical, onceUsed, markOnce, keepValue, log, findCard, rand,
  hitLife, castMagic, uniqueBlocked,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding
} from '../engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield } from '../engine.ts';
import {
  turnLog, currentFight, flipLifeCard, resolveLife, addRule, RULES, RULE_GAME, toDeck, abilityWindow, nameHas, refreshHooks,
  fieldZone, hasKw, silenced, contOff, summonAllowed, costOf, addPower,
} from '../engine.ts';
import { canWear as canWearE, attach as attachE } from '../engine.ts'; // v14d central attach
import { inLink as inLinkG8 } from '../engine.ts'; // linkbot
import { humanSeat } from '../engine.ts'; // bugfix4
import { setSymbols, setName, swapCostPower } from '../view.ts';
import * as fs from 'node:fs';

// ---------- helpers ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function named(c: Card, key: string): boolean {
  if (c.def.aka && c.def.aka.some((a) => a.includes(key))) return true;
  if (c.def.name.includes(key)) return true;
  if (key === 'สิ่งปฏิกูล' && c.f && c.f.sewage) return true; // renamed by ราชาสิ่งปฏิกูล
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some((a) => a.includes(key)));
}
const onZone = (g: Game, p: PID, key: string) => P(g, p).avatars.filter((a) => named(a, key));
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
const use = (g: Game, p: PID, key: string) => markOnce(g, P(g, p), key);
const act = (label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct => ({ label, can, run });
const boost = (c: Card, n: number, until: 'turn' | 'battle' = 'turn') => { if (n) c.temp.push({ power: n, until }); };
const linked = (g: Game, c: Card, partner: string) => P(g, c.ctrl).avatars.includes(c) && P(g, c.ctrl).avatars.some((a) => a !== c && named(a, partner) && a.f.linkWith === c.uid && c.f.linkWith === a.uid); // v14 features: Link action
const hellAvatars = (g: Game, p: PID, pred: (c: Card) => boolean = () => true) => P(g, p).hell.filter((c) => isA(c) && pred(c));
const distinctNames = (cs: Card[]) => new Set(cs.map((c) => c.def.name)).size;

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
  const pool = [...list].filter((x) => isA(x) && pred(x) && !uniqueBlocked(g, p, x));
  while (n < max && canPlaceAvatar(P(g, p))) {
    const c = max > 1 ? pickN(pool, 1, (x) => value(g, x), { optional: true })[0] || null : best(pool, (x) => value(g, x)); // human picks inside scouts
    if (!c) break;
    pool.splice(pool.indexOf(c), 1);
    list.splice(list.indexOf(c), 1);
    c.f.viaScout = 1; P(g, p).hell.push(c); // somewhere findable while summoning
    if (summon(g, p, c, how)) n++;
    else { detach(g, c); list.push(c); }
  }
  return n;
}
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
  const c = best(zone.filter((x) => isA(x) && pred(x) && !uniqueBlocked(g, p, x)), (x) => value(g, x));
  if (c && canPlaceAvatar(P(g, p)) && summon(g, p, c, how)) return c;
  return null;
}
function attach(g: Game, c: Card, w: Card): boolean {
  if (!canChangeCtrl(g, c, w.ctrl)) { log(g, `${c.def.name}: its control can't be changed (รูปประจำบ้าน)`); return false; }
  // v14d: engine attach() checks canWear (Def.noWear, wearIf, refuseMod: ตั๊กแตนหยาง's "only แมลง" lives in its refuseMod)
  if (!attachE(g, c, w)) { log(g, `${c.def.name} can't be worn by ${w.def.name}`); return false; }
  c.asleep = false; c.temp = []; c.ctrl = w.ctrl;
  return true;
}
function discardWorst(g: Game, p: PID, n: number, except: Card[] = [], pred: (c: Card) => boolean = () => true) {
  for (let i = 0; i < n; i++) {
    const d = worst(P(g, p).hand.filter((x) => !except.includes(x) && pred(x)), (x) => keepValue(g, x));
    if (!d) return false;
    discard(g, p, d);
  }
  return true;
}
function randDiscard(g: Game, q: PID) { const h = P(g, q).hand; if (h.length) discard(g, q, h[Math.floor(rand(g) * h.length)]); }
function flipOwn(g: Game, p: PID) {
  const l = P(g, p).life.find((x) => !x.faceUp);
  if (!l) return false;
  l.faceUp = true; log(g, `P${p} flips own LIFE (${flippedLife(P(g, p))}/5)`);
  return true;
}
// put a card (from any zone) onto a player's Magic Zone
function toMz(g: Game, c: Card, p: PID = c.owner) {
  if (!canChangeCtrl(g, c, p)) { log(g, `${c.def.name}: its control can't be changed (รูปประจำบ้าน)`); return; }
  detach(g, c);
  c.ctrl = p; c.asleep = false; c.temp = []; c.wearer = -1;
  P(g, p).mz.push(c);
  log(g, `${c.def.name} goes to P${p}'s Magic Zone`);
}
function backToDeck(g: Game, c: Card) { toHell(g, c); const pl = P(g, c.owner); const i = pl.hell.indexOf(c); if (i >= 0) { pl.hell.splice(i, 1); pl.deck.push(c); } }
function exileTop(g: Game, q: PID, n: number) { const pl = P(g, q); for (let i = 0; i < n && pl.deck.length; i++) pl.exile.push(pl.deck.shift()!); }
const MILL_TAG = 'milled';
function myMill(g: Game, p: PID, n: number) { P(g, p).once[MILL_TAG] = g.turn; return mill(g, p, n); }

// Who destroyed it: recorded in protectSelf (which gets `by`), read in deathCry (toHell has reset c.f by then).
function trackBy(g: Game, c: Card, by: PID | null) { const pl = P(g, c.owner); pl.once['byT:' + c.uid] = g.turn; pl.once['by:' + c.uid] = by === null ? -1 : by; }
function killedByOpp(g: Game, c: Card, owner: PID) { const pl = P(g, owner); return pl.once['byT:' + c.uid] === g.turn && pl.once['by:' + c.uid] === opp(owner); }
const MANGO_KILL = 'mangoKill';
const mango = (c: Card) => isA(c) && named(c, 'มะม่วง') && symIs(c, 'ต้นไม้');
const mangoTrees = (g: Game, p: PID) => P(g, p).mz.filter((x) => x.def.name === 'ต้นมะม่วง').length;
// "คำสั่งเสีย: ถ้าถูกทำลายจากการ์ดฝ่ายตรงข้าม (หรือการ์ด มะม่วง) นำการ์ดใบนี้ไปวางไว้บน Magic Zone เรา"
function mzOnDeath(mangoToo: boolean, extra: Fx = {}): Fx {
  return {
    ...extra,
    protectSelf: (g, c, by, viaMagic) => { trackBy(g, c, by); return extra.protectSelf ? extra.protectSelf(g, c, by, viaMagic) : false; },
    deathCry: (g, c, owner) => {
      extra.deathCry?.(g, c, owner);
      const pl = P(g, owner);
      if (!pl.hell.includes(c)) return;
      if (killedByOpp(g, c, owner) || (mangoToo && pl.once[MANGO_KILL] === g.turn)) toMz(g, c, owner);
    },
  };
}

const SEWAGE = 'สิ่งปฏิกูล';
const VAL = 'เทพธิดาแห่งวัลฮัลลา';
const WEAPON = 'อาวุธนคร';
const NAKHON = 'นครทิเนนทอล';
const hasNakhon = (g: Game, p: PID) => P(g, p).mz.some((x) => x.def.name === NAKHON);
const gunman = (c: Card) => isA(c) && named(c, 'มือปืนนคร');
const canWear = (a: Card, m: Card) => gunman(a) && !a.mods.some((x) => x.def.name === m.def.name);
const isWeapon = (c: Card) => c.def.type === 'Magic' && c.def.subtype === 'Modification' && c.def.name.includes(WEAPON);
const APPLIANCE = 'เครื่องใช้ไฟฟ้า';
const NAT = (c: Card) => named(c, 'ไอ้นัท') || named(c, 'เซอร์นัท');
const virusHell = (g: Game, p: PID) => hellAvatars(g, p, (x) => named(x, 'ไวรัส') && !x.def.only);
const story = (c: Card) => named(c, 'เรื่องราว');
const kata = (c: Card) => c.def.type === 'Magic' && c.def.name.includes('คาถา');
const wizard = (c: Card) => isA(c) && named(c, 'จอมเวทย์');
// Avatars whose text box mentions "ค่ายบางระจัน" (from data/cards.json)
const BANG = ['จัน หนวดเขี้ยว', 'อิน สไนเปอร์', 'ทองเหม็น ขวานคลั่ง', 'เมือง ช่างใหญ่', 'พันเรือง ผู้พิทักษ์ไร้พ่าย', 'พ่อแท่น ผู้นำอาวุโส',
  'อาจารย์ธรรมโชติ', 'บุญช่วย ควายรักชาติ', 'ไอ้ชิด อโยธยา Express', 'เณรคู ศิษย์เอกพระอาจารย์', 'น้าเอี๊ยด นักบรรเลง'];
// Avatars with "พอดี จุติ" (from data/cards.json)
const PODEE = ['แอชวิคกับอโศกาบาร์พิศวง', 'ฤๅษีพระเจ้าตา', 'พี่วัฒน์ BGN', 'เนียจัง ไอดอลอินฟลูเอนเซอร์', 'กุ่ย หน้าตาดี', 'ฮอล หน้าตาดี',
  'นาย หน้าตาดี', 'มิสเตอร์โบโบ้', 'ราชาสิ่งปฏิกูล', 'ลุงน้อย พ่อค้าไก่ย่าง'];
// Avatars with Cost 4 or less that have [Link] (from data/cards.json)
const LINK4 = ['เพมมุ ยอดมนุษย์', 'สไปรท์ ยอดสุนัข', 'เมย์ แวมไพร์โกธิค', 'เจ้าหญิงรวงข้าว', 'ธอร์ บุตรแห่งโอดิน', 'โลกิ เจ้าชายยักษ์น้ำแข็ง',
  'จอมเวทย์ เดสสึหวา', 'จอมเวทย์ โกลเด้น', 'นายนิรยบาล นิมมา', 'ซัลลี่วอดก้า', 'ตันก๋ง กุนซือคู่กายเทพสงคราม', 'ออส่วนบอย', 'มิสทรอม่า'];

// Declare a card type for the top of the opponent's Deck (the bot always says "Avatar", the most common type).
function declareHit(g: Game, p: PID): boolean | null {
  const top = P(g, opp(p)).deck[0];
  if (!top) return null;
  return top.def.type === 'Avatar';
}
function topToHell(g: Game, q: PID) { const pl = P(g, q); const t = pl.deck.shift(); if (t) pl.hell.push(t); }

function sewageKing(g: Game, c: Card) {
  const p = c.ctrl;
  if (P(g, p).hell.filter((x) => named(x, SEWAGE)).length < 5) return;
  const t = best(P(g, opp(p)).avatars.filter((a) => !a.f.sewage), (a) => value(g, a));
  if (!t) return;
  t.f.sewage = 1; t.bonus = 1 - t.def.power;
  setSymbols(g, t, ['สัตว์มหัศจรรย์']); setName(g, t, SEWAGE); // v14: shown in the detail box (view.ts)
  log(g, `${t.def.name} becomes "สิ่งปฏิกูล" {สัตว์มหัศจรรย์} with POWER 1`);
}
function goldenLink(g: Game, golden: Card) {
  const p = golden.ctrl, pl = P(g, p);
  if (!once(g, p, 'goldlink:' + golden.uid)) return;
  use(g, p, 'goldlink:' + golden.uid);
  const ok = (x: Card) => x.def.type === 'Construct' && x.def.name.includes('จอมเวทย์') && !pl.mz.some((m) => m.def.name === x.def.name);
  const fromDeck = pl.deck.find(ok);
  const x = fromDeck || pl.hell.find(ok);
  if (x) summon(g, p, x, 'effect');
  if (fromDeck) shuffle(g, pl.deck);
}
const armor = (key: string): Fx => ({
  keep: 3.5,
  jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => { takeSummon(g, c.ctrl, top, (x) => (symIs(x, 'ยักษ์') && x.def.power === 3) || x.def.name.includes(key)); }),
  staticPower: (g, c) => {
    const others = P(g, c.ctrl).avatars.filter((a) => a !== c);
    if (others.some((a) => symIs(a, 'ยักษ์') || named(a, 'มณโฑ'))) return 2;
    return -2;
  },
});
const applianceFromMz = (): Fx['fieldActs'] => (g, p, c) => [act(`${c.def.name}: summon from Magic Zone`,
  (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && P(g2, p).hand.length >= 2 && canPlaceAvatar(P(g2, p)),
  (g2) => { if (discardWorst(g2, p, 2)) summon(g2, p, c, 'own'); })];
function weapon(extra: Fx): Fx {
  return {
    keep: 3,
    canCast: (g, p, c) => P(g, p).avatars.some((a) => canWear(a, c)),
    modTarget: (g, p, c) => best(P(g, p).avatars.filter((a) => canWear(a, c)), (a) => value(g, a) + (a.asleep ? 0 : 2)),
    ...extra,
  };
}
function bankNames(g: Game, p: PID) { return distinctNames(hellAvatars(g, p, (x) => named(x, 'แบงค์'))); }
// v14: "ทำลาย การ์ด 1 ใบบนสนามฝ่ายตรงข้าม": any card (Avatar, Construct / Magic Zone card, worn card, Land)
function oppFieldCards(g: Game, p: PID): Card[] {
  const o = opp(p), out: Card[] = [...P(g, o).avatars, ...P(g, o).mz.filter((x) => !x.f.faceDown)];
  for (const q of g.p) for (const a of q.avatars) for (const m of a.mods) if (m.ctrl === o) out.push(m);
  if (g.land && g.land.ctrl === o) out.push(g.land);
  return out;
}
function cardWorth(g: Game, x: Card) { return isA(x) && fieldZone(g, x) === 'avatars' ? value(g, x) : x.def.type === 'Construct' ? 3 + x.def.cost * 0.5 : keepValue(g, x); }
function removeFieldCard(g: Game, p: PID, t: Card) {
  if (!fieldZone(g, t)) return;
  if ((isA(t) && fieldZone(g, t) === 'avatars') || (t.def.type === 'Construct' && fieldZone(g, t) === 'mz')) destroy(g, t, p, true);
  else toHell(g, t, { by: p, viaMagic: true });
}
function mangoRoot(g: Game, p: PID, prefer: Card | null) {
  const m = worst(P(g, p).avatars.filter(mango), (a) => value(g, a));
  if (!m) return;
  P(g, p).once[MANGO_KILL] = g.turn;
  if (!destroy(g, m, p, false, { cost: true })) return;
  const pool = oppFieldCards(g, p);
  const t = best(pool, (x) => (x === prefer ? 3 : 0) + cardWorth(g, x));
  if (t) removeFieldCard(g, p, t);
}
// simplify1: เนโกะเมะ ยูริ: "until the end of the opponent's next turn, each time a {land} / {mod} is used, draw 1"
for (const k of ['Land', 'Modification']) RULES['ยูริ:' + k] = { label: `ยูริ: draw 1 for each ${k} Magic used`, magic: (g: Game, r: any, m: Card) => { if (m.def.subtype === k) { log(g, `ยูริ: a ${k} Magic was used, P${r.p} draws 1`); draw(g, r.p, 1); } } };
// simplify1: หอสมุดจอมเวทย์'s "this turn, one more {magic} คาถา" (engine RuleDef.extraMagic, rule n = 1 extra)
RULES['หอสมุด'] = { label: 'หอสมุดจอมเวทย์: one more คาถา this turn', extraMagic: (g: Game, r: any, m: Card) => kata(m) };
function libraryPick(g: Game, p: PID): [Card, number] | null {
  const pl = P(g, p);
  for (const m of pl.hand) {
    if (!kata(m)) continue;
    const kind = m.def.subtype as MagicKind; const f = FX[m.def.name];
    if (!f || !pl.used[kind] || (kind === 'React' && !f.mainUse)) continue;
    const n = f.options || 1;
    for (let o = 0; o < n; o++) {
      pl.used[kind] = false;
      let ok = false;
      try { ok = !f.canCast || f.canCast(g, p, m, o); } finally { pl.used[kind] = true; }
      if (ok) return [m, o];
    }
  }
  return null;
}
function modeParts(g: Game, p: PID, part: string): Card[] | null {
  const mz = P(g, p).mz;
  const a = mz.find((x) => x.def.name === 'มนุษย์เครื่องใช้ไฟฟ้า เบเซอร์'), b = mz.find((x) => x.def.name === part);
  return a && b ? [a, b] : null;
}
function mythPick(g: Game, p: PID): [Card, Card[]] | null {
  const pl = P(g, p);
  if (!pl.avatars.length) return null;
  const attrs: ((x: Card) => string | number)[] = [(x) => x.def.power, (x) => x.def.symbol, (x) => x.def.cost, (x) => x.def.gem, (x) => x.def.color];
  let res: [Card, Card[]] | null = null, bv = -Infinity;
  for (const h of pl.hand.filter(isA)) for (const at of attrs) {
    const ts = pl.avatars.filter((a) => at(a) === at(h)).sort((x, y) => (x.asleep ? 1 : 0) - (y.asleep ? 1 : 0) || power(g, y) - power(g, x)).slice(0, 2);
    if (!ts.length) continue;
    const v = ts.filter((t) => !t.asleep).length * 2 + ts.length - keepValue(g, h) * 0.5;
    if (v > bv) { bv = v; res = [h, ts]; }
  }
  return res;
}

Object.assign(FX, {
  // ===== สิ่งปฏิกูล =====
  'สิ่งปฏิกูลมีชีวิต': {
    keep: 2,
    deathCry: (g, c, owner) => {
      const ours = g.active === owner;
      peek(g, owner, 3, (top) => {
        const pick = best(top.filter((x) => isA(x) && named(x, SEWAGE)), (x) => x.def.power + (x.def.name === 'ราชาสิ่งปฏิกูล' ? 5 : 0));
        if (!pick) return;
        top.splice(top.indexOf(pick), 1);
        const pl = P(g, owner);
        if (ours && canPlaceAvatar(pl) && !uniqueBlocked(g, owner, pick)) {
          pl.hell.push(pick); pl.once['sewage:' + pick.uid] = g.turn;
          if (!summon(g, owner, pick, 'effect')) { detach(g, pick); pl.hand.push(pick); }
        } else pl.hand.push(pick);
      }, 'hell');
    },
  },
  'สิ่งปฏิกูลสีเงิน': {
    keep: 2,
    deathCry: (g, c, owner) => {
      const t = best(P(g, opp(owner)).avatars, (a) => value(g, a));
      if (t) t.bonus -= g.active === owner ? 3 : 1; // no duration printed: lasts while it stays on the field
    },
  },
  'ราชาสิ่งปฏิกูล': {
    keep: 5,
    jutsu: (g, c) => sewageKing(g, c),
    onSummon: (g, c, how) => { if (how !== 'paid' && how !== 'jutsu' && P(g, c.ctrl).once['sewage:' + c.uid] === g.turn) sewageKing(g, c); },
    fieldActs: (g, p, c) => [act('ราชาสิ่งปฏิกูล: destroy a สิ่งปฏิกูล, random discard', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'sewking:' + c.uid)
      && g2.p.some((q) => q.avatars.some((a) => a !== c && named(a, SEWAGE))),
    (g2) => {
      use(g2, p, 'sewking:' + c.uid);
      const pool = [...P(g2, opp(p)).avatars, ...P(g2, p).avatars].filter((a) => a !== c && named(a, SEWAGE));
      const t = best(pool, (a) => (a.ctrl !== p ? 10 + value(g2, a) : (FX[a.def.name]?.deathCry ? 3 : 0) - value(g2, a)));
      if (t && destroy(g2, t, p)) randDiscard(g2, opp(p));
    })],
  },
  'ทะลวงส้วม': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.some((a) => named(a, SEWAGE)) && P(g, p).deck.length > 4,
    resolve: (g, p) => {
      if (!sacrifice(g, p, P(g, p).avatars.filter((a) => named(a, SEWAGE)), 1)) return;
      draw(g, p, 3); discardWorst(g, p, 1);
    },
  },

  // ===== ภาคีมะม่วง =====
  'ผู้คุมกฎแห่งภาคีมะม่วง': mzOnDeath(true, {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const score = (y: Card) => (y.def.name === 'ต้นมะม่วง' ? 5 : 0) + keepValue(g, y);
      const x = best(pl.deck.filter((y) => mango(y) && !y.def.only), score);
      if (x) {
        toMz(g, x, p);
        if (x.def.name === 'ต้นมะม่วง') { const y = pickN([...pl.deck, ...pl.hell].filter(mango), 1, score, { optional: true, title: 'ผู้คุมกฎ: you may put 1 more มะม่วง from your Deck or Hell on the Magic Zone' })[0]; if (y) toMz(g, y, p); } // bugs7 item 7: "สามารถ" = optional
      }
      shuffle(g, pl.deck);
    },
  }),
  'มาโกะ มารดาแห่งภาคีมะม่วง': {
    keep: 6,
    jutsu: (g, c) => {
      const p = c.ctrl, seen = new Set<string>();
      for (;;) { const x = pickN(hellAvatars(g, p, (y) => mango(y) && !seen.has(y.def.name)), 1, (y) => value(g, y), { optional: true, title: 'มาโกะ: put a มะม่วง from Hell on the Magic Zone (different names)' })[0]; if (!x) break; seen.add(x.def.name); toMz(g, x, p); }
    },
    staticPower: (g, c) => mangoTrees(g, c.ctrl),
    fieldActs: (g, p, c) => [
      act('มาโกะ: send 5 มะม่วง from Magic Zone, summon', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && canPlaceAvatar(P(g2, p))
        && P(g2, p).mz.filter((x) => x !== c && mango(x)).length >= 5,
      (g2) => {
        const pool = worstN(P(g2, p).mz.filter((x) => x !== c && mango(x)), 5, (x) => keepValue(g2, x), { title: 'มาโกะ: send 5 มะม่วง from the Magic Zone to Hell' });
        for (const x of pool) toHell(g2, x);
        summon(g2, p, c, 'jutsu');
      }),
      act('มาโกะ: summon a มะม่วง from Magic Zone', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'mako') && canPlaceAvatar(P(g2, p))
        && P(g2, p).mz.some((x) => mango(x)),
      (g2) => { use(g2, p, 'mako'); fromZoneSummon(g2, p, P(g2, p).mz, mango, 'jutsu'); }),
    ],
  },
  'นักรบทองแห่งภาคีมะม่วง': mzOnDeath(true, {
    keep: 3.5, shield: true,
    endPhase: (g, c) => { if (P(g, c.ctrl).avatars.includes(c) && mangoTrees(g, c.ctrl) > 0) { c.asleep = false; c.f.gold = g.turn + 1; } },
    staticPower: (g, c) => ((c.f.gold || 0) >= g.turn ? 2 : 0),
  }),
  // its static only protects ต้นมะม่วง on the Magic Zone, which nothing in the engine destroys
  'ผู้พิทักษ์แห่งภาคีมะม่วง': mzOnDeath(true, { keep: 2 }),
  'ดยุกแห่งภาคีมะม่วง': mzOnDeath(true, {
    keep: 4.5,
    jutsu: (g, c) => {
      const lim = 2 + mangoTrees(g, c.ctrl);
      const t = best(P(g, opp(c.ctrl)).avatars.filter((a) => a.def.cost <= lim), (a) => value(g, a));
      if (t) destroy(g, t, c.ctrl);
    },
  }),
  // v14 ruling: destroys any card on the opponent's field; usable in our Main Phase, when the opponent attacks, summons an
  // Avatar or uses a Magic (it does not cancel that card)
  'ไปคุยกับรากมะม่วง': {
    keep: 4, mainUse: true,
    canCast: (g, p) => P(g, p).avatars.some(mango) && oppFieldCards(g, p).length > 0,
    resolve: (g, p) => mangoRoot(g, p, null),
    react: {
      on: ['attack', 'summon', 'magic'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.some(mango) && oppFieldCards(g, p).length > 0,
      want: (g, p, c, ev) => {
        const m = worst(P(g, p).avatars.filter(mango), (a) => value(g, a)); if (!m) return false;
        if (ev.kind === 'magic') return false; // the bot keeps it for Avatars
        return !!ev.source && fieldZone(g, ev.source) !== null && value(g, ev.source) >= value(g, m) + 1.5;
      },
      resolve: (g, p, c, ev) => mangoRoot(g, p, ev.source && fieldZone(g, ev.source) ? ev.source : null),
    },
  },
  'มะม่วงดราชิลด์': {
    keep: 3,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    // 1 tree: this Land can't be destroyed by card abilities (a new Land can still replace it)
    leaveGuard: (g, self, t, info) => (t === self && (info.how === 'destroy' || info.how === 'hell') && !!info.src && mangoTrees(g, self.ctrl) >= 1
      ? { optional: false, label: 'not destroyed (ต้นมะม่วง 1+)', run: () => true } : null),
    // 3 trees: our มะม่วง (ต้นไม้) can't be chosen by the opponent's card abilities ("all" effects still hit)
    noTarget: (g, self, t, by) => by.ctrl !== self.ctrl && t.ctrl === self.ctrl && mango(t) && mangoTrees(g, self.ctrl) >= 3,
    landPower: (g, l, a) => (a.ctrl === l.owner && mango(a) && mangoTrees(g, l.owner) >= 2 ? 1 : 0),
    fieldActs: (g, p, c) => [act('มะม่วงดราชิลด์: มะม่วง from hell to Magic Zone', (g2) => inMain(g2, p) && once(g2, p, 'drashield') && mangoTrees(g2, p) >= 4
      && hellAvatars(g2, p, mango).length > 0,
    (g2) => { use(g2, p, 'drashield'); const x = best(hellAvatars(g2, p, mango), (y) => (y.def.name === 'ต้นมะม่วง' ? 5 : 0) + keepValue(g2, y)); if (x) toMz(g2, x, p); })],
  },

  // ===== ตั๊กแตน / LIFE =====
  'ราชันย์ตั๊กแตนศตวรรษ': {
    keep: 3,
    // wearing บัลลังก์ตั๊กแตนศตวรรษ: at the start of our Main Phase use the effect of one of our face-up LIFE cards (now)
    startMain: (g, c) => { if (c.mods.some((m) => m.def.name === THRONE_F)) useLifeEffect(g, c.ctrl, c); },
    getActive: (g, c) => c.mods.some((m) => m.def.name === THRONE_F) && 'บัลลังก์: เริ่ม Main Phase ใช้ผล LIFE ที่หงาย 1 ใบ',
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const th = pl.hell.find((x) => x.def.name === 'บัลลังก์ตั๊กแตนศตวรรษ');
      const can2 = pl.deck.some((x) => x.def.name === 'บัลลังก์ตั๊กแตนศตวรรษ');
      const want2 = !critical(pl) && flippedLife(pl) <= 2;
      const mode = th && can2 && humanDeciding(g) ? chooseMode(g, c, ['Wear the throne from Hell', 'Flip top LIFE, throne from Deck to hand'], 0) : th ? 0 : 1;
      if (mode === 0 && th) { attach(g, th, c); return; }
      if ((want2 || humanDeciding(g)) && can2) {
        flipLifeCard(g, p); search(g, p, (x) => x.def.name === 'บัลลังก์ตั๊กแตนศตวรรษ', 'deck');
      }
    },
  },
  'ศิลาหยินหยาง': {
    keep: 3.5, options: 2,
    canCast: (g, p, c, o) => canPlaceAvatar(P(g, p)) && P(g, p).deck.some((x) => isA(x) && x.def.name.includes(o === 0 ? 'ตั๊กแตนหยิน' : 'ตั๊กแตนหยาง')),
    resolve: (g, p, c, o) => {
      if (!critical(P(g, p))) flipOwn(g, p);
      fromZoneSummon(g, p, P(g, p).deck, (x) => x.def.name.includes(o === 0 ? 'ตั๊กแตนหยิน' : 'ตั๊กแตนหยาง'));
      shuffle(g, P(g, p).deck);
    },
  },
  'หยินหยางทอร์นาโด': {
    keep: 1.5, alias: ['ตั๊กแตน'],
    // the wearer attacks and destroys an opposing Avatar in battle: use one of our face-up LIFE cards' effect now
    onWearerKill: (g, m, w) => { if (currentFight()?.att === w && g.active === w.ctrl) useLifeEffect(g, w.ctrl, m); },
    canCast: (g, p) => P(g, p).avatars.some((a) => named(a, 'ตั๊กแตนหยิน') || named(a, 'ตั๊กแตนหยาง')),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => named(a, 'ตั๊กแตนหยิน') || named(a, 'ตั๊กแตนหยาง')), (a) => value(g, a)),
  },

  // ===== จอมเวทย์ / คาถา =====
  'จอมเวทย์ เดสสึหวา': {
    keep: 3.5,
    jutsu: (g, c) => { const p = c.ctrl; if (discardWorst(g, p, 1, [], (x) => kata(x) || wizard(x))) draw(g, p, 2); },
    // v14: any คาถา used by either player, in either turn
    onAnyMagic: (g, s, m) => { if (kata(m) && P(g, s.ctrl).avatars.includes(s)) { const t = best(P(g, s.ctrl).avatars.filter(wizard), (a) => power(g, a) + (a.asleep ? 0 : 2)); if (t) boost(t, 1); } },
    // linkbot: the Construct on entering [Link] is โกลเด้น's own text (its onLink); below [Link]: taunt + draw when targeted
    taunt: (g, c) => linked(g, c, 'จอมเวทย์ โกลเด้น'),
    onTargeted: (g, c) => { if (linked(g, c, 'จอมเวทย์ โกลเด้น') && once(g, c.ctrl, 'dessu:' + c.uid)) { use(g, c.ctrl, 'dessu:' + c.uid); draw(g, c.ctrl, 1); } },
  },
  'จอมเวทย์ โกลเด้น': {
    keep: 3,
    // v14: another จอมเวทย์ Avatar of ours is about to leave the field (any way) by the opponent's card: may destroy this instead
    // linkbot: its whole text is below [Link จอมเวทย์ เดสสึหวา]: only while in Link
    leaveGuard: (g, self, t, info) => (t !== self && info.zone === 'avatars' && linked(g, self, 'จอมเวทย์ เดสสึหวา') && P(g, self.ctrl).avatars.includes(t)
      && wizard(t) && info.by === opp(self.ctrl)
      ? { label: `destroy จอมเวทย์ โกลเด้น instead of ${t.def.name} leaving`, want: value(g, t) >= value(g, self) - 0.5, run: () => destroy(g, self, self.ctrl, false, { cost: true }) } : null),
    onLink: (g, c) => goldenLink(g, c), // v14 features: Link action
  },
  'คาถา โปเตกโต้': {
    keep: 3.5,
    react: {
      on: ['fight'],
      can: (g, p, c, ev) => !!ev.target && ev.target.ctrl === p && wizard(ev.target) && P(g, p).hell.some(kata),
      want: (g, p, c, ev) => { const n = 2 * P(g, p).hell.filter(kata).length; return power(g, ev.target!) <= power(g, ev.source!) && power(g, ev.target!) + n > power(g, ev.source!); },
      resolve: (g, p, c, ev) => { if (ev.target) boost(ev.target, 2 * P(g, p).hell.filter(kata).length, 'battle'); },
    },
  },
  'เหนือฟ้าใต้หล้า ข้าคือมหาจอมเวทย์': {
    keep: 3.5,
    canCast: (g, p, c) => P(g, p).once['maha'] !== g.turn && P(g, p).hand.some((x) => x !== c) && P(g, p).deck.some(kata),
    resolve: (g, p) => {
      if (!discardWorst(g, p, 1)) return;
      search(g, p, kata, 'deck');
      if (P(g, p).avatars.some(wizard)) { P(g, p).once['maha'] = g.turn; P(g, p).used.Normal = false; } // approx: the extra Magic must be Normal
    },
  },
  'คาถา เฟรนลี่คัม': {
    keep: 3.5, costOnlyFor: (s) => wizard(s),
    canCast: (g, p) => P(g, p).avatars.some(wizard) && canPlaceAvatar(P(g, p)) && P(g, p).deck.length >= 5,
    resolve: (g, p) => peek(g, p, 5, (top) => { takeSummon(g, p, top, wizard, 'jutsu'); }, 'bottom'),
  },
  'ชีวิตที่พอดี': {
    keep: 2.5,
    canCast: (g, p, c) => P(g, p).hand.filter((x) => x !== c).length >= 2 && P(g, p).avatars.some((a) => PODEE.includes(a.def.name) && !!FX[a.def.name]?.jutsu),
    resolve: (g, p) => {
      if (!discardWorst(g, p, 2)) return;
      const t = best(P(g, p).avatars.filter((a) => PODEE.includes(a.def.name) && !!FX[a.def.name]?.jutsu), (a) => value(g, a));
      if (t) FX[t.def.name].jutsu!(g, t);
    },
  },
  'หอสมุดจอมเวทย์': {
    keep: 2.5,
    // simplify1 (exact): the ability gives "this turn, may use 1 more {magic} คาถา" (timed rule 'หอสมุด', engine
    // RuleDef.extraMagic): the extra คาถา is cast later, from the normal Main actions (or as a React in a window).
    // v14: Constructs can be attacked: this one can't be chosen as an attack target or by opposing card abilities while we
    // have a จอมเวทย์ Avatar
    canBeAttacked: (g, self, con) => con === self && !P(g, self.ctrl).avatars.some(wizard),
    noTarget: (g, self, t, by) => t === self && by.ctrl !== self.ctrl && P(g, self.ctrl).avatars.some(wizard),
    fieldActs: (g, p, c) => [act('หอสมุด: this turn, one more คาถา', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'library')
      && (humanDeciding(g2) || libraryPick(g2, p) !== null),
      (g2) => {
        use(g2, p, 'library');
        addRule(g2, { p, key: 'หอสมุด', until: g2.turn, n: 1 });
      })],
  },

  // ===== ตำรวจ =====
  'นักข่าวสาว เดย์วัน': {
    keep: 2,
    gemAs: (g, c, s) => (s && isA(s) && named(s, 'ตำรวจ') ? 5 : c.def.gem),
    untargetable: (g, c) => P(g, c.ctrl).avatars.some((a) => a !== c && named(a, 'ตำรวจ')), // peeking/revealing changes nothing for the bot
  },
  'ตำรวจเอไอ มุเค': {
    keep: 3,
    fieldActs: (g, p, c) => [act('มุเค: guess opponent top card', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'muke:' + c.uid) && P(g2, opp(p)).deck.length > 0,
      (g2) => {
        use(g2, p, 'muke:' + c.uid);
        const hit = declareHit(g2, p);
        if (hit) { const t = best(P(g2, opp(p)).avatars, (a) => value(g2, a)); if (t) boost(t, -2); topToHell(g2, opp(p)); }
        else if (hit === false) boost(c, -2);
      })],
  },
  'ตำรวจพ่อลูกอ่อน คามุ': {
    keep: 3,
    // v14: after the fight it attacked in: declare a card type (popup; bot 50/50 Avatar / Magic), scout the top card
    afterFight: (g, c, att) => {
      const p = c.ctrl, o = opp(p);
      if (att !== c || !P(g, p).avatars.includes(c) || !P(g, o).deck.length || !once(g, p, 'kamu:' + c.uid)) return;
      use(g, p, 'kamu:' + c.uid);
      const types = ['Avatar', 'Magic', 'Construct'];
      const k = chooseMode(g, c, types.map((t) => `ประกาศ ${t}`), rand(g) < 0.5 ? 0 : 1);
      log(g, `คามุ declares ${types[k]}`);
      scoutDeck(g, o, 1, (top) => {
        const x = top[0]; if (!x) return;
        const hit = x.def.type === types[k] || (types[k] === 'Avatar' && x.def.type === 'Token');
        log(g, `คามุ: the top card is ${x.def.name} (${x.def.type}): ${hit ? 'hit' : 'miss'}`);
        if (hit) { top.splice(0, 1); P(g, o).hell.push(x); c.asleep = false; }
      }, 'top');
    },
  },
  'ตำรวจสัมภเวสี ทาย': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl, o = opp(p);
      if (!P(g, p).hand.some((x) => named(x, 'ตำรวจ'))) return;
      const od = P(g, o).deck, top = od.splice(0, 2);
      const h = best(top, (x) => keepValue(g, x));
      if (h) { top.splice(top.indexOf(h), 1); P(g, o).hell.push(h); }
      od.unshift(...top);
    },
  },

  // ===== อีสาน / misc =====
  'พระอีสาน': {
    keep: 2.5,
    react: {
      on: ['fight'], noLimit: true, fromHand: true,
      can: (g, p, c, ev) => !!ev.target && ev.target.ctrl === p && named(ev.target, 'อีสานสลิงเกอร์') && P(g, p).avatars.includes(ev.target),
      want: (g, p, c, ev) => power(g, ev.target!) <= power(g, ev.source!) && power(g, ev.target!) + 1 >= power(g, ev.source!),
      resolve: (g, p, c, ev) => { if (P(g, p).hand.includes(c)) discard(g, p, c); if (ev.target) boost(ev.target, 1, 'battle'); },
    },
  },
  'แก๊ง Super Card': {
    keep: 3,
    drawPhase: (g, c) => {
      const pl = P(g, c.ctrl);
      if (g.turn > 1 && pl.avatars.includes(c) && pl.hand.length >= 4 && pl.once['noDraw'] !== g.turn && once(g, c.ctrl, 'supercard')) { use(g, c.ctrl, 'supercard'); draw(g, c.ctrl, 1); }
    },
  },
  'เซนเซไฮ': {
    keep: 2.5, unite: true,
    // "เมื่อ Avatar ใบนี้ใช้ สามัคคี: Avatar ที่รับ สามัคคี ได้รับ 'เมื่อทำลาย Avatar ฝ่ายตรงข้ามจากการต่อสู้: หงาย LIFE ใบบนสุด
    // ของฝ่ายตรงข้าม 1 ใบ' จนจบเทิร์น" (v13: onAssistUsed + the engine's granted flip-on-kill)
    onAssistUsed: (g, s, u, att, kind) => { if (s === u && kind === 'unity') { att.f.gFlipOnKill = g.turn; log(g, `${att.def.name} gains "flip a LIFE when it wins a fight" (เซนเซไฮ)`); } },
    deathCry: (g, c, owner) => {
      const pl = P(g, owner);
      if (pl.hand.length <= 3 || flippedLife(pl) >= 3 || critical(pl)) discardWorst(g, owner, Math.min(3, pl.hand.length));
      else flipOwn(g, owner);
    },
  },
  'ผู้ขุดหาความว่างเปล่า แบงค์ Miner': {
    keep: 4,
    onAttack: (g, c) => { if (bankNames(g, c.ctrl) >= 4) exileTop(g, opp(c.ctrl), 2); },
    // v14 (8 names): unaffected by Magic: Magic can't choose it or move it off the field, opposing Magic counts it immune.
    // v14d: unaffected(src) + shieldFrom also drop untargeted POWER changes / auras whose source is a Magic
    unaffected: (g, c, src) => !!src && src.def.type === 'Magic' && bankNames(g, c.ctrl) >= 8 && P(g, c.ctrl).avatars.includes(c),
    shieldFrom: (g, self, t, src) => t === self && !!src && src.def.type === 'Magic' && bankNames(g, self.ctrl) >= 8 && P(g, self.ctrl).avatars.includes(self),
    magicImmune: (g, c) => bankNames(g, c.ctrl) >= 8 && P(g, c.ctrl).avatars.includes(c),
    noTarget: (g, self, t, by) => t === self && by.def.type === 'Magic' && bankNames(g, self.ctrl) >= 8,
    leaveGuard: (g, self, t, info) => (t === self && !info.battle && !info.cost && !!info.src && info.src.def.type === 'Magic' && bankNames(g, self.ctrl) >= 8
      ? { optional: false, label: 'unaffected by Magic (8 แบงค์ names)', run: () => true } : null),
    getActive: (g, c) => { const n = bankNames(g, c.ctrl); return n >= 8 ? '8 ชื่อ: ไม่รับผล Magic · 4 ชื่อ: โจมตี → เนรเทศ Deck 2' : n >= 4 ? '4 ชื่อ: โจมตี → เนรเทศ Deck ฝ่ายตรงข้าม 2 ใบ' : false; },
  },
  'แบงค์ ชาวดาวพฤหัส': {
    keep: 3,
    fieldActs: (g, p, c) => {
      const ok = (g2: Game) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'jupiter:' + c.uid) && P(g2, p).hand.length >= 1;
      return [
        act('แบงค์ ดาวพฤหัส: discard 1, search แบงค์', (g2) => ok(g2) && P(g2, p).deck.some((x) => isA(x) && named(x, 'แบงค์') && !x.def.only),
          (g2) => { use(g2, p, 'jupiter:' + c.uid); discardWorst(g2, p, 1); search(g2, p, (x) => isA(x) && named(x, 'แบงค์') && !x.def.only, 'deck'); }),
        act('แบงค์ ดาวพฤหัส: discard 1, แบงค์ deck to hell', (g2) => ok(g2) && P(g2, p).deck.some((x) => isA(x) && named(x, 'แบงค์')),
          (g2) => {
            use(g2, p, 'jupiter:' + c.uid); discardWorst(g2, p, 1);
            const pl = P(g2, p);
            const names = new Set(pl.hell.filter((x) => isA(x) && named(x, 'แบงค์')).map((x) => x.def.name));
            const x = best(pl.deck.filter((y) => isA(y) && named(y, 'แบงค์')), (y) => (names.has(y.def.name) ? 0 : 5) - keepValue(g2, y));
            if (x) { detach(g2, x); pl.hell.push(x); }
            shuffle(g2, pl.deck);
          }),
      ];
    },
  },
  'โคลัมแบงค์': { keep: 2.5 }, // GEM colours are not modeled, so its static changes nothing here
  'ตัวอะไรสักอย่างที่คล้ายกระรอกและนิสัยไม่ดี': {
    keep: 2.5,
    handActs: (g, p, c) => [act('กระรอก: summon after a big blue เอเลี่ยน', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && once(g2, p, 'squirrel')
      && canPlaceAvatar(P(g2, p)) && P(g2, p).avatars.some((a) => symIs(a, 'เอเลี่ยน') && colorIs(a, 'ฟ้า') && a.def.cost >= 5 && P(g2, p).once['summoned:' + a.def.name] === g2.turn),
    (g2) => { use(g2, p, 'squirrel'); summon(g2, p, c, 'own'); })],
  },
  'ตัวอะไรสักอย่างที่สุดเท่และเป็นนักดาบ': {
    keep: 3.5,
    fieldActs: (g, p, c) => [act('นักดาบ: +half POWER of a ตัวอะไรสักอย่าง', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'swordthing:' + c.uid)
      && P(g2, p).avatars.some((a) => a !== c && named(a, 'ตัวอะไรสักอย่าง')),
    (g2) => {
      use(g2, p, 'swordthing:' + c.uid);
      const t = best(P(g2, p).avatars.filter((a) => a !== c && named(a, 'ตัวอะไรสักอย่าง')), (a) => a.def.power + a.bonus);
      if (t) boost(c, Math.floor(Math.max(0, t.def.power + t.bonus) / 2));
    })],
  },
  'พายุหิมะเริงระบำ': {
    keep: 3, stayMz: true, // stays on the Magic Zone until our End Phase so its End Phase part can run
    canCast: (g, p) => canPlaceAvatar(P(g, p)) && onZone(g, p, 'ราชินีหิมะ').length > 0 && hellAvatars(g, p, (x) => named(x, 'ทหารหิมะ')).length >= 8,
    resolve: (g, p) => {
      const pl = P(g, p); let budget = 6;
      while (canPlaceAvatar(pl)) {
        const x = pickN(pl.deck.filter((y) => isA(y) && named(y, 'ทหารหิมะ') && y.def.cost <= budget && !uniqueBlocked(g, p, y)), 1, (y) => value(g, y), { optional: true, title: `พายุหิมะเริงระบำ: summon a ทหารหิมะ (Cost left ${budget})` })[0];
        if (!x) break;
        budget -= x.def.cost;
        if (summon(g, p, x, 'effect') && pl.avatars.includes(x)) x.f.storm = g.turn;
      }
      shuffle(g, pl.deck);
    },
    endPhase: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (!pl.mz.includes(c)) return;
      for (const a of [...pl.avatars]) if (a.f.storm === g.turn) toHell(g, a);
      fromZoneSummon(g, p, pl.deck, (x) => named(x, 'ราชาหิมะ'));
      shuffle(g, pl.deck);
      detach(g, c); P(g, c.owner).hell.push(c);
    },
  },
  'ผู้มาเยือน': {
    keep: 3,
    canCast: (g, p, c) => canPlaceAvatar(P(g, p)) && P(g, p).hand.some((x) => x !== c && symIs(x, 'เอเลี่ยน'))
      && P(g, p).deck.some((x) => isA(x) && symIs(x, 'เอเลี่ยน') && x.def.cost <= 4),
    resolve: (g, p, c) => {
      if (!discardWorst(g, p, 1, [c], (x) => symIs(x, 'เอเลี่ยน'))) return;
      const t = fromZoneSummon(g, p, P(g, p).deck, (x) => symIs(x, 'เอเลี่ยน') && x.def.cost <= 4);
      shuffle(g, P(g, p).deck);
      if (t && P(g, p).avatars.includes(t)) attach(g, c, t);
    },
    // v14: this card leaves the field (its wearer stays): send the wearer to Hell
    afterLeave: (g, self, info) => { const w = info.wearer; if (info.zone === 'mod' && w && fieldZone(g, w) === 'avatars') { log(g, `ผู้มาเยือน left: ${w.def.name} goes to Hell`); toHell(g, w); } },
  },

  // ===== นรก / วัลฮัลลา =====
  'นายนิรยบาล นิมมา': {
    keep: 3.5,
    jutsu: (g, c) => { myMill(g, c.ctrl, 2); draw(g, c.ctrl, 1); },
    // linkbot: below [link นายนิรยบาล ดาร์กช็อก]: only while in Link with ดาร์กช็อก
    onAttack: (g, c) => {
      if (!linked(g, c, 'นายนิรยบาล ดาร์กช็อก') || !once(g, c.ctrl, 'nimma:' + c.uid)) return; use(g, c.ctrl, 'nimma:' + c.uid);
      myMill(g, c.ctrl, 1);
      boost(c, P(g, c.ctrl).avatars.filter((a) => symIs(a, 'นรก')).length);
    },
  },
  'นายนิรยบาล ดาร์กช็อก': {
    keep: 2.5,
    // v14: any ธรณีสูบ this turn (from our Deck, or by our card), before or after this ability's use
    fieldActs: (g, p, c) => [act('ดาร์กช็อก: hell card to bottom of Deck', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'darkshock:' + c.uid)
      && (turnLog(g2).milled[p] > 0 || turnLog(g2).millBy[p] > 0 || P(g2, p).once[MILL_TAG] === g2.turn) && P(g2, p).hell.some((x) => !x.def.only),
    (g2) => { use(g2, p, 'darkshock:' + c.uid); const x = best(P(g2, p).hell.filter((y) => !y.def.only), (y) => keepValue(g2, y)); if (x) { detach(g2, x); P(g2, p).deck.push(x); } })],
  },
  'ซีเกิร์ด ผู้ปราบมังกรฟาฟเนียร์': {
    keep: 6,
    aura: (g, s, t) => (t.ctrl === s.ctrl && P(g, s.ctrl).avatars.includes(s) && P(g, t.ctrl).avatars.includes(t) && named(t, VAL) ? (named(t, 'บรุนฮิลด์') ? 2 : 1) : 0),
    fieldActs: (g, p, c) => [act('ซีเกิร์ด: recycle วัลฮัลลา, mill 3, destroy by Cost', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'sigurd')
      && hellAvatars(g2, p, (x) => named(x, VAL)).length > 0 && P(g2, opp(p)).avatars.length > 0,
    (g2) => {
      use(g2, p, 'sigurd');
      const pl = P(g2, p);
      const back = pickN(hellAvatars(g2, p, (y) => named(y, VAL)), 1, (y) => -keepValue(g2, y), { title: 'ซีเกิร์ด: return วัลฮัลลา from Hell to Deck (1-3)' });
      back.push(...pickN(hellAvatars(g2, p, (y) => named(y, VAL) && !back.includes(y)), 2, (y) => -keepValue(g2, y), { optional: true, title: 'ซีเกิร์ด: return more วัลฮัลลา (up to 3)' }));
      for (const x of back) { detach(g2, x); pl.deck.push(x); }
      shuffle(g2, pl.deck);
      const m = myMill(g2, p, 3);
      let budget = 2 + m.filter((x) => isA(x) && named(x, VAL)).length;
      for (;;) {
        const t = pickN(P(g2, opp(p)).avatars.filter((a) => a.def.cost <= budget), 1, (a) => value(g2, a), { optional: true, title: `ซีเกิร์ด: destroy (Cost left ${budget})` })[0];
        if (!t) break; budget -= t.def.cost; destroy(g2, t, p);
      }
    })],
    hellActs: (g, p, c) => [act('ซีเกิร์ด: mill 9, summon from hell', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c) && onZone(g2, p, 'บรุนฮิลด์').length > 0
      && canPlaceAvatar(P(g2, p)) && P(g2, p).deck.length > (humanSeat(g2, p) ? 8 : 14), // bugfix4: the 14-card margin is the bot's
    (g2) => { myMill(g2, p, 9); if (P(g2, p).hell.includes(c)) summon(g2, p, c, 'own'); })],
  },
  'ศาสตราวุธศักดิ์สิทธิ์ โวลุสปา': {
    keep: 3,
    canCast: (g, p) => onZone(g, p, VAL).length > 0,
    modTarget: (g, p) => best(onZone(g, p, VAL), (a) => value(g, a)),
    protectWearer: (g, m) => { detach(g, m); P(g, m.owner).hell.push(m); log(g, 'โวลุสปา is destroyed instead'); return true; },
    onMilled: (g, c, p) => { P(g, p).once['volu:' + c.uid] = g.turn; },
    hellActs: (g, p, c) => [act('โวลุสปา: equip from hell', (g2) => inMain(g2, p) && !P(g2, p).used.Modification && onZone(g2, p, VAL).length > 0
      && P(g2, p).hell.some((x) => x.def.name === c.def.name && P(g2, p).once['volu:' + x.uid] === g2.turn),
    (g2) => {
      const pl = P(g2, p);
      const v = pl.hell.find((x) => x.def.name === c.def.name && pl.once['volu:' + x.uid] === g2.turn);
      const w = best(onZone(g2, p, VAL), (a) => value(g2, a));
      if (!v || !w) return;
      pl.used.Modification = true; attach(g2, v, w);
    })],
  },

  // ===== นินจา / เทพ =====
  'วิชานินจา ผนึกเงา': {
    keep: 3,
    // v14: also offered when the opponent summons an Avatar (that Avatar can't change state: it can't attack this turn);
    // on an attack: another awake Avatar of theirs can't attack this turn
    react: {
      on: ['attack', 'summon'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.length > 0 && P(g, p).avatars.every((a) => named(a, 'นินจา'))
        && (ev.kind === 'summon' ? !!ev.source && P(g, opp(p)).avatars.includes(ev.source) : P(g, opp(p)).avatars.some((a) => a !== ev.source && !a.asleep)),
      want: (g, p, c, ev) => ev.kind === 'summon'
        ? g.active === ev.actor && !!ev.source && !ev.source.asleep && power(g, ev.source) >= 4
        : P(g, opp(p)).avatars.some((a) => a !== ev.source && !a.asleep && power(g, a) >= 3),
      resolve: (g, p, c, ev) => {
        const pool = ev.kind === 'summon' ? P(g, opp(p)).avatars : P(g, opp(p)).avatars.filter((a) => a !== ev.source && !a.asleep);
        const t = best(pool, (a) => (a === ev.source && ev.kind === 'summon' ? 5 : 0) + (a.asleep ? 0 : 3) + power(g, a));
        if (!t) return;
        t.f.noAttack = g.turn; if (t.asleep) t.noWakeUntil = Math.max(t.noWakeUntil, g.turn);
        log(g, `${t.def.name} can't change its state this turn (ผนึกเงา)`);
      },
    },
  },
  'พระอิศวร นักเต้น': {
    keep: 3.5,
    jutsu: (g, c) => peek(g, c.ctrl, 3, (top) => { takeHand(g, c.ctrl, top, (x) => !x.def.only && (named(x, 'พระแม่อุมาเทวี') || named(x, 'พระอิศวร'))); }, 'bottom'),
    fieldActs: (g, p, c) => [act('พระอิศวร: draw 1, give this to the opponent', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'ishvara:' + c.uid)
      && canPlaceAvatar(P(g2, opp(p))) && P(g2, p).deck.length > 3,
    (g2) => { use(g2, p, 'ishvara:' + c.uid); draw(g2, p, 1); if (!P(g2, p).avatars.includes(c) || !takeControl(g2, c, opp(p))) return; log(g2, `${c.def.name} moves to P${opp(p)}`); })],
  },
  'พระพิฆเนศ': {
    keep: 4,
    react: {
      on: ['ability', 'magic'], noLimit: true, onceKey: 'ganesha',
      can: (g, p, c, ev) => ev.actor !== p && !!ev.source && P(g, p).avatars.some((a) => a !== c && symIs(a, 'เทพ')),
      want: (g, p, c, ev) => {
        const fod = worst(P(g, p).avatars.filter((a) => a !== c && symIs(a, 'เทพ')), (a) => value(g, a));
        return !!fod && (keepValue(g, ev.source!) >= 5 || ev.source!.def.cost >= 6) && value(g, fod) < 7;
      },
      resolve: (g, p, c, ev) => { if (sacrifice(g, p, P(g, p).avatars.filter((a) => a !== c && symIs(a, 'เทพ')), 1)) ev.cancelled = true; },
    },
  },
  'การเลือกสรรของ พระพิฆเนศ': {
    keep: 3.5,
    canCast: (g, p) => onZone(g, p, 'พระพิฆเนศ').length > 0 && canPlaceAvatar(P(g, p)) && hellAvatars(g, p, (x) => symIs(x, 'เทพ') && x.def.cost <= 4 && !x.def.only).length > 0,
    resolve: (g, p) => { fromZoneSummon(g, p, P(g, p).hell, (x) => symIs(x, 'เทพ') && x.def.cost <= 4 && !x.def.only); },
  },
  'นารายณ์ 10 ปาง': {
    keep: 2.5,
    canCast: (g, p, c) => P(g, p).hand.some((x) => x !== c) && P(g, p).deck.length >= 3,
    resolve: (g, p) => { if (discardWorst(g, p, 1)) peek(g, p, 3, (top) => { takeHand(g, p, top, (x) => isA(x) && named(x, 'นารายณ์') && symIs(x, 'เทพ') && x.def.cost <= 6); }, 'bottom'); },
  },
  'ฤาษีอังคต': {
    keep: 3,
    onOwnMagic: (g, s, m) => {
      const p = s.ctrl;
      if (!symIs(m, 'ฤษี') || !P(g, p).avatars.includes(s) || !once(g, p, 'angkhot:' + s.uid)) return;
      const pool = [...P(g, opp(p)).avatars, ...P(g, p).avatars].filter((a) => symIs(a, 'สัตว์'));
      const t = best(pool, (a) => (a.ctrl !== p ? 10 + value(g, a) : power(g, a)));
      if (!t) return;
      use(g, p, 'angkhot:' + s.uid);
      if (t.ctrl !== p) destroy(g, t, p);
      else { boost(t, 2); t.f.angkhot = g.turn; }
    },
    grant: (g, s, t, kw) => kw === 'unite' && t.f.angkhot === g.turn,
  },

  // ===== สามก๊ก / Link =====
  // "เทิร์นละครั้ง เมื่อ Avatar เราที่อยู่ใน [Link] ใช้ สามัคคี หรือ โล่มนุษย์: เปลี่ยน Avatar ใบนั้นเป็นสภาพตื่น" (v13 hooks)
  'ซัลลี่วอดก้า': { keep: 3, onAssistUsed: (g, s, u, att, kind) => { if (kind === 'unity') vodkaWake(g, s, u); }, onShieldUsed: (g, s, sh) => vodkaWake(g, s, sh) },
  'ไมค์วิสกี้': {
    keep: 3.5, unite: true,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const t = best(P(g, p).hand.filter((x) => isA(x) && x.def.cost <= 4 && LINK4.includes(x.def.name) && !uniqueBlocked(g, p, x)), (x) => (x.def.name === 'ซัลลี่วอดก้า' ? 3 : 0) + x.def.power);
      if (t && canPlaceAvatar(P(g, p)) && summon(g, p, t, 'effect') && t.def.name === 'ซัลลี่วอดก้า') draw(g, p, 1);
    },
  },
  'ซุนฮูหยิน เจ้าหญิงขุนพลแห่งง่อก๊ก': {
    keep: 3,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => { takeHand(g, c.ctrl, top, (x) => isA(x) && named(x, 'ขุนพล') && symIs(x, 'ต่างชาติ') && ['แดง', 'เขียว'].some((k) => colorIs(x, k))); }),
  },
  'เตียวคับ ขุนพลสง่างามแห่งวุยก๊ก': {
    keep: 3.5,
    // "can't attack our other วุยก๊ก" = a taunt while we have another วุยก๊ก (confirmed)
    taunt: (g, c) => P(g, c.ctrl).avatars.some((a) => a !== c && named(a, 'วุยก๊ก')),
    // v14: summoned by the ability of an Avatar ขุนพล {ต่างชาติ} (โจโฉ, อ้วนเสี้ยว): POWER +2 and a LIFE hit deals 2 (GET)
    summonIf: (g, p, c) => noteSummoner(g, p, c),
    onSummon: (g, c, how) => {
      const s = summonerOf(g, c);
      if (how === 'paid' || !s || !isA(s) || !symIs(s, 'ต่างชาติ') || !(named(s, 'ขุนพล') || /โจโฉ|อ้วนเสี้ยว/.test(s.def.name))) return;
      c.f.genBy = 1; c.bonus += 2; log(g, `${c.def.name}: summoned by ${s.def.name}: POWER +2, LIFE damage 2`);
    },
    getActive: (g, c) => !!c.f.genBy && 'อัญเชิญโดย ขุนพล ต่างชาติ: POWER +2 · โจมตี LIFE สำเร็จ ทำความเสียหาย LIFE 2 ใบ',
    afterFight: (g, c, att, target) => {
      if (att !== c || target !== null || !c.f.genBy || g.winner !== null || !P(g, c.ctrl).avatars.includes(c)) return;
      if (turnLog(g).attacks[c.ctrl] > 0 && (c.f.genHit || 0) !== g.stats.lifeHits[opp(c.ctrl)]) { log(g, `${c.def.name}: LIFE damage 2`); hitLife(g, opp(c.ctrl), null); }
    },
    onAttack: (g, c, t) => { c.f.genHit = t === null ? g.stats.lifeHits[opp(c.ctrl)] : -1; },
  },
  // v14: ลิโป้ ขุนพลเทพสงคราม (in [Link] with this) attacks and destroys an opposing Avatar in battle: flip their top LIFE
  'ตันก๋ง กุนซือคู่กายเทพสงคราม': {
    keep: 2,
    onAnyDestroyed: (g, s, gone, info) => {
      const f = currentFight(), p = s.ctrl;
      if (!info.battle || !f || f.target !== gone || info.ctrl === p || !P(g, p).avatars.includes(s)) return;
      if (f.att.def.name !== LIPO || f.att.ctrl !== p || f.att.f.linkWith !== s.uid || !linked(g, s, LIPO) || g.winner !== null) return; // linkbot: needs the Link
      log(g, `${LIPO}: flips P${opp(p)}'s top LIFE (ตันก๋ง)`);
      flipLifeCard(g, opp(p));
    },
    getFor: (g, s, t) => (t.def.name === LIPO && t.ctrl === s.ctrl && linked(g, s, LIPO)
      ? 'ตันก๋ง: โจมตีและทำลาย Avatar จากการต่อสู้ → หงาย LIFE ฝ่ายตรงข้าม 1 ใบ' : null),
  } as any,
  'ม้าเฉียว ขุนพลทรนงแห่งจ๊กก๊ก': {
    keep: 3.5,
    // once per turn (the bot's battle estimates pass a copy of the card: they see the boost but don't use the once)
    battle: (g, c) => {
      if (!once(g, c.ctrl, 'machao:' + c.uid)) return;
      if (findCard(g, c.uid) === c) use(g, c.ctrl, 'machao:' + c.uid);
      c.temp.push({ power: 2, until: 'battle' });
    },
    endPhase: (g, c) => {
      const pl = P(g, c.ctrl);
      if (!pl.avatars.includes(c)) return;
      if (!pl.avatars.some((a) => a !== c && named(a, 'ขุนพล') && colorIs(a, 'เขียว') && symIs(a, 'ต่างชาติ'))) toHand(g, c);
    },
  },
  // its taunt is coded on กิมมิคแมน (confirmed). v14 answer: "ให้กิมมิคแมน ลงนรกก่อน ค่อยปรับ ออส่วนบอย Power เป็น 6":
  // our กิมมิคแมน is destroyed in the opponent's turn -> it goes to Hell (not saved), THEN this card's base POWER becomes 6
  // (lasts while ออส่วนบอย stays on the field: c.f is cleared when it leaves)
  'ออส่วนบอย': {
    keep: 2,
    onAnyDestroyed: (g: Game, self: Card, gone: Card, info: any) => {
      if (gone === self || info.zone !== 'avatars' || info.ctrl !== self.ctrl || g.active === self.ctrl || !named(gone, 'กิมมิคแมน')) return;
      if (!P(g, self.ctrl).avatars.includes(self) || self.f.osBase) return;
      self.f.osBase = 1;
      log(g, `${self.def.name}: base POWER becomes 6 (${gone.def.name} was destroyed)`);
    },
    staticPower: (g, c) => (c.f.osBase ? 6 - c.def.power : 0),
    getActive: (g: Game, self: Card) => !!self.f.osBase && 'กิมมิคแมน ถูกทำลาย: POWER ตั้งต้น 6',
  },
  'กิมมิคแมน': {
    keep: 3.5,
    jutsu: (g, c) => peek(g, c.ctrl, 3, (top) => { if (top.length) { const x = top[Math.floor(rand(g) * top.length)]; top.splice(top.indexOf(x), 1); P(g, c.ctrl).hand.push(x); } }),
    taunt: (g, c) => linked(g, c, 'ออส่วนบอย'),
  },

  // ===== misc Avatars =====
  'บ่าวแสม ซามูไรปักษ์ใต้': {
    keep: 3.5,
    onAttack: (g, c) => {
      const p = c.ctrl; if (!once(g, p, 'baosam:' + c.uid)) return; use(g, p, 'baosam:' + c.uid);
      exileTop(g, p, 1);
      const n = P(g, p).exile.length;
      if (n >= 3 && P(g, opp(p)).hand.length > 0) randDiscard(g, opp(p));
      else if (n >= 2) c.asleep = false;
      else if (n >= 1) boost(c, 1);
    },
  },
  'ลิขวิดบอย': {
    keep: 3,
    // when ลิขวิดบอย enters next to วอเตอร์แมน (confirmed); nothing happens when our Avatar Zone is full
    // v14 features: "เมื่อเข้าสู่สถานะ คู่หู" = when the Link action pairs it with วอเตอร์แมน
    onLink: (g, c) => { const w = P(g, c.ctrl).avatars.find((a) => a.def.name === 'วอเตอร์แมน' && a.f.linkWith === c.uid); const f = FX['วอเตอร์แมน']; if (w && f && f.jutsu && canPlaceAvatar(P(g, c.ctrl))) f.jutsu(g, w); },
  },
  'ริกกี้ แท็กซี่ตีนแมลงสาบ': {
    keep: 3,
    // v14: summoned by the ability of "หนังมนุษย์ ชุดแก้แค้น" or a "ริกกี้" card: base POWER 5
    summonIf: (g, p, c) => noteSummoner(g, p, c),
    onSummon: (g, c, how) => {
      const s = summonerOf(g, c);
      if (how !== 'paid' && s && (s.def.name.includes('หนังมนุษย์ ชุดแก้แค้น') || named(s, 'ริกกี้'))) { c.bonus = 5 - c.def.power; log(g, `${c.def.name}: base POWER 5 (summoned by ${s.def.name})`); }
    },
    onKill: (g, c, v) => { const pl = P(g, v.owner); if (pl.hell.includes(v)) { detach(g, v); pl.exile.push(v); } },
  },
  'เดออง อัศวินเฟมบอย': { keep: 3.5, shield: true, onTargeted: (g, c, att) => boost(att, -2) },
  'ฯลฯ กระบือชาวร๊อค': {
    keep: 3.5,
    // approx: +1 to our other Avatars during our Battle Phase (stands in for "when another of ours attacks")
    aura: (g, s, t) => (t !== s && t.ctrl === s.ctrl && g.phase === 'Battle' && g.active === s.ctrl && P(g, s.ctrl).avatars.includes(s) ? 1 : 0),
  },
  'ยอดมนุษย์หัวยางลบ': {
    keep: 3.5,
    fieldActs: (g, p, c) => [act('หัวยางลบ: silence an opponent Avatar', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'eraser:' + c.uid) && P(g2, opp(p)).avatars.length > 0,
      (g2) => {
        use(g2, p, 'eraser:' + c.uid);
        const t = best(P(g2, opp(p)).avatars, (a) => value(g2, a) + (FX[a.def.name] ? 2 : 0));
        if (t) { t.silencedTurn = g2.turn; t.f.rubber = g2.turn + 1; rubberPatch(t); log(g2, `${t.def.name} loses its abilities until the end of P${opp(p)}'s next turn`); }
      })],
    // v14: the loss lasts through the opponent's next turn even if หัวยางลบ has left (textOff on the target, rubberPatch)
  },
  'พี่หน่วงเพชรฆาตโซเชียล': {
    keep: 3.5,
    fieldActs: (g, p, c) => {
      const theirs = (g2: Game) => P(g2, p).mz.filter((x) => isA(x) && x.owner !== p);
      const ok = (g2: Game) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'nuangS:' + c.uid) && theirs(g2).length > 0;
      const pay = (g2: Game) => { use(g2, p, 'nuangS:' + c.uid); const x = worst(theirs(g2), (y) => y.def.power); if (x) toExile(g2, x); };
      return [
        act('พี่หน่วงโซเชียล: find คุณเก่ง/ทนาย/พี่หน่วง', (g2) => ok(g2) && P(g2, p).deck.length >= 5,
          (g2) => { pay(g2); peek(g2, p, 5, (top) => { takeHand(g2, p, top, (x) => named(x, 'คุณเก่ง') || named(x, 'ทนาย') || named(x, 'พี่หน่วง')); }, 'bottom'); }),
        act('พี่หน่วงโซเชียล: opponent hell Avatar to our Magic Zone', (g2) => ok(g2) && hellAvatars(g2, opp(p)).length > 0,
          (g2) => { pay(g2); const x = best(hellAvatars(g2, opp(p)), (y) => keepValue(g2, y)); if (x) { detach(g2, x); P(g2, p).mz.push(x); } }),
      ];
    },
  },
  'เนโกะเมะ ยูริ': {
    keep: 2.5,
    // v14: counts Land / Modification Magic used by either player.
    // simplify1 (exact): the draw lasts until the end of the opponent's next turn even if ยูริ leaves the field
    // (timed rules 'ยูริ:Land' / 'ยูริ:Modification' with the engine RuleDef.magic watcher)
    fieldActs: (g, p, c) => [
      act('ยูริ: draw on each Land', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'yuri:' + c.uid), (g2) => { use(g2, p, 'yuri:' + c.uid); addRule(g2, { p, key: 'ยูริ:Land', until: g2.turn + 1 }); }),
      act('ยูริ: draw on each Modification', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'yuri:' + c.uid), (g2) => { use(g2, p, 'yuri:' + c.uid); addRule(g2, { p, key: 'ยูริ:Modification', until: g2.turn + 1 }); }),
    ],
  },
  'ชิบาตะ โบตัน': {
    keep: 3,
    // v14: Cost and base POWER swap until end of turn (view.ts swapCostPower: the detail box shows both)
    fieldActs: (g, p, c) => {
      const gain = (a: Card) => { const d = costOf(g, a.ctrl, a) - (a.def.power + a.bonus); return a.ctrl === p ? d : -d; };
      return [act('ชิบาตะ: swap Cost and base POWER', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'shibata:' + c.uid)
        && g2.p.some((q) => q.avatars.some((a) => gain(a) > 0)),
      (g2) => {
        use(g2, p, 'shibata:' + c.uid);
        const t = best([...g2.p[0].avatars, ...g2.p[1].avatars], gain);
        if (t) { swapCostPower(g2, t, 'turn'); log(g2, `${t.def.name}: Cost and POWER swapped (ชิบาตะ)`); }
      })];
    },
  },
  'ชาช่า อัศวินตลิ่งชันคนเก่ง': {
    keep: 3.5,
    onAttack: (g, c) => { const av = P(g, c.ctrl).avatars; boost(c, av.filter(NAT).length + av.flatMap((a) => a.mods).filter(NAT).length); },
  },
  'น้ากบ': {
    keep: 2.5,
    jutsu: (g, c) => { const t = best(onZone(g, c.ctrl, 'กบ'), (a) => power(g, a) + (a.asleep ? 0 : 2)); if (t) t.bonus += 3; },
  },
  'เจ้าแห่งความมืด': {
    keep: 6,
    handActs: (g, p, c) => [act('เจ้าแห่งความมืด: send 1 to hell, summon', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && P(g2, opp(p)).avatars.length >= 4 && canPlaceAvatar(P(g2, p)),
      (g2) => { const t = best(P(g2, opp(p)).avatars, (a) => value(g2, a)); if (t) removeOpp(g2, p, t, 'hell', false); summon(g2, p, c, 'own'); })],
    endPhase: (g, c) => { if (!P(g, c.ctrl).avatars.includes(c)) return; const b = c.def.power + c.bonus; c.bonus = Math.floor(b / 2) - c.def.power; },
  },
  'ไมค์ตี้ทอยแมน': {
    keep: 3.5,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const all = [...P(g, opp(p)).avatars, ...P(g, p).avatars].flatMap((a) => a.mods);
      const mods = humanDeciding(g) ? all : all.filter((m) => m.owner === opp(p));
      const mode = mods.length ? chooseMode(g, c, ['Destroy a worn card on the field', 'Scout 5: a Modification to hand, rest under Deck'], 0) : 1;
      const m = mode === 0 ? best(mods, (x) => (x.owner === p ? -1 : 1) * keepValue(g, x)) : null;
      if (m) { detach(g, m); P(g, m.owner).hell.push(m); return; }
      peek(g, p, 5, (top) => { takeHand(g, p, top, (x) => x.def.type === 'Magic' && x.def.subtype === 'Modification'); }, 'bottom');
    },
  },
  'ยูนิคอร์นขี้เมา': {
    keep: 2.5,
    deathCry: (g, c, owner) => peek(g, owner, 7, (top) => { takeSummon(g, owner, top, (x) => x.def.name === 'ยูนิคอร์นขี้เมา'); }),
  },
  'ภูติผลไม้ แตงกวา': {
    keep: 2,
    staticPower: (g, c) => (!!landOn(g, 'ป่าพงไพร เผ่าพงศ์พันธุ์') ? P(g, c.ctrl).exile.filter((x) => named(x, 'ภูติผลไม้')).length : 0),
    deathCry: (g, c, owner) => {
      if (!landOn(g, 'ป่าพงไพร เผ่าพงศ์พันธุ์')) return;
      const pl = P(g, owner); const x = best(pl.exile.filter((y) => named(y, 'ภูติผลไม้')), (y) => keepValue(g, y));
      if (x) { detach(g, x); pl.deck.push(x); shuffle(g, pl.deck); }
    },
  },
  'มาดามทาบิ': { keep: 2.5 }, // its static protects Constructs from card abilities; nothing in the engine destroys Constructs
  'นักฆ่าแม่เหล็ก มอนซี': {
    keep: 3.5,
    fieldActs: (g, p, c) => [act('มอนซี: discard an Avatar, -4', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'monsi:' + c.uid)
      && P(g2, p).hand.some(isA) && P(g2, opp(p)).avatars.length > 0,
    (g2) => {
      use(g2, p, 'monsi:' + c.uid);
      if (!discardWorst(g2, p, 1, [], isA)) return;
      const t = best(P(g2, opp(p)).avatars, (a) => value(g2, a) + (power(g2, a) <= 4 ? 3 : 0)); if (t) boost(t, -4);
    })],
    // v14: not destroyed as the result of a fight (POWER compared in battle) while we control an Avatar with another name;
    // abilities can still destroy it in the Battle Phase
    leaveGuard: (g, self, t, info) => (t === self && info.how === 'destroy' && info.battle && P(g, self.ctrl).avatars.some((a) => a !== self && a.def.name !== self.def.name)
      ? { optional: false, label: 'not destroyed by battle', run: () => true } : null),
  },
  'คุณคำดี': {
    keep: 4, unique: true, alias: ['สมาชม'],
    jutsu: (g, c) => { const pl = P(g, c.ctrl); fromZoneSummon(g, c.ctrl, pl.deck, (x) => named(x, 'สมาชม') && x.def.name !== c.def.name); shuffle(g, pl.deck); },
    onAttack: (g, c) => { if (onZone(g, c.ctrl, 'สมาชม').length >= 2) boost(c, Math.floor((hellAvatars(g, c.ctrl).length + hellAvatars(g, opp(c.ctrl)).length) / 2), 'battle'); }, // other-team audit: "Avatar ในนรก" = both Hells
    aura: (g, s, t) => (t.ctrl === s.ctrl && P(g, s.ctrl).avatars.includes(s) && P(g, t.ctrl).avatars.includes(t) ? -1 : 0),
  },
  'แยกกันไปแตก': {
    keep: 5, options: 2,
    canCast: (g, p, c, o) => distinctNames(onZone(g, p, 'สมาชม')) >= 4 && distinctNames(hellAvatars(g, p, (x) => named(x, 'สมาชม'))) >= 4
      && (o === 0 ? P(g, opp(p)).hand.length > 0 : P(g, opp(p)).avatars.length > 0),
    resolve: (g, p, c, o) => {
      const seen = new Set<string>();
      for (const x of hellAvatars(g, p, (y) => named(y, 'สมาชม'))) { if (seen.size >= 4 || seen.has(x.def.name)) continue; seen.add(x.def.name); toExile(g, x); }
      if (seen.size < 4) return;
      if (o === 0) for (const x of [...P(g, opp(p)).hand]) discard(g, opp(p), x);
      else for (const a of [...P(g, opp(p)).avatars]) destroy(g, a, p, true);
    },
  },

  // ===== เรื่องราว =====
  'นักท่องเรื่องราว มายา': {
    keep: 3.5,
    // our Main Phase or Battle Phase (v14c battleField: offered with the attacks), outside a fight
    battleField: true,
    fieldActs: (g, p, c) => [act('มายา: swap in a เรื่องราว', (g2) => (inMain(g2, p) || (g2.phase === 'Battle' && g2.active === p && !currentFight(g2)))
      && P(g2, p).avatars.includes(c)
      && P(g2, p).hand.some((x) => storyOk(g2, p, x)),
    (g2) => {
      const s = best(P(g2, p).hand.filter((x) => storyOk(g2, p, x)), (x) => x.def.power);
      if (s) mayaSwap(g2, p, c, s);
    })],
  },
  'มายา เรื่องราว เทพเจ้าสายฟ้า': {
    keep: 4,
    onSummon: (g, c) => { if (P(g, c.ctrl).once['traveler:' + c.uid] === g.turn) { c.f.byTraveler = 1; search(g, c.ctrl, (x) => x.def.type === 'Magic' && x.def.name.startsWith('Skill'), 'deck'); } },
    // v14 answer: +1 is permanent; only when this card's controller uses a Magic in their own turn (never in the opponent's turn)
    onOwnMagic: (g, s) => { if (s.f.byTraveler && g.active === s.ctrl && P(g, s.ctrl).avatars.includes(s) && once(g, s.ctrl, 'thunder:' + s.uid)) { use(g, s.ctrl, 'thunder:' + s.uid); addPower(g, s, 1, 'perm', s); } },
    getActive: (g, c) => !!c.f.byTraveler && 'อัญเชิญโดย นักท่องเรื่องราว: Skill จาก Deck · เราใช้ Magic ในเทิร์นเรา: POWER +1 ถาวร (เทิร์นละครั้ง)',
  },

  // ===== ยักษ์ =====
  'อาเมอร์ ทศกัณท์': armor('ทศกัณท์'),
  'อาเมอร์ ทศกัณฐ์': armor('ทศกัณฐ์'),
  'พิเภก': {
    keep: 3,
    fieldActs: (g, p, c) => [act('พิเภก: recycle ยักษ์ POWER 3, draw 1', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'pipek:' + c.uid)
      && hellAvatars(g2, p, (x) => symIs(x, 'ยักษ์') && x.def.power === 3).length > 0,
    (g2) => {
      use(g2, p, 'pipek:' + c.uid);
      const x = best(hellAvatars(g2, p, (y) => symIs(y, 'ยักษ์') && y.def.power === 3), (y) => keepValue(g2, y));
      if (!x) return; detach(g2, x); P(g2, p).deck.push(x); shuffle(g2, P(g2, p).deck); draw(g2, p, 1);
    })],
  },

  // ===== มือปืนนคร / อาวุธนคร =====
  'นครทิเนนทอล': {
    keep: 4,
    // "can only be destroyed by being attacked": Constructs are never destroyed in the engine anyway
    fieldActs: (g, p, c) => [
      act('นครทิเนนทอล: exile an อาวุธนคร from top 5', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'nakhon1') && P(g2, p).deck.length >= 5,
        (g2) => { use(g2, p, 'nakhon1'); peek(g2, p, 5, (top) => { const w = best(top.filter(isWeapon), (x) => keepValue(g2, x)); if (w) { top.splice(top.indexOf(w), 1); P(g2, p).exile.push(w); } }); }),
      act('นครทิเนนทอล: equip อาวุธนคร from exile, +2', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'nakhon2') && !P(g2, p).used.Modification
        && P(g2, p).exile.some((m) => isWeapon(m) && P(g2, p).avatars.some((a) => canWear(a, m))),
      (g2) => {
        use(g2, p, 'nakhon2');
        const pl = P(g2, p);
        const m = best(pl.exile.filter((x) => isWeapon(x) && pl.avatars.some((a) => canWear(a, x))), (x) => keepValue(g2, x));
        const w = m ? best(pl.avatars.filter((a) => canWear(a, m)), (a) => value(g2, a) + (a.asleep ? 0 : 3)) : null;
        if (!m || !w) return;
        pl.used.Modification = true; attach(g2, m, w); boost(w, 2);
      }),
    ],
  },
  'มือปืนนคร บ่าวจุ้ย': {
    keep: 4, unique: true,
    // v14: at the end of the fight it attacked in (optional สั่งใช้: popup)
    afterFight: (g, c, att) => {
      const p = c.ctrl, pl = P(g, p);
      if (att !== c || !pl.avatars.includes(c) || !hasNakhon(g, p) || !once(g, p, 'juiA:' + c.uid)) return;
      const worn = c.mods.filter(isWeapon); if (!worn.length) return;
      const swap = (w: Card) => pl.exile.filter((x) => isWeapon(x) && x.def.name !== w.def.name && !c.mods.some((m) => m !== w && m.def.name === x.def.name));
      if (!worn.some((w) => swap(w).length) || !mayDo(g, c, 'exile a worn อาวุธนคร, wear another from the Dark Dimension, wake up', true)) return;
      const w0 = best(worn.filter((w) => swap(w).length), (w) => -keepValue(g, w)); if (!w0) return;
      const nw = best(swap(w0), (x) => keepValue(g, x)); if (!nw) return;
      use(g, p, 'juiA:' + c.uid);
      toExile(g, w0, { cost: true }); attach(g, nw, c); c.asleep = false;
      log(g, `บ่าวจุ้ย: ${w0.def.name} -> ${nw.def.name}, wakes up`);
    },
  },
  'มือปืนนคร ชานน': {
    keep: 3,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl); if (!hasNakhon(g, c.ctrl)) return;
      const w = best(pl.deck.filter(isWeapon), (x) => keepValue(g, x)); if (w) { detach(g, w); pl.exile.push(w); }
      shuffle(g, pl.deck);
    },
  },
  'มือปืนนคร นายหัว': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p); if (hasNakhon(g, p)) return;
      const d = pl.deck.find((x) => x.def.name === NAKHON);
      const x = d || pl.hell.find((y) => y.def.name === NAKHON);
      if (x) summon(g, p, x, 'effect');
      if (d) shuffle(g, pl.deck);
    },
    fieldActs: (g, p, c) => [act('นายหัว: exile อาวุธนคร from hand, draw 2', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'naihua:' + c.uid)
      && hasNakhon(g2, p) && P(g2, p).hand.some(isWeapon),
    (g2) => { use(g2, p, 'naihua:' + c.uid); const w = worst(P(g2, p).hand.filter(isWeapon), (x) => keepValue(g2, x)); if (w) { toExile(g2, w); draw(g2, p, 2); } })],
  },
  'อาวุธนคร ปืนพกงูเห่า': weapon({
    // v14: the Avatar the wearer destroys in battle loses its คำสั่งเสีย
    blockDeathCry: (g, m, dying, info) => info.battle && currentFight()?.att.uid === m.wearer && dying.ctrl !== m.ctrl,
    wearerBattle: (g, m, w) => { if (g.active === w.ctrl) boost(w, 1, 'battle'); },
  }),
  'อาวุธนคร ลูกซองจุ้ย': weapon({
    wearerBattle: (g, m, w) => { if (g.active === w.ctrl) boost(w, 2, 'battle'); },
    onWearerKill: (g, m, w) => hitLife(g, opp(w.ctrl), null),
  }),
  'อาวุธนคร ดินสอ 5H': weapon({
    // v14: no React Magic for the opponent until the end of the wearer's fight
    blockReact: (g, m, ev) => { const f = currentFight(); if (!f || f.att.uid !== m.wearer) return null; return (ev.responder ?? opp(ev.actor)) !== m.ctrl ? 'magic' : null; },
  }),

  // ===== เครื่องใช้ไฟฟ้า =====
  'มนุษย์เครื่องใช้ไฟฟ้า เบเซอร์': mzOnDeath(false, {
    keep: 4,
    jutsu: (g, c) => { const pl = P(g, c.ctrl); const x = best(pl.deck.filter((y) => isA(y) && named(y, APPLIANCE) && y.def.name !== c.def.name), (y) => keepValue(g, y)); if (x) toMz(g, x, c.ctrl); shuffle(g, pl.deck); },
    fieldActs: (g, p, c) => [act('เบเซอร์: เครื่องใช้ไฟฟ้า from hand to Magic Zone, draw 1', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'bezer:' + c.uid)
      && P(g2, p).hand.some((x) => isA(x) && named(x, APPLIANCE)),
    (g2) => { use(g2, p, 'bezer:' + c.uid); const x = worst(P(g2, p).hand.filter((y) => isA(y) && named(y, APPLIANCE)), (y) => keepValue(g2, y)); if (x) { toMz(g2, x, p); if (mayDo(g2, c, 'draw 1', P(g2, p).deck.length > 3)) draw(g2, p, 1); } })], // bugs7 item 7: "สามารถ" = optional
  }),
  'เครื่องใช้ไฟฟ้า เฟเธอร์': mzOnDeath(false, { keep: 2, tieWin: true, fieldActs: applianceFromMz() }),
  'เครื่องใช้ไฟฟ้า ฟรีซเซอร์': mzOnDeath(false, { keep: 2, shield: true, fieldActs: applianceFromMz() }),
  'เบเซอร์ โหมด เฟเธอร์': {
    keep: 4.5, unique: true,
    // v14: only at the start of our Battle Phase (before the first attack)
    handActs: (g, p, c) => [act('เบเซอร์ โหมด เฟเธอร์: return 2 from Magic Zone, summon', (g2) => g2.phase === 'Battle' && g2.active === p && turnLog(g2).attacks[p] === 0 && P(g2, p).hand.includes(c)
      && canPlaceAvatar(P(g2, p)) && !uniqueBlocked(g2, p, c) && modeParts(g2, p, 'เครื่องใช้ไฟฟ้า เฟเธอร์') !== null,
    (g2) => { const parts = modeParts(g2, p, 'เครื่องใช้ไฟฟ้า เฟเธอร์'); if (!parts) return; for (const x of parts) toDeck(g2, x, 'bottom', { cost: true }); shuffle(g2, P(g2, p).deck); summon(g2, p, c, 'own'); })],
    onOwnSummon: (g, c) => { c.f.mode = 1; },
    kwIf: (g, c, kw) => kw === 'tieWin' && !!c.f.mode,
    onAttack: (g, c, t) => { if (c.f.mode && t && power(g, t) >= power(g, c) + 3) boost(c, 5); },
  },
  'เบเซอร์ โหมด ฟรีซเซอร์': {
    keep: 4.5, unique: true,
    // v14: only at the start of the opponent's Battle Phase (battleStart window)
    react: {
      on: ['battleStart'], noLimit: true, fromHand: true, onceKey: 'freezermode',
      can: (g, p, c, ev) => ev.actor !== p && canPlaceAvatar(P(g, p)) && !uniqueBlocked(g, p, c) && modeParts(g, p, 'เครื่องใช้ไฟฟ้า ฟรีซเซอร์') !== null,
      want: (g, p) => P(g, opp(p)).avatars.some((a) => !a.asleep && power(g, a) <= 6),
      resolve: (g, p, c) => {
        const parts = modeParts(g, p, 'เครื่องใช้ไฟฟ้า ฟรีซเซอร์'); if (!parts) return;
        for (const x of parts) toDeck(g, x, 'bottom', { cost: true });
        shuffle(g, P(g, p).deck);
        summon(g, p, c, 'own');
      },
    },
    onOwnSummon: (g, c) => { c.f.mode = 1; },
    kwIf: (g, c, kw) => kw === 'shield' && !!c.f.mode,
    taunt: (g, c) => !!c.f.mode && c.asleep,
  },
  'แป้นสกุล อิเล็กทรอนิกส์': {
    keep: 2.5,
    fieldActs: (g, p, c) => [act('แป้นสกุล: เครื่องใช้ไฟฟ้า from top 5 to Magic Zone', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'keyboard') && P(g2, p).deck.length >= 5,
      (g2) => { use(g2, p, 'keyboard'); peek(g2, p, 5, (top) => { const x = best(top.filter((y) => isA(y) && named(y, APPLIANCE)), (y) => keepValue(g2, y)); if (x) { top.splice(top.indexOf(x), 1); x.ctrl = p; P(g2, p).mz.push(x); } }); })],
  },
  'รูปประจำบ้าน': { keep: 1.5, lockCtrl: true }, // v13: every control change goes through engine takeControl / canChangeCtrl
  'ดวงจันทร์วันเพ็ญ': {
    keep: 2.5,
    aura: (g, s, t) => (t.ctrl === s.ctrl && P(g, s.ctrl).mz.includes(s) && BANG.includes(t.def.name) ? 1 : 0),
    grant: (g, s, t, kw) => kw === 'shield' && t.ctrl === s.ctrl && P(g, s.ctrl).mz.includes(s) && BANG.includes(t.def.name),
  },

  // ===== Overdose / นัท / ไวรัส / generic Magic =====
  'Cross Vaccine': {
    keep: 3,
    canCast: (g, p) => !critical(P(g, p)) && flippedLife(P(g, p)) <= 3 && P(g, p).avatars.some((a) => named(a, 'Overdose'))
      && P(g, p).deck.some((x) => isA(x) && named(x, 'Overdose') && !x.def.only),
    resolve: (g, p) => {
      hitLife(g, p, null);
      if (g.winner !== null) return;
      const s = worst(P(g, p).avatars.filter((a) => named(a, 'Overdose')), (a) => value(g, a));
      if (!s) return;
      const nm = s.def.name; backToDeck(g, s);
      const t = fromZoneSummon(g, p, P(g, p).deck, (x) => named(x, 'Overdose') && x.def.name !== nm && !x.def.only);
      shuffle(g, P(g, p).deck);
      if (t && P(g, p).avatars.includes(t)) { boost(t, 2); t.magicImmuneUntil = g.turn; }
    },
  },
  'สู่โลกอันเปล่งประกาย!': {
    keep: 3,
    canCast: (g, p) => {
      const top = Math.max(-1, ...P(g, p).avatars.filter(NAT).map((a) => a.def.cost));
      return canPlaceAvatar(P(g, p)) && hellAvatars(g, p, (x) => named(x, 'อัศวินตลิ่งชัน') && x.def.cost <= top).length > 0;
    },
    resolve: (g, p) => {
      const ch = best(P(g, p).avatars.filter(NAT), (a) => a.def.cost);
      if (!ch) return;
      fromZoneSummon(g, p, P(g, p).hell, (x) => named(x, 'อัศวินตลิ่งชัน') && x.def.cost <= ch.def.cost);
      const field = [...P(g, p).avatars, ...P(g, p).avatars.flatMap((a) => a.mods)];
      if (field.some((x) => named(x, 'ชาช่า') || named(x, 'มีมมิ'))) draw(g, p, 1);
    },
  },
  'ดาบแห่งแสงอรุณ & นัทคาลิเบอร์': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.some(NAT),
    modTarget: (g, p) => best(P(g, p).avatars.filter(NAT), (a) => (named(a, 'ไอ้นัท') && P(g, p).deck.some((x) => isA(x) && named(x, 'เซอร์นัท')) ? 5 : 0) + value(g, a)),
    // the เซอร์นัท branch (+1 to our other อัศวินตลิ่งชัน) is an aura added to the เซอร์นัท entries at the end of this file
    fieldActs: (g, p, m) => [act('นัทคาลิเบอร์: sacrifice ไอ้นัท, call เซอร์นัท', (g2) => {
      if (!inMain(g2, p) || m.wearer < 0) return false;
      const w = findCard(g2, m.wearer);
      return !!w && P(g2, p).avatars.includes(w) && named(w, 'ไอ้นัท') && P(g2, p).hand.length >= 1 && P(g2, p).deck.some((x) => isA(x) && named(x, 'เซอร์นัท'));
    }, (g2) => {
      const w = findCard(g2, m.wearer); if (!w || !P(g2, p).avatars.includes(w)) return;
      destroy(g2, w, p);
      if (!discardWorst(g2, p, 1)) return;
      fromZoneSummon(g2, p, P(g2, p).deck, (x) => named(x, 'เซอร์นัท'), 'jutsu');
      shuffle(g2, P(g2, p).deck);
    })],
  },
  'ระเบิดความเกลียดชัง': {
    keep: 2,
    canCast: (g) => g.p[0].avatars.length + g.p[1].avatars.length >= 10,
    resolve: (g) => {
      for (const q of g.p) { for (const a of [...q.avatars]) toHell(g, a); for (const x of [...q.mz]) toHell(g, x); }
      if (g.land) { const l = g.land; g.land = null; P(g, l.owner).hell.push(l); }
    },
  },
  'อินสตอล บึ้มทั้งไดรฟ์': {
    keep: 3,
    canCast: (g, p) => virusHell(g, p).length >= 2,
    resolve: (g, p, c) => {
      for (const x of worstN(virusHell(g, p), 2, (y) => keepValue(g, y), { title: 'อินสตอล: exile 2 ไวรัส from Hell' })) toExile(g, x);
      const ex = P(g, p).exile.filter((x) => isA(x) && named(x, 'ไวรัส'));
      if (ex.length >= 5 && mayDo(g, c, 'summon a ไวรัส from the Dark Dimension', true)) fromZoneSummon(g, p, P(g, p).exile, (x) => named(x, 'ไวรัส'));
    },
  },
  'ไฮแจ็ค ไฮรีเทิร์น': {
    keep: 3.5,
    react: {
      on: ['attack'],
      can: (g, p, c, ev) => ev.actor !== p && !!ev.source && virusHell(g, p).length > 0,
      want: (g, p, c, ev) => !!ev.target && power(g, ev.source!) >= power(g, ev.target) && value(g, ev.target) >= 3,
      resolve: (g, p, c, ev) => {
        const x = worst(virusHell(g, p), (y) => keepValue(g, y)); if (!x) return;
        toExile(g, x);
        const s = ev.source; if (s) boost(s, -(s.def.power + s.bonus), 'battle');
      },
    },
  },
  'มัลแวร์โซน': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [act('มัลแวร์โซน: exile ไวรัส, opponent mills 1', (g2) => inMain(g2, p) && once(g2, p, 'malware') && virusHell(g2, p).length > 0,
      (g2) => { use(g2, p, 'malware'); const x = worst(virusHell(g2, p), (y) => keepValue(g2, y)); if (x) { toExile(g2, x); mill(g2, opp(p), 1); } })],
  },
  'ให้ข้าวฉันถ้าคุณเป็นคนดี': {
    keep: 2,
    // v14: at the start of the opponent's Battle Phase: their chosen Avatar gets "when this attacks, its opponent (us) draws 1"
    // until end of turn; they then decide whether to attack with it
    react: {
      on: ['battleStart'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, ev.actor).avatars.length > 0,
      want: (g, p, c, ev) => P(g, p).hand.filter((x) => x !== c && x.def.type === 'Magic' && x.def.subtype === 'React').length === 0
        && P(g, ev.actor).avatars.some((a) => !a.asleep),
      resolve: (g, p, c, ev) => {
        const t = best(P(g, ev.actor).avatars, (a) => (a.asleep ? 0 : 10) + power(g, a));
        if (!t) return;
        t.f.rice = g.turn; ricePatch(t);
        log(g, `${t.def.name}: "when this attacks, P${p} draws 1" until end of turn (ให้ข้าวฉัน)`);
      },
    },
  },
  'เหตุผลที่ยังหายใจ': {
    keep: 3,
    // v14: the React window opens when our 2nd Avatar of this turn is destroyed (turnLog)
    react: {
      on: ['destroyed'],
      can: (g, p, c, ev) => !!ev.leave && ev.leave.ctrl === p && ev.leave.zone === 'avatars' && turnLog(g).destroyed[p] === 2 && P(g, p).hell.length > 0 && P(g, p).avatars.length > 0,
      want: (g, p) => (g.active !== p ? P(g, opp(p)).avatars.some((a) => !a.asleep) : g.phase !== 'End' && P(g, p).avatars.some((a) => !a.asleep)),
      resolve: (g, p) => {
        const x = worst(P(g, p).hell, (y) => keepValue(g, y)); if (!x) return;
        detach(g, x); P(g, p).exile.push(x);
        const t = best(P(g, p).avatars, (a) => power(g, a) + (a.asleep ? 0 : 3)); if (t) boost(t, 8);
      },
    },
  },
  'Myth Universe Podcast': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [act('Myth Podcast: reveal an Avatar, +2 to up to 2 matching', (g2) => inMain(g2, p) && once(g2, p, 'myth') && mythPick(g2, p) !== null,
      (g2) => {
        use(g2, p, 'myth');
        const pk = mythPick(g2, p); if (!pk) return;
        let [h, ts] = pk;
        if (humanDeciding(g2)) {
          // the human picks the Avatar to reveal, the attribute and 1-2 matching Avatars
          const AT: [string, (x: Card) => string | number][] = [['POWER', (x) => x.def.power], ['Symbol', (x) => x.def.symbol], ['Cost', (x) => x.def.cost], ['GEM', (x) => x.def.gem], ['colour', (x) => x.def.color]];
          const pl = P(g2, p);
          const hh = best(pl.hand.filter((x) => isA(x) && AT.some(([, f]) => pl.avatars.some((a) => f(a) === f(x)))), (x) => (x === h ? 100 : 0) - keepValue(g2, x));
          if (!hh) return;
          const ok = AT.filter(([, f]) => pl.avatars.some((a) => f(a) === f(hh)));
          const k = chooseMode(g2, c, ok.map(([n, f]) => `${n} = ${f(hh)}`), 0);
          const f = ok[k][1];
          const m = pl.avatars.filter((a) => f(a) === f(hh));
          const first = pickN(m, 1, (a) => (a.asleep ? 0 : 10) + power(g2, a), { title: 'Myth Podcast: POWER +2' });
          ts = [...first, ...pickN(m.filter((a) => !first.includes(a)), 1, (a) => (a.asleep ? 0 : 10) + power(g2, a), { optional: true, title: 'Myth Podcast: a second Avatar (optional)' })];
          h = hh;
        }
        for (const t of ts) boost(t, 2);
        toExile(g2, h);
      })],
  },
} as Record<string, Fx>);

// ซัลลี่วอดก้า: an Avatar of ours in its [Link] (ซัลลี่วอดก้า itself or ไมค์วิสกี้, while both are on our zone) used สามัคคี / โล่มนุษย์
function vodkaWake(g: Game, s: Card, u: Card) {
  // linkbot: ซัลลี่ itself must be in Link with ไมค์วิสกี้; "Avatar เราที่อยู่ใน [Link]" = any of ours in a Link pair
  if (u.ctrl !== s.ctrl || !linked(g, s, 'ไมค์วิสกี้') || !inLinkG8(g, u) || !once(g, s.ctrl, 'vodka:' + s.uid)) return;
  use(g, s.ctrl, 'vodka:' + s.uid);
  u.asleep = false;
  log(g, `ซัลลี่วอดก้า: ${u.def.name} becomes awake`);
}

// =====================================================================================================================
// v14 group F (user rulings): helpers and patches of entries defined in earlier files (cards.ts, cards2.ts, g1..g7).
// Patches compose with the earlier entry (patchFx) instead of replacing it, so other groups' work on the same cards stays.
// =====================================================================================================================
const THRONE_F = 'บัลลังก์ตั๊กแตนศตวรรษ';
const LIPO = 'ลิโป้ ขุนพลเทพสงคราม';
const CAMP_F = 'ค่ายบางระจัน';
const CHID = 'ไอ้ชิด อโยธยา Express';

// card texts (text box) from the card data, for "has X in its Text Box" checks
const TXT = new Map<string, string>(), TYPE = new Map<string, string>();
try {
  const raw = JSON.parse(fs.readFileSync(new URL('../../data/cards.json', import.meta.url), 'utf8'));
  for (const c of raw) if (!TXT.has(c.name)) { TXT.set(c.name, String(c.effect || '')); TYPE.set(c.name, String(c.type || '')); }
} catch { /* fallback lists below */ }
const textHas = (c: Card, key: string) => (TXT.get(c.def.name) || '').includes(key);
const namesWhere = (pred: (name: string, text: string) => boolean, fallback: string[]) => {
  const out = [...TXT.entries()].filter(([n, t]) => pred(n, t)).map(([n]) => n);
  return out.length ? out : fallback;
};
const BANG_AV = new Set(BANG);
const isBRJ = (c: Card) => isA(c) && (BANG_AV.has(c.def.name) || textHas(c, CAMP_F));
const bangCamp = (g: Game, p: PID) => P(g, p).mz.some((x) => x.def.type === 'Construct' && x.def.name === CAMP_F);
const chid = (g: Game, p: PID) => P(g, p).avatars.some((a) => a.def.name === CHID && !silenced(g, a));
const grasshopper = (c: Card) => isA(c) && (nameHas(c, 'ตั๊กแตน') || textHas(c, 'ตั๊กแตน'));

/** Compose extra hooks into FX[name] (created when missing): aura / staticPower add up, boolean hooks OR, guard-like hooks
 *  take the first non-null, handActs / fieldActs concatenate, anything else replaces. */
function patchFx(name: string, add: Record<string, any>) {
  const f: any = FX[name] || (FX[name] = {} as Fx);
  for (const [k, fn] of Object.entries(add)) {
    const prev = f[k];
    if (typeof prev !== 'function' || typeof fn !== 'function') { f[k] = fn; continue; }
    if (k === 'aura' || k === 'staticPower' || k === 'modPower') f[k] = (...a: any[]) => (prev(...a) || 0) + (fn(...a) || 0);
    else if (['noTarget', 'blockDeathCry', 'blockSummon', 'blockCast', 'canBeAttacked', 'noLifeAttack', 'untargetable', 'grant', 'magicImmune', 'shieldFrom', 'unaffected', 'refuseMod'].includes(k)) f[k] = (...a: any[]) => !!prev(...a) || !!fn(...a);
    else if (k === 'leaveGuard' || k === 'textOff' || k === 'blockReact') f[k] = (...a: any[]) => fn(...a) ?? prev(...a);
    // the bot's Battle Phase loop runs handActs(...)[0]: the acts that can run now come first
    else if (k === 'handActs' || k === 'fieldActs') f[k] = (...a: any[]) => { const xs: HandAct[] = [...prev(...a), ...fn(...a)]; const ok = (x: HandAct) => { try { return x.can(a[0]); } catch { return false; } }; return k === 'handActs' ? [...xs.filter(ok), ...xs.filter((x) => !ok(x))] : xs; };
    else if (['deathCry', 'afterLeave', 'onSummon', 'startBattle', 'onAttack', 'afterFight', 'onAnyDestroyed'].includes(k)) f[k] = (...a: any[]) => { prev(...a); fn(...a); };
    else f[k] = fn;
  }
}
/** The FX entry fx() finds for c (by name, else by print); created by name when there is none. */
function entryOf(c: Card): any { return FX[c.def.name] || FX[c.def.print] || (FX[c.def.name] = { keep: 1.5 + c.def.power * 0.6 } as Fx); }

// ---- summon source: summonIf runs inside summon() while the summoning ability is the current source ----
// (kept as the card object: a Magic being resolved is in no zone findCard sees; only its name / symbols are read)
const SUMMONER = new Map<number, Card | null>();
function noteSummoner(g: Game, p: PID, c: Card): boolean { const s = currentSource(); SUMMONER.set(c.uid, s && s !== c ? s : null); return true; }
function summonerOf(g: Game, c: Card): Card | null { return SUMMONER.get(c.uid) || null; }

// ---- LIFE effects used by ตั๊กแตน cards: resolve one of our face-up LIFE cards now ----
function lifeScore(g: Game, p: PID, l: Card): number {
  const sp = l.def.life; if (!sp) return -1;
  if (sp.k === 'draw') return 3 + (sp.n || 1);
  if (sp.k === 'summonHand' || sp.k === 'summonHell') return canPlaceAvatar(P(g, p)) ? 4 : 0;
  if (sp.k === 'powerAv') return g.active === p && g.phase !== 'End' ? 2.5 : 0.5;
  return 2;
}
function useLifeEffect(g: Game, p: PID, src: Card): boolean {
  const up = P(g, p).life.filter((l) => l.faceUp && l.card.def.life).map((l) => l.card);
  const pick = best(up, (x) => lifeScore(g, p, x));
  if (!pick) return false;
  log(g, `${src.def.name}: P${p} uses the effect of the LIFE card ${pick.def.name} now`);
  resolveLife(g, p, pick);
  return true;
}
const throneOnField = (g: Game, p: PID) => P(g, p).mz.some((x) => x.def.name === THRONE_F) || P(g, p).avatars.some((a) => a.mods.some((m) => m.def.name === THRONE_F));

// ---- ยอดมนุษย์หัวยางลบ: "loses all abilities until the end of the opponent's next turn" (c.f.rubber = last turn) ----
function rubberPatch(t: Card) {
  const f = FX[t.def.name] || FX[t.def.print];
  if (!f || (f as any).__rubber) return; // no FX entry = no abilities to lose
  (f as any).__rubber = true;
  const prev = f.textOff;
  f.textOff = (g, s, x) => (s === x && (x.f.rubber || 0) >= g.turn ? ['ability'] : prev ? prev(g, s, x) : null);
  refreshHooks();
}
// ---- ให้ข้าวฉันถ้าคุณเป็นคนดี: granted "when this attacks, its opponent draws 1" (c.f.rice = this turn) ----
function ricePatch(t: Card) {
  const f = entryOf(t);
  if (f.__rice) return;
  f.__rice = true;
  const prev = f.onAttack;
  f.onAttack = (g: Game, c: Card, tg: Card | null) => { if (prev) prev(g, c, tg); if (c.f.rice === g.turn) { log(g, `${c.def.name} attacks: P${opp(c.ctrl)} draws 1 (ให้ข้าวฉัน)`); draw(g, opp(c.ctrl), 1); } };
}
// ---- นักท่องเรื่องราว มายา ----
const storyOk = (g: Game, p: PID, x: Card) => isA(x) && story(x) && x.def.cost === 6 && P(g, p).hand.includes(x) && !uniqueBlocked(g, p, x) && summonAllowed(g, p, x, 'effect');
function mayaSwap(g: Game, p: PID, maya: Card, s: Card) {
  if (!toExile(g, maya, { cost: true }) && P(g, p).avatars.includes(maya)) return;
  if (!P(g, p).hand.includes(s)) return;
  P(g, p).once['traveler:' + s.uid] = g.turn;
  if (summon(g, p, s, 'effect') && P(g, p).avatars.includes(s)) { s.bonus += 1; s.f.byTraveler = 1; }
}

// ===== patches =====
// ตั๊กแตนหยิน BT07-036: จุติ flips with flipLifeCard; its 2nd ability uses a face-up LIFE card's effect
patchFx('ตั๊กแตนหยิน', {
  jutsu: (g: Game, c: Card) => {
    const p = c.ctrl;
    flipLifeCard(g, p);
    const up = P(g, p).life.filter((x) => x.faceUp);
    const dn = best(up.map((x) => x.card), (x) => { const l = up.find((y) => y.card === x)!; return (l.trig ? -10 : 0) + up.indexOf(l); });
    const l = up.find((x) => x.card === dn);
    if (l) { l.faceUp = false; l.seen = false; l.trig = false; log(g, `P${p} turns ${l.card.def.name} face down (${flippedLife(P(g, p))}/5)`); }
  },
  fieldActs: (g: Game, p: PID, c: Card) => [act('ตั๊กแตนหยิน: discard 1, use a face-up LIFE card', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'yin:' + c.uid)
    && throneOnField(g2, p) && P(g2, p).hand.length > 0 && P(g2, p).life.some((l) => l.faceUp && l.card.def.life),
  (g2) => { use(g2, p, 'yin:' + c.uid); if (discardWorst(g2, p, 1)) useLifeEffect(g2, p, c); })],
});
// ตั๊กแตนหยาง BT07-037: can wear only แมลง cards (every Modification's target is checked below; attach() too)
// v14d: the rule is ตั๊กแตนหยาง's refuseMod (engine canWear / attach / Modification cast); the modTarget wrapper only stops
// the bot from choosing a wearer canWear refuses
patchFx('ตั๊กแตนหยาง', { refuseMod: (g: Game, self: Card, m: Card) => !contOff(g, self) && !symIs(m, 'แมลง') });
for (const [name, f] of Object.entries(FX)) {
  if (!f || !f.modTarget || (f as any).__yang) continue;
  const prev = f.modTarget;
  (f as any).__yang = true;
  f.modTarget = (g, p, c) => { const w = prev(g, p, c); if (w && !canWearE(g, c, w)) { log(g, `${name} can't be worn by ${w.def.name}`); return null; } return w; };
}
// บัลลังก์ตั๊กแตนศตวรรษ BT07-073: its wearer (any "ตั๊กแตน" by name or text box) gives our other ตั๊กแตน POWER +1
const throneAuraF = (g: Game, s: Card, t: Card) => (t !== s && t.ctrl === s.ctrl && P(g, s.ctrl).avatars.includes(s) && P(g, s.ctrl).avatars.includes(t)
  && grasshopper(t) && s.mods.some((m) => m.def.name === THRONE_F) ? 1 : 0);
for (const n of namesWhere((n, t) => TYPE.get(n) === 'Avatar' && (n.includes('ตั๊กแตน') || t.includes('ตั๊กแตน')), ['ตั๊กแตนหยิน', 'ตั๊กแตนหยาง', 'วาฬทมิฬ ก้า', 'ราชันย์ตั๊กแตนศตวรรษ', 'ตั๊กแตนหญิง', 'ตั๊กแตนพันธ์ุ X'])) {
  const f: any = FX[n];
  if (f && (['ตั๊กแตนหยิน', 'ตั๊กแตนหยาง', 'วาฬทมิฬ ก้า', 'ตั๊กแตนหญิง'].includes(n) || String(f.aura).includes('THRONE)'))) f.aura = throneAuraF; // replaces g5's throneAura (same rule, any ตั๊กแตน)
  else patchFx(n, { aura: throneAuraF });
}
// ไอ้ชิด BT08-002: discard costs of our ค่ายบางระจัน cards are waived: เณรคู, เมือง ช่างใหญ่, ผู้นำของเหล่าวีรชน, วิญญาณวีรชน, กำแพงด่านสุดท้าย
const payDiscard = (g: Game, p: PID, n: number, except: Card[] = []) => chid(g, p) ? (log(g, `ไอ้ชิด: the discard cost is waived`), true) : discardWorst(g, p, n, except);
patchFx('เณรคู ศิษย์เอกพระอาจารย์', {}); // ensure the entry
FX['เณรคู ศิษย์เอกพระอาจารย์'].fieldActs = (g, p, c) => [act('เณรคู: ค่ายบางระจัน Avatars ignore opposing React Magic', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'nenku') && bangCamp(g2, p)
  && (P(g2, p).hand.length >= 1 || chid(g2, p)),
(g2) => {
  use(g2, p, 'nenku');
  if (!payDiscard(g2, p, 1)) return;
  for (const a of P(g2, p).avatars) if (isBRJ(a)) a.f.nenku = g2.turn;
  log(g2, 'เณรคู: our ค่ายบางระจัน Avatars are unaffected by opposing React Magic this turn');
})];
// เณรคู's protection lives on the protected Avatars (it lasts even if เณรคู leaves): v14d shieldFrom = they ignore every
// effect of opposing React Magic (choosing, removing, POWER changes, targeted or not)
const reactMagic = (c: Card | null) => !!c && c.def.type === 'Magic' && c.def.subtype === 'React';
for (const n of namesWhere((n, t) => TYPE.get(n) === 'Avatar' && t.includes(CAMP_F), BANG)) {
  if (!FX[n]) continue;
  patchFx(n, {
    shieldFrom: (g: Game, self: Card, t: Card, src: Card) => t === self && self.f.nenku === g.turn && reactMagic(src) && src.owner !== self.ctrl,
  });
}
FX['เมือง ช่างใหญ่'] && (FX['เมือง ช่างใหญ่'].jutsu = (g, c) => {
  const p = c.ctrl, pl = P(g, p);
  const k = pl.deck.find((x) => x.def.name === CAMP_F);
  if (!k || pl.mz.filter((x) => x.def.type === 'Construct').length >= 3 || bangCamp(g, p) || (!chid(g, p) && pl.hand.length < 2)) return;
  if (!payDiscard(g, p, 2)) return;
  if (summon(g, p, k, 'effect')) { k.f.built = 1; const bf: any = FX[k.def.name]; if (bf && bf.onBuild) bf.onBuild(g, p, k); }
  shuffle(g, pl.deck);
});
if (FX['ผู้นำของเหล่าวีรชน']) {
  FX['ผู้นำของเหล่าวีรชน'].canCast = (g, p, c) => (chid(g, p) || P(g, p).hand.filter((x) => x !== c).length >= 2) && P(g, p).deck.some(isBRJ);
  FX['ผู้นำของเหล่าวีรชน'].resolve = (g, p, c) => { if (payDiscard(g, p, 2, [c])) search(g, p, isBRJ, 'deck'); };
}
if (FX['วิญญาณวีรชน']) {
  FX['วิญญาณวีรชน'].canCast = (g, p, c) => (chid(g, p) || P(g, p).hand.some((x) => x !== c)) && hellAvatars(g, p, isBRJ).length > 0 && canPlaceAvatar(P(g, p));
  FX['วิญญาณวีรชน'].resolve = (g, p, c) => {
    if (!payDiscard(g, p, 1, [c])) return;
    const x = fromZoneSummon(g, p, P(g, p).hell, isBRJ, 'jutsu');
    if (x && P(g, p).avatars.includes(x)) x.f.endHell = g.turn + 1;
  };
}
if (FX['กำแพงด่านสุดท้าย']) {
  FX['กำแพงด่านสุดท้าย'].startMain = (g, c) => {
    const p = c.ctrl, pl = P(g, p);
    const seen = c.f.lifeSeen;
    c.f.lifeSeen = flippedLife(pl);
    if (seen === undefined || flippedLife(pl) <= seen || pl.avatars.length > 0 || (pl.hand.length < 1 && !chid(g, p)) || !once(g, p, 'wall')) return;
    use(g, p, 'wall');
    if (!payDiscard(g, p, 1)) return;
    const n = 1 + 2 * pl.mz.filter((x) => x.def.name === 'วัดคู่บ้านคู่เมือง').length;
    const top = pl.deck.splice(0, n);
    for (const x of top) {
      if (isBRJ(x) && x.def.cost <= 4 && canPlaceAvatar(pl)) { pl.hell.push(x); if (summon(g, p, x, 'effect')) continue; detach(g, x); }
      if (!findCard(g, x.uid)) pl.hand.push(x);
    }
  };
}
// น้าเอี๊ยด BT08-004: our Construct ค่ายบางระจัน POWER +2
patchFx('น้าเอี๊ยด นักบรรเลง', {
  aura: (g: Game, s: Card, t: Card) => (t.def.type === 'Construct' && t.def.name === CAMP_F && P(g, s.ctrl).mz.includes(t) && P(g, s.ctrl).avatars.includes(s) ? 2 : 0),
});
// เนียจัง BT08-029: the taken Avatar is renamed "โอตะ" (shown in the detail box); renamed ones count as โอตะ later
if (FX['เนียจัง ไอดอลอินฟลูเอนเซอร์']) FX['เนียจัง ไอดอลอินฟลูเอนเซอร์'].fieldActs = (g, p, c) => {
  const otas = (g2: Game) => P(g2, p).avatars.filter((a) => nameHas(a, 'ไอดอล')).flatMap((a) => a.mods).filter((m) => nameHas(m, 'โอตะ'));
  const worth = (g2: Game) => otas(g2).reduce((s, m) => s + (m.def.name === 'โอตะท๊อปโดเนท' ? 2 : 1), 0);
  const key = (g2: Game) => (once(g2, p, 'nia1') ? 'nia1' : P(g2, p).avatars.some((a) => nameHas(a, 'ทัตดนัยซัง')) && once(g2, p, 'nia2') ? 'nia2' : '');
  return [act('เนียจัง: pop 2 โอตะ, take an opponent Avatar as โอตะ', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && !!key(g2) && worth(g2) >= 2 && P(g2, opp(p)).avatars.length > 0,
    (g2) => {
      use(g2, p, key(g2));
      const all = otas(g2);
      const t1 = worst(all, (m) => (m.def.name === 'โอตะท๊อปโดเนท' ? -100 : 0) + keepValue(g2, m));
      const pay = !t1 ? [] : t1.def.name === 'โอตะท๊อปโดเนท' ? [t1] : [t1, ...worstN(all.filter((m) => m !== t1), 1, (m) => keepValue(g2, m))];
      if (!pay.length || (pay.length < 2 && pay[0].def.name !== 'โอตะท๊อปโดเนท')) return;
      for (const m of pay) toHell(g2, m, { cost: true });
      const t = best(P(g2, opp(p)).avatars, (a) => value(g2, a));
      if (!t || !P(g2, p).avatars.includes(c)) return;
      const tf = fx0(t);
      if (tf && tf.preventLeave && !silenced(g2, t) && tf.preventLeave(g2, t)) return;
      for (const m of t.mods.splice(0)) { m.wearer = -1; P(g2, m.owner).hell.push(m); }
      attach(g2, t, c);
      if (!c.mods.includes(t)) return;
      t.bonus = 0;
      setName(g2, t, 'โอตะ');
      log(g2, `${t.def.name} becomes "โอตะ" worn by เนียจัง`);
    })];
};
function fx0(c: Card): Fx | undefined { return FX[c.def.name] || FX[c.def.print]; }
// ตัวอะไรสักอย่าง BT09-018: คำสั่งเสีย: for the rest of the game we can summon only blue {เอเลี่ยน} Avatars
// (RULES is registered lazily: engine.ts is still loading when this file runs)
const alienRule = () => { RULES['ตัวอะไรสักอย่าง'] ||= { label: 'only blue {เอเลี่ยน} Avatars can be summoned (ตัวอะไรสักอย่าง)', summon: (g, r, c) => symIs(c, 'เอเลี่ยน') && colorIs(c, 'ฟ้า') }; };
patchFx('ตัวอะไรสักอย่างที่เป็นมิตรและพูดมาก', { // cards19: BT09-018's real name (was 'ตัวอะไรสักอย่าง')
  deathCry: (g: Game, c: Card, owner: PID) => { alienRule(); if (!(g.rules || []).some((r) => r.key === 'ตัวอะไรสักอย่าง' && r.p === owner)) addRule(g, { p: owner, key: 'ตัวอะไรสักอย่าง', until: RULE_GAME }); },
});
// cards19: ...and "Cost บนมือ ของ Avatar "ตัวอะไรซักอย่าง" จะลดลง 2, not below 2" for the rest of the game (after its คำสั่งเสีย,
// P.onceGame.alienLock). A costMod on every card named ตัวอะไรสักอย่าง/ซัก (BT08-046, BT09-018, BT09-046, BT10-016, BT11-023, reprints),
// read for the card itself in its owner's hand, so payment, the bot and the hand Cost badge all see it.
for (const n of namesWhere((n) => /ตัวอะไร(สัก|ซัก)อย่าง/.test(n), ['ตัวอะไรสักอย่างที่ใหญ่และน่ารัก', 'ตัวอะไรสักอย่างที่เป็นมิตรและพูดมาก',
  'ตัวอะไรสักอย่างที่คล้ายกระต่ายและกินเก่ง', 'ตัวอะไรสักอย่างที่คล้ายกระรอกและนิสัยไม่ดี', 'ตัวอะไรสักอย่างที่สุดเท่และเป็นนักดาบ'])) {
  patchFx(n, { costMod: (g: Game, self: Card, t: Card) => (t === self && P(g, self.owner).onceGame['alienLock'] && P(g, self.owner).hand.includes(self)
    && isA(self) ? -Math.min(2, Math.max(0, self.def.cost - 2)) : 0) });
}
// วอเตอร์แมน SD05-006: "#นับเป็น Symbol ปลา" for every check
patchFx('วอเตอร์แมน', { symbolsFor: (g: Game, self: Card, t: Card) => (t === self ? ['ปลา'] : null) });
// ทองเหม็น SD06-003: "can't attack LIFE without ค่ายบางระจัน" is checked at the start of our Battle Phase
if (FX['ทองเหม็น ขวานคลั่ง']) {
  const f: any = FX['ทองเหม็น ขวานคลั่ง'];
  delete f.startMain; delete f.onSummon;
  f.startBattle = (g: Game, c: Card) => { if (g.active === c.ctrl && P(g, c.ctrl).avatars.includes(c)) c.f.thongNL = bangCamp(g, c.ctrl) ? 0 : g.turn; };
  f.noLifeAttack = (g: Game, self: Card, a: Card) => a === self && self.f.thongNL === g.turn;
}
// อาจารย์ธรรมโชติ SD06-007: our ค่ายบางระจัน would be destroyed by an Avatar's ability or a Magic: put this (hand / Avatar Zone)
// under the Deck instead (once per turn, optional)
patchFx('อาจารย์ธรรมโชติ', {
  leaveGuard: (g: Game, self: Card, t: Card, info: any) => {
    if (t.def.name !== CAMP_F || t.def.type !== 'Construct' || info.how !== 'destroy' || info.battle || info.cost || !info.src) return null;
    if (!(isA(info.src) || info.src.def.type === 'Magic')) return null;
    const pl = P(g, t.ctrl), inHand = pl.hand.includes(self);
    if (!inHand && !pl.avatars.includes(self)) return null;
    if (!once(g, t.ctrl, 'thammachot')) return null;
    return { label: `put อาจารย์ธรรมโชติ under the Deck to keep ${CAMP_F}`, want: true, run: () => {
      use(g, t.ctrl, 'thammachot');
      if (inHand) { detach(g, self); P(g, self.owner).deck.push(self); return true; }
      return toDeck(g, self, 'bottom', { cost: true });
    } };
  },
});
// ค่ายบางระจัน SD06-018: when it is destroyed, send every Avatar on our Avatar Zone to Hell
patchFx(CAMP_F, {
  afterLeave: (g: Game, self: Card, info: any) => {
    if (info.how !== 'destroy') return;
    log(g, `${CAMP_F} was destroyed: P${info.ctrl}'s Avatars go to Hell`);
    for (const a of [...P(g, info.ctrl).avatars]) toHell(g, a);
  },
});
// ดาบแห่งแสงอรุณ & นัทคาลิเบอร์ BT11-064: worn by เซอร์นัท: our other อัศวินตลิ่งชัน POWER +1
for (const n of ['เซอร์นัท ผู้นำแห่งอัศวินตลิ่งชัน', 'เซอร์นัท ดาบแห่งแสงอรุณ']) {
  patchFx(n, {
    aura: (g: Game, s: Card, t: Card) => (t !== s && t.ctrl === s.ctrl && P(g, s.ctrl).avatars.includes(s) && P(g, s.ctrl).avatars.includes(t) && nameHas(t, 'อัศวินตลิ่งชัน')
      ? s.mods.filter((m) => m.def.name === 'ดาบแห่งแสงอรุณ & นัทคาลิเบอร์').length : 0),
  });
}

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): the "cost :" part is paid before the React window
costFirst('ผู้นำของเหล่าวีรชน', (g, p, c) => payDiscard(g, p, 2, [c]), (g, p) => { search(g, p, isBRJ, 'deck'); });
costFirst('วิญญาณวีรชน', (g, p, c) => payDiscard(g, p, 1, [c]), (g, p) => {
  const x = fromZoneSummon(g, p, P(g, p).hell, isBRJ, 'jutsu');
  if (x && P(g, p).avatars.includes(x)) x.f.endHell = g.turn + 1;
});
costFirst('ศิลาหยินหยาง', (g, p) => { if (!critical(P(g, p))) flipOwn(g, p); return true; }, (g, p, c, o) => {
  fromZoneSummon(g, p, P(g, p).deck, (x) => x.def.name.includes(o === 0 ? 'ตั๊กแตนหยิน' : 'ตั๊กแตนหยาง'));
  shuffle(g, P(g, p).deck);
});
costFirst('ชีวิตที่พอดี', (g, p) => discardWorst(g, p, 2), (g, p) => {
  const t = best(P(g, p).avatars.filter((a) => PODEE.includes(a.def.name) && !!FX[a.def.name]?.jutsu), (a) => value(g, a));
  if (t) FX[t.def.name].jutsu!(g, t);
});
costFirst('ผู้มาเยือน', (g, p, c) => discardWorst(g, p, 1, [c], (x) => symIs(x, 'เอเลี่ยน')), (g, p, c) => {
  const t = fromZoneSummon(g, p, P(g, p).deck, (x) => symIs(x, 'เอเลี่ยน') && x.def.cost <= 4);
  shuffle(g, P(g, p).deck);
  if (t && P(g, p).avatars.includes(t)) attach(g, c, t);
});
costFirst('นารายณ์ 10 ปาง', (g, p) => discardWorst(g, p, 1), (g, p) => {
  peek(g, p, 3, (top) => { takeHand(g, p, top, (x) => isA(x) && named(x, 'นารายณ์') && symIs(x, 'เทพ') && x.def.cost <= 6); }, 'bottom');
});
costFirst('แยกกันไปแตก', (g, p) => {
  const seen = new Set<string>(), pick: Card[] = [];
  for (const x of hellAvatars(g, p, (y) => named(y, 'สมาชม'))) { if (seen.size >= 4 || seen.has(x.def.name)) continue; seen.add(x.def.name); pick.push(x); }
  if (seen.size < 4) return false;
  for (const x of pick) toExile(g, x);
  return true;
}, (g, p, c, o) => {
  if (o === 0) for (const x of [...P(g, opp(p)).hand]) discard(g, opp(p), x);
  else for (const a of [...P(g, opp(p)).avatars]) destroy(g, a, p, true);
});
